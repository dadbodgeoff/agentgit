import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const GOVERNED_SHIM_COMMANDS = [
  "sh",
  "bash",
  "zsh",
  "git",
  "node",
  "python",
  "python3",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "rm",
  "mv",
  "cp",
  "mkdir",
  "touch",
  "cat",
  "ls",
  "find",
  "grep",
  "rg",
  "sed",
] as const;

export const OPENCLAW_PLUGIN_ID = "agentgit";
export const OPENCLAW_PLUGIN_TOOL_NAMES = [
  "agentgit_exec_command",
  "agentgit_write_file",
  "agentgit_delete_file",
] as const;
export const OPENCLAW_DENIED_CORE_TOOLS = ["exec", "process", "write", "edit", "apply_patch"] as const;

export interface GovernedLaunchAssetMetadata {
  generated_asset_root: string;
  helper_script_path: string;
  helper_script_sha256: string;
  shim_bin_dir: string;
  shim_commands: string[];
  generated_assets: string[];
  openclaw_plugin_root?: string;
  openclaw_skill_path?: string;
  openclaw_plugin_id?: string;
  openclaw_tool_names?: string[];
  openclaw_denied_core_tools?: string[];
}

function governedAssetRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".agentgit", "runtime-integration");
}

function governedHelperPath(workspaceRoot: string): string {
  return path.join(governedAssetRoot(workspaceRoot), "governed-runner.mjs");
}

function governedShimBinDir(workspaceRoot: string): string {
  return path.join(governedAssetRoot(workspaceRoot), "bin");
}

function governedOpenClawPluginRoot(workspaceRoot: string): string {
  return path.join(governedAssetRoot(workspaceRoot), "openclaw-plugin");
}

function governedOpenClawSkillPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, "skills", "agentgit_governed_tools", "SKILL.md");
}

function governedShimPath(workspaceRoot: string, command: string): string {
  return path.join(governedShimBinDir(workspaceRoot), command);
}

function governedOpenClawPluginAssets(workspaceRoot: string): string[] {
  const pluginRoot = governedOpenClawPluginRoot(workspaceRoot);
  return [
    path.join(pluginRoot, "package.json"),
    path.join(pluginRoot, "openclaw.plugin.json"),
    path.join(pluginRoot, "index.mjs"),
    governedOpenClawSkillPath(workspaceRoot),
  ];
}

function governedGenericAssets(workspaceRoot: string): string[] {
  return [
    governedHelperPath(workspaceRoot),
    ...GOVERNED_SHIM_COMMANDS.map((command) => governedShimPath(workspaceRoot, command)),
  ];
}

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function buildGovernedRunnerSource(): string {
  return `#!${process.execPath}
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";

const MAX_RESPONSE_BYTES = 1_000_000;
const SOCKET_TIMEOUT_MS = 30_000;

async function readStdin() {
  let buffer = "";
  for await (const chunk of process.stdin) {
    buffer += chunk;
  }
  return buffer.trim();
}

function readFileIfExists(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

function makeRequest(method, payload, sessionId) {
  return {
    api_version: "authority.v1",
    request_id: "req_" + randomUUID().replaceAll("-", ""),
    session_id: sessionId,
    method,
    payload,
  };
}

async function sendRequest(socketPath, request) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const authToken =
      (typeof process.env.AGENTGIT_SOCKET_AUTH_TOKEN === "string" ? process.env.AGENTGIT_SOCKET_AUTH_TOKEN.trim() : "") ||
      readFileIfExists(socketPath + ".token");
    const requestBody = JSON.stringify(request) + "\\n";

    function settle(callback) {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    }

    socket.setEncoding("utf8");
    socket.setTimeout(SOCKET_TIMEOUT_MS);
    socket.once("connect", () => {
      socket.write((authToken ? authToken + "\\n" : "") + requestBody);
    });
    socket.once("timeout", () => {
      settle(() => {
        socket.destroy();
        reject(new Error("AgentGit helper timed out while waiting for a daemon response."));
      });
    });
    socket.on("data", (chunk) => {
      if (settled) {
        return;
      }
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
        settle(() => {
          socket.destroy();
          reject(new Error("AgentGit helper rejected an oversized daemon response."));
        });
        return;
      }
      const newlineIndex = buffer.indexOf("\\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = buffer.slice(0, newlineIndex).trim();
      settle(() => {
        socket.end();
        try {
          resolve(JSON.parse(line));
        } catch (error) {
          reject(new Error("AgentGit helper received malformed daemon JSON: " + (error instanceof Error ? error.message : String(error))));
        }
      });
    });
    socket.once("error", (error) => {
      settle(() => {
        reject(error);
      });
    });
    socket.once("close", () => {
      if (settled) {
        return;
      }
      settle(() => {
        reject(new Error("AgentGit helper socket closed before a response was received."));
      });
    });
  });
}

function buildAttempt(request) {
  const base = {
    run_id: request.run_id,
    environment_context: {
      workspace_roots: [request.workspace_root],
      cwd: request.cwd || request.workspace_root,
      credential_mode: "none",
    },
    framework_context: {
      agent_name: "agentgit-runtime-integration",
      agent_framework: request.framework || "runtime_wrapper",
    },
    received_at: new Date().toISOString(),
  };

  if (request.operation === "shell") {
    const argv = Array.isArray(request.argv) ? request.argv.filter((value) => typeof value === "string" && value.length > 0) : [];
    return {
      ...base,
      tool_registration: {
        tool_name: "exec_command",
        tool_kind: "shell",
      },
      raw_call: {
        command: argv.join(" "),
        argv,
      },
    };
  }

  if (request.operation === "write_file") {
    return {
      ...base,
      tool_registration: {
        tool_name: "write_file",
        tool_kind: "filesystem",
      },
      raw_call: {
        operation: "write",
        path: request.path,
        content: request.content,
      },
    };
  }

  if (request.operation === "delete_file") {
    return {
      ...base,
      tool_registration: {
        tool_name: "delete_file",
        tool_kind: "filesystem",
      },
      raw_call: {
        operation: "delete",
        path: request.path,
      },
    };
  }

  throw new Error("Unsupported AgentGit helper operation: " + String(request.operation));
}

function okResult(result, extras = {}) {
  process.stdout.write(JSON.stringify({ ok: true, ...result, ...extras }));
}

function failResult(message, extras = {}) {
  process.stdout.write(JSON.stringify({ ok: false, message, ...extras }));
}

async function main() {
  const input = await readStdin();
  if (input.length === 0) {
    failResult("AgentGit helper expected a JSON request on stdin.");
    process.exitCode = 1;
    return;
  }

  let request;
  try {
    request = JSON.parse(input);
  } catch (error) {
    failResult("AgentGit helper received invalid JSON.", {
      cause: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
    return;
  }

  const socketPath = request.socket_path || process.env.AGENTGIT_SOCKET_PATH;
  const workspaceRoot = request.workspace_root || process.env.AGENTGIT_ROOT;
  const runId = request.run_id || process.env.AGENTGIT_RUN_ID;
  const providedSessionId = request.session_id || process.env.AGENTGIT_SESSION_ID || null;
  if (!socketPath || !workspaceRoot || !runId) {
    failResult("AgentGit runtime context is missing. Launch the runtime through agentgit run.", {
      socket_path: Boolean(socketPath),
      workspace_root: Boolean(workspaceRoot),
      run_id: Boolean(runId),
    });
    process.exitCode = 1;
    return;
  }

  try {
    let sessionId = typeof providedSessionId === "string" && providedSessionId.trim().length > 0 ? providedSessionId.trim() : null;
    if (!sessionId) {
      const hello = await sendRequest(socketPath, makeRequest("hello", {
        client_type: "cli",
        client_version: "0.1.0",
        requested_api_version: "authority.v1",
        workspace_roots: [workspaceRoot],
      }));
      if (!hello.ok || !hello.result || !hello.result.session_id) {
        failResult(hello.error?.message || "AgentGit helper could not open a daemon session.", {
          code: hello.error?.code || "HELLO_FAILED",
        });
        process.exitCode = 1;
        return;
      }
      sessionId = hello.result.session_id;
    }

    const response = await sendRequest(
      socketPath,
      makeRequest(
        "submit_action_attempt",
        {
          attempt: buildAttempt({
            ...request,
            workspace_root: workspaceRoot,
            run_id: runId,
          }),
        },
        sessionId,
      ),
    );

    if (!response.ok || !response.result) {
      failResult(response.error?.message || "AgentGit authority rejected the action attempt.", {
        code: response.error?.code || "SUBMIT_FAILED",
        details: response.error?.details || null,
        exit_code: typeof response.error?.details?.exit_code === "number" ? response.error.details.exit_code : 1,
        stdout: typeof response.error?.details?.stdout === "string" ? response.error.details.stdout : "",
        stderr: typeof response.error?.details?.stderr === "string" ? response.error.details.stderr : "",
      });
      process.exitCode = typeof response.error?.details?.exit_code === "number" ? response.error.details.exit_code : 1;
      return;
    }

    const output = response.result.execution_result?.output || {};
    if (response.result.execution_result) {
      okResult({
        action_id: response.result.action?.action_id || null,
        decision: response.result.policy_outcome?.decision || null,
        exit_code: typeof output.exit_code === "number" ? output.exit_code : 0,
        signal: typeof output.signal === "string" ? output.signal : null,
        stdout: typeof output.stdout === "string" ? output.stdout : "",
        stderr: typeof output.stderr === "string" ? output.stderr : "",
        snapshot_id: response.result.snapshot_record?.snapshot_id || null,
      });
      return;
    }

    if (response.result.approval_request) {
      failResult("AgentGit paused this action for approval: " + response.result.approval_request.action_summary, {
        action_id: response.result.action?.action_id || null,
        decision: response.result.policy_outcome?.decision || null,
        approval_requested: true,
        approval_id: response.result.approval_request.approval_id,
      });
      process.exitCode = 2;
      return;
    }

    if (response.result.policy_outcome?.decision === "deny") {
      failResult("AgentGit denied this action.", {
        action_id: response.result.action?.action_id || null,
        decision: "deny",
      });
      process.exitCode = 1;
      return;
    }

    failResult("AgentGit did not return an execution result for this action.", {
      action_id: response.result.action?.action_id || null,
      decision: response.result.policy_outcome?.decision || null,
    });
    process.exitCode = 1;
  } catch (error) {
    failResult(error instanceof Error ? error.message : String(error), {
      code: "HELPER_RUNTIME_ERROR",
    });
    process.exitCode = 1;
  }
}

await main();
`;
}

function buildGovernedShimSource(command: string, helperHash: string): string {
  return `#!${process.execPath}
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.join(dirname, "..", "governed-runner.mjs");
const expectedHelperSha256 = ${JSON.stringify(helperHash)};

function verifyHelperIntegrity() {
  const actual = createHash("sha256").update(fs.readFileSync(helperPath, "utf8"), "utf8").digest("hex");
  if (actual !== expectedHelperSha256) {
    throw new Error("AgentGit governed helper integrity check failed.");
  }
}

const payload = {
  operation: "shell",
  argv: [${JSON.stringify(command)}, ...process.argv.slice(2)],
};
let result;
try {
  verifyHelperIntegrity();
  result = spawnSync(process.execPath, [helperPath], {
    env: process.env,
    encoding: "utf8",
    input: JSON.stringify(payload),
  });
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\\n");
  process.exit(1);
}

if (typeof result.stderr === "string" && result.stderr.length > 0) {
  process.stderr.write(result.stderr);
}

let parsed = null;
if (typeof result.stdout === "string" && result.stdout.trim().length > 0) {
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    process.stderr.write(result.stdout);
    process.exit(result.status ?? 1);
  }
}

if (!parsed || !parsed.ok) {
  if (typeof parsed?.stdout === "string" && parsed.stdout.length > 0) {
    process.stdout.write(parsed.stdout);
  }
  if (typeof parsed?.stderr === "string" && parsed.stderr.length > 0) {
    process.stderr.write(parsed.stderr);
  }
  if (parsed?.message) {
    process.stderr.write(String(parsed.message) + "\\n");
  }
  process.exit(typeof parsed?.exit_code === "number" ? parsed.exit_code : (result.status ?? 1));
}

if (typeof parsed.stdout === "string" && parsed.stdout.length > 0) {
  process.stdout.write(parsed.stdout);
}
if (typeof parsed.stderr === "string" && parsed.stderr.length > 0) {
  process.stderr.write(parsed.stderr);
}
process.exit(typeof parsed.exit_code === "number" ? parsed.exit_code : 0);
`;
}

function buildOpenClawPluginPackageJson(): string {
  return JSON.stringify(
    {
      name: "@agentgit/openclaw-agentgit-plugin",
      version: "0.1.0",
      type: "module",
      openclaw: {
        extensions: ["./index.mjs"],
      },
    },
    null,
    2,
  );
}

function buildOpenClawManifest(): string {
  return JSON.stringify(
    {
      name: "@agentgit/openclaw-agentgit-plugin",
      version: "0.1.0",
      type: "module",
      openclaw: {
        extensions: ["./index.mjs"],
        compat: {
          pluginApi: ">=2026.3.24-beta.2",
          minGatewayVersion: "2026.3.24-beta.2",
        },
        build: {
          openclawVersion: "2026.3.24-beta.2",
          pluginSdkVersion: "2026.3.24-beta.2",
        },
      },
    },
    null,
    2,
  );
}

function buildOpenClawPluginSource(helperHash: string): string {
  return `import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.join(dirname, "..", "governed-runner.mjs");
const expectedHelperSha256 = ${JSON.stringify(helperHash)};

function verifyHelperIntegrity() {
  const actual = createHash("sha256").update(fs.readFileSync(helperPath, "utf8"), "utf8").digest("hex");
  if (actual !== expectedHelperSha256) {
    throw new Error("AgentGit governed helper integrity check failed.");
  }
}

function runHelper(payload) {
  verifyHelperIntegrity();
  const result = spawnSync(process.execPath, [helperPath], {
    env: process.env,
    encoding: "utf8",
    input: JSON.stringify(payload),
  });

  if (result.error) {
    throw result.error;
  }

  if (!result.stdout || result.stdout.trim().length === 0) {
    throw new Error(result.stderr || "AgentGit helper returned no output.");
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error("AgentGit helper returned invalid JSON: " + (error instanceof Error ? error.message : String(error)));
  }

  if (!parsed.ok) {
    throw new Error(parsed.message || "AgentGit blocked this action.");
  }

  return parsed;
}

function text(value) {
  return { content: [{ type: "text", text: value }] };
}

export default definePluginEntry({
  id: "${OPENCLAW_PLUGIN_ID}",
  name: "AgentGit Governed Tools",
  description: "Routes OpenClaw mutating workspace actions through the local AgentGit authority daemon.",
  register(api) {
    api.registerTool({
      name: "agentgit_exec_command",
      description: "Run a shell command through AgentGit governance. Pass argv as an executable plus argument array, for example [\\"git\\",\\"status\\",\\"--short\\"].",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          argv: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
          },
        },
        required: ["argv"],
      },
      async execute(_id, params) {
        const result = runHelper({
          operation: "shell",
          argv: params.argv,
        });
        const stdout = typeof result.stdout === "string" && result.stdout.length > 0 ? "\\n\\n" + result.stdout : "";
        return text("AgentGit executed the command through governance." + stdout);
      },
    });

    api.registerTool({
      name: "agentgit_write_file",
      description: "Write a full file through AgentGit governance. Use this for deliberate file creation or rewrite operations.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", minLength: 1 },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
      async execute(_id, params) {
        runHelper({
          operation: "write_file",
          path: params.path,
          content: params.content,
        });
        return text("AgentGit wrote " + params.path + " through governance.");
      },
    });

    api.registerTool({
      name: "agentgit_delete_file",
      description: "Delete a file through AgentGit governance.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", minLength: 1 },
        },
        required: ["path"],
      },
      async execute(_id, params) {
        runHelper({
          operation: "delete_file",
          path: params.path,
        });
        return text("AgentGit deleted " + params.path + " through governance.");
      },
    });
  },
});
`;
}

function buildOpenClawSkillSource(): string {
  return `---
name: agentgit_governed_tools
description: Use AgentGit governed tools for mutating workspace actions.
---

# AgentGit Governed Tools

When you need to mutate this workspace, prefer the AgentGit tools:

- Use \`agentgit_exec_command\` for shell commands.
- Use \`agentgit_write_file\` for deliberate file writes or rewrites.
- Use \`agentgit_delete_file\` for deletions.

Use read-only tools such as \`read\` for inspection. Avoid trying to bypass the governed tools for mutations.
`;
}

function writeExecutableFile(targetPath: string, content: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o755 });
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  const handle = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o755);
  try {
    fs.writeFileSync(handle, content, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(tempPath, targetPath);
  fs.chmodSync(targetPath, 0o755);
}

function writeTextFile(targetPath: string, content: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf8");
}

export function buildGenericGovernedLaunchMetadata(workspaceRoot: string): GovernedLaunchAssetMetadata {
  const helperSource = buildGovernedRunnerSource();
  return {
    generated_asset_root: governedAssetRoot(workspaceRoot),
    helper_script_path: governedHelperPath(workspaceRoot),
    helper_script_sha256: sha256Hex(helperSource),
    shim_bin_dir: governedShimBinDir(workspaceRoot),
    shim_commands: [...GOVERNED_SHIM_COMMANDS],
    generated_assets: governedGenericAssets(workspaceRoot),
  };
}

export function buildOpenClawGovernedLaunchMetadata(workspaceRoot: string): GovernedLaunchAssetMetadata {
  const generic = buildGenericGovernedLaunchMetadata(workspaceRoot);
  return {
    ...generic,
    openclaw_plugin_root: governedOpenClawPluginRoot(workspaceRoot),
    openclaw_skill_path: governedOpenClawSkillPath(workspaceRoot),
    openclaw_plugin_id: OPENCLAW_PLUGIN_ID,
    openclaw_tool_names: [...OPENCLAW_PLUGIN_TOOL_NAMES],
    openclaw_denied_core_tools: [...OPENCLAW_DENIED_CORE_TOOLS],
    generated_assets: [...generic.generated_assets, ...governedOpenClawPluginAssets(workspaceRoot)],
  };
}

export function ensureGenericGovernedLaunchAssets(workspaceRoot: string): GovernedLaunchAssetMetadata {
  const metadata = buildGenericGovernedLaunchMetadata(workspaceRoot);
  const helperSource = buildGovernedRunnerSource();
  writeExecutableFile(metadata.helper_script_path, helperSource);
  for (const command of metadata.shim_commands) {
    writeExecutableFile(
      governedShimPath(workspaceRoot, command),
      buildGovernedShimSource(command, metadata.helper_script_sha256),
    );
  }
  return metadata;
}

export function ensureOpenClawGovernedLaunchAssets(workspaceRoot: string): GovernedLaunchAssetMetadata {
  const metadata = buildOpenClawGovernedLaunchMetadata(workspaceRoot);
  ensureGenericGovernedLaunchAssets(workspaceRoot);
  if (!metadata.openclaw_plugin_root || !metadata.openclaw_skill_path) {
    return metadata;
  }
  writeTextFile(path.join(metadata.openclaw_plugin_root, "package.json"), buildOpenClawPluginPackageJson());
  writeTextFile(path.join(metadata.openclaw_plugin_root, "openclaw.plugin.json"), buildOpenClawManifest());
  writeTextFile(
    path.join(metadata.openclaw_plugin_root, "index.mjs"),
    buildOpenClawPluginSource(metadata.helper_script_sha256),
  );
  writeTextFile(metadata.openclaw_skill_path, buildOpenClawSkillSource());
  return metadata;
}

export function removeGeneratedGovernedLaunchAssets(
  metadata: Partial<GovernedLaunchAssetMetadata> | null | undefined,
): void {
  if (!metadata) {
    return;
  }

  if (metadata.openclaw_skill_path) {
    fs.rmSync(metadata.openclaw_skill_path, { force: true });
    fs.rmSync(path.dirname(metadata.openclaw_skill_path), { recursive: true, force: true });
  }

  if (metadata.generated_asset_root) {
    fs.rmSync(metadata.generated_asset_root, { recursive: true, force: true });
  }
}

export function governedLaunchAssetsExist(metadata: Partial<GovernedLaunchAssetMetadata> | null | undefined): boolean {
  if (!metadata?.helper_script_path || !metadata.shim_bin_dir) {
    return false;
  }

  if (!fs.existsSync(metadata.helper_script_path) || !fs.existsSync(metadata.shim_bin_dir)) {
    return false;
  }

  if (metadata.helper_script_sha256) {
    const helperContent = fs.readFileSync(metadata.helper_script_path, "utf8");
    if (sha256Hex(helperContent) !== metadata.helper_script_sha256) {
      return false;
    }
  }

  const commands = Array.isArray(metadata.shim_commands) ? metadata.shim_commands : [];
  for (const command of commands) {
    if (!fs.existsSync(path.join(metadata.shim_bin_dir, command))) {
      return false;
    }
  }

  if (metadata.openclaw_plugin_root && !fs.existsSync(path.join(metadata.openclaw_plugin_root, "index.mjs"))) {
    return false;
  }

  if (metadata.openclaw_skill_path && !fs.existsSync(metadata.openclaw_skill_path)) {
    return false;
  }

  return true;
}

export function prependPathEntry(existingPath: string | undefined, entry: string): string {
  if (!existingPath || existingPath.length === 0) {
    return entry;
  }

  const parts = existingPath.split(path.delimiter);
  if (parts[0] === entry) {
    return existingPath;
  }
  return [entry, ...parts].join(path.delimiter);
}
