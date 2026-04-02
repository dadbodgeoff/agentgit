import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";

import { configError, inputError, ioError } from "./cli-contract.js";

export interface SecretCommandOptions {
  secretId: string;
  displayName?: string;
  bearerToken: string;
  expiresAt?: string;
}

interface SecretSourceFlags {
  definitionArg?: string;
  secretId?: string;
  displayName?: string;
  expiresAt?: string;
  bearerTokenFile?: string;
  bearerTokenStdin?: boolean;
  promptBearerToken?: boolean;
}

export async function parseSecretCommandOptions(
  args: string[],
  workspaceRoot: string,
  streams: {
    stdin?: NodeJS.ReadStream;
    stderr?: NodeJS.WriteStream;
  } = {},
): Promise<SecretCommandOptions> {
  const flags = parseSecretFlags(args);

  if (flags.definitionArg) {
    if (
      flags.secretId ||
      flags.displayName ||
      flags.bearerTokenFile ||
      flags.bearerTokenStdin ||
      flags.promptBearerToken
    ) {
      throw inputError("upsert-mcp-secret cannot combine <definition-json-or-path> with explicit secret input flags.");
    }

    return parseLegacySecretDefinition(flags.definitionArg, workspaceRoot);
  }

  if (!flags.secretId) {
    throw inputError(
      "upsert-mcp-secret requires either <definition-json-or-path> or --secret-id with a bearer token input source.",
    );
  }

  const sourceCount =
    Number(Boolean(flags.bearerTokenFile)) +
    Number(Boolean(flags.bearerTokenStdin)) +
    Number(Boolean(flags.promptBearerToken));
  if (sourceCount !== 1) {
    throw inputError(
      "upsert-mcp-secret requires exactly one of --bearer-token-file, --bearer-token-stdin, or --prompt-bearer-token.",
    );
  }

  const bearerToken = flags.bearerTokenFile
    ? readSecretFile(flags.bearerTokenFile, workspaceRoot)
    : flags.bearerTokenStdin
      ? await readSecretFromStdin(streams.stdin ?? process.stdin)
      : await promptForSecret(streams.stdin ?? process.stdin, streams.stderr ?? process.stderr, "Bearer token: ");

  return {
    secretId: flags.secretId,
    ...(flags.displayName ? { displayName: flags.displayName } : {}),
    ...(flags.expiresAt ? { expiresAt: flags.expiresAt } : {}),
    bearerToken,
  };
}

export function secretUsage(): string {
  return [
    "Usage: agentgit-authority [--json] upsert-mcp-secret <definition-json-or-path>",
    "   or: agentgit-authority [--json] upsert-mcp-secret --secret-id <secret-id> [--display-name <name>] [--expires-at <timestamp>] (--bearer-token-file <path> | --bearer-token-stdin | --prompt-bearer-token)",
  ].join("\n");
}

function parseLegacySecretDefinition(definitionArg: string, workspaceRoot: string): SecretCommandOptions {
  const candidatePath = path.isAbsolute(definitionArg) ? definitionArg : path.resolve(workspaceRoot, definitionArg);
  const source = fs.existsSync(candidatePath) ? fs.readFileSync(candidatePath, "utf8") : definitionArg;
  const parsed = JSON.parse(source) as Record<string, unknown>;

  if (typeof parsed.secret_id !== "string" || parsed.secret_id.trim().length === 0) {
    throw inputError("Secret definition must contain a non-empty secret_id.");
  }
  if (typeof parsed.bearer_token !== "string" || parsed.bearer_token.trim().length === 0) {
    throw inputError("Secret definition must contain a non-empty bearer_token.");
  }

  return {
    secretId: parsed.secret_id.trim(),
    ...(typeof parsed.display_name === "string" && parsed.display_name.trim().length > 0
      ? { displayName: parsed.display_name.trim() }
      : {}),
    ...(typeof parsed.expires_at === "string" && parsed.expires_at.trim().length > 0
      ? { expiresAt: parsed.expires_at.trim() }
      : {}),
    bearerToken: parsed.bearer_token.trim(),
  };
}

function parseSecretFlags(args: string[]): SecretSourceFlags {
  const values: SecretSourceFlags = {};
  const rest = [...args];

  if (rest.length > 0 && !rest[0]!.startsWith("--")) {
    values.definitionArg = rest.shift();
  }

  while (rest.length > 0) {
    const current = rest.shift()!;
    switch (current) {
      case "--secret-id":
        values.secretId = shiftValue(rest, "--secret-id");
        break;
      case "--display-name":
        values.displayName = shiftValue(rest, "--display-name");
        break;
      case "--expires-at":
        values.expiresAt = shiftValue(rest, "--expires-at");
        break;
      case "--bearer-token-file":
        values.bearerTokenFile = shiftValue(rest, "--bearer-token-file");
        break;
      case "--bearer-token-stdin":
        values.bearerTokenStdin = true;
        break;
      case "--prompt-bearer-token":
        values.promptBearerToken = true;
        break;
      default:
        throw inputError(`Unknown upsert-mcp-secret flag: ${current}`, {
          flag: current,
        });
    }
  }

  return values;
}

function shiftValue(values: string[], flag: string): string {
  const value = values.shift();
  if (!value || value.startsWith("--")) {
    throw inputError(`${flag} requires a value.`, {
      flag,
    });
  }
  return value;
}

function readSecretFile(secretFilePath: string, workspaceRoot: string): string {
  const resolvedPath = path.isAbsolute(secretFilePath) ? secretFilePath : path.resolve(workspaceRoot, secretFilePath);

  if (!fs.existsSync(resolvedPath)) {
    throw ioError(`Bearer token file does not exist: ${resolvedPath}`, {
      path: resolvedPath,
    });
  }

  const token = fs.readFileSync(resolvedPath, "utf8").trim();
  if (token.length === 0) {
    throw inputError(`Bearer token file is empty: ${resolvedPath}`, {
      path: resolvedPath,
    });
  }

  return token;
}

async function readSecretFromStdin(stdin: NodeJS.ReadStream): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }

  const token = Buffer.concat(chunks).toString("utf8").trim();
  if (token.length === 0) {
    throw inputError("No bearer token was received on stdin.");
  }

  return token;
}

async function promptForSecret(stdin: NodeJS.ReadStream, stderr: NodeJS.WriteStream, prompt: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw configError(
      "Interactive secret prompt requires a TTY. Use --bearer-token-stdin or --bearer-token-file instead.",
    );
  }

  stderr.write(prompt);
  const secret = await readHiddenLine(stdin, stderr);
  stderr.write("\n");

  const trimmed = secret.trim();
  if (trimmed.length === 0) {
    throw inputError("Bearer token prompt was empty.");
  }

  return trimmed;
}

async function readHiddenLine(stdin: NodeJS.ReadStream, stderr: Writable): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: string[] = [];
    const onData = (chunk: Buffer | string) => {
      const value = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      for (const character of value) {
        if (character === "\u0003") {
          cleanup();
          reject(inputError("Secret entry cancelled by user."));
          return;
        }

        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(chunks.join(""));
          return;
        }

        if (character === "\u007f") {
          chunks.pop();
          continue;
        }

        chunks.push(character);
      }
    };

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    stderr.write("");
  });
}
