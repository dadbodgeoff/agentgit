import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { AgentGitError } from "@agentgit/schemas";

export interface CommandRunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
}

export interface CommandRunResult {
  ok: boolean;
  exit_code: number;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface CommandRunner {
  run(command: string, args?: string[], options?: CommandRunOptions): CommandRunResult;
}

export class DefaultCommandRunner implements CommandRunner {
  run(command: string, args: string[] = [], options: CommandRunOptions = {}): CommandRunResult {
    const result = spawnSync(command, args, {
      cwd: options.cwd,
      env: options.env,
      input: options.input,
      encoding: "utf8",
    });

    if (result.error) {
      return {
        ok: false,
        exit_code: result.status ?? 127,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? result.error.message,
        error: result.error,
      };
    }

    return {
      ok: result.status === 0,
      exit_code: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export function resolveWorkspaceRoot(cwd: string, runner: CommandRunner = new DefaultCommandRunner()): string {
  const result = runner.run("git", ["rev-parse", "--show-toplevel"], { cwd });
  if (result.ok) {
    const root = result.stdout.trim();
    if (root.length > 0) {
      return path.resolve(root);
    }
  }

  return path.resolve(cwd);
}

export function requireNonEmptyCommand(command: string | undefined, detail: string): string {
  if (!command || command.trim().length === 0) {
    throw new AgentGitError(detail, "BAD_REQUEST", {
      recommended_command: "agentgit setup --command '<your agent command>'",
    });
  }

  return command.trim();
}

export function valuesEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

export function firstDefined<T>(...values: Array<T | undefined>): T | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}
