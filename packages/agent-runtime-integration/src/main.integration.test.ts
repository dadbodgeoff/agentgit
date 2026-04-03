import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ChildProcess, spawn } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalEncryptedSecretStore } from "@agentgit/credential-broker";

import { runCli } from "./main.js";
import { AgentRuntimeIntegrationService } from "./service.js";
import { ProductStateStore } from "./state.js";

let tempDir: string | null = null;
let originalCwd = process.cwd();
const originalEnv = { ...process.env };

function makeTempDir(): string {
  const root = path.join(os.tmpdir(), `agent-runtime-it-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function writeFakeOpenClaw(root: string): string {
  const binDir = path.join(root, "bin");
  const scriptPath = path.join(binDir, "openclaw");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const configPath = process.env.OPENCLAW_CONFIG_PATH;
const args = process.argv.slice(2);
function parsePath(input) {
  return input.replace(/\\[(\\d+)\\]/g, ".$1").split(".").filter(Boolean);
}
function load() {
  if (!configPath || !fs.existsSync(configPath)) {
    return {};
  }
  const text = fs.readFileSync(configPath, "utf8");
  return text.trim().length === 0 ? {} : JSON.parse(text);
}
function save(value) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(value, null, 2));
}
function getValue(target, input) {
  let current = target;
  for (const part of parsePath(input)) {
    if (current == null || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}
function setValue(target, input, value) {
  const parts = parsePath(input);
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}
function unsetValue(target, input) {
  const parts = parsePath(input);
  let current = target;
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== "object") {
      return;
    }
    current = current[part];
  }
  delete current[parts[parts.length - 1]];
}
if (args[0] !== "config") {
  process.exit(1);
}
if (args[1] === "file") {
  process.stdout.write(String(configPath || ""));
  process.exit(0);
}
if (args[1] === "validate") {
  JSON.parse(fs.readFileSync(configPath, "utf8"));
  process.stdout.write("ok");
  process.exit(0);
}
if (args[1] === "get") {
  const value = getValue(load(), args[2]);
  if (value === undefined) {
    process.exit(1);
  }
  process.stdout.write(typeof value === "string" ? value : JSON.stringify(value));
  process.exit(0);
}
if (args[1] === "set") {
  const config = load();
  let value = args[3];
  if (args.includes("--strict-json")) {
    value = JSON.parse(args[3]);
  }
  setValue(config, args[2], value);
  save(config);
  process.exit(0);
}
if (args[1] === "unset") {
  const config = load();
  unsetValue(config, args[2]);
  save(config);
  process.exit(0);
}
process.exit(1);
`,
    "utf8",
  );
  fs.chmodSync(scriptPath, 0o755);
  return scriptPath;
}

function setupWorkspace(): {
  root: string;
  workspaceRoot: string;
  configRoot: string;
  openclawConfigPath: string;
} {
  const root = makeTempDir();
  const workspaceRoot = path.join(root, "workspace");
  const configRoot = path.join(root, "config");
  const openclawConfigPath = path.join(root, "openclaw.json");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.copyFileSync(
    new URL("./test-fixtures/openclaw/default-config.json", import.meta.url),
    openclawConfigPath,
  );
  writeFakeOpenClaw(root);
  process.chdir(workspaceRoot);
  process.env.PATH = `${path.join(root, "bin")}${path.delimiter}${originalEnv.PATH ?? ""}`;
  process.env.OPENCLAW_CONFIG_PATH = openclawConfigPath;
  process.env.AGENTGIT_CLI_CONFIG_ROOT = configRoot;
  process.env.AGENTGIT_MCP_SECRET_STORE_PATH = "";
  process.env.AGENTGIT_MCP_SECRET_KEY_PATH = "";
  process.env.HOME = root;
  const normalizedWorkspaceRoot = fs.realpathSync(workspaceRoot);
  return {
    root,
    workspaceRoot: normalizedWorkspaceRoot,
    configRoot,
    openclawConfigPath,
  };
}

function secretStoreForWorkspace(workspaceRoot: string): LocalEncryptedSecretStore {
  const hash = createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12);
  const runtimeRoot = path.join("/tmp", "agentgit-runtime", hash);
  const mcpRoot = path.join(runtimeRoot, "mcp");
  fs.mkdirSync(mcpRoot, { recursive: true });
  const dbPath = path.join(mcpRoot, "secret-store.db");
  const keyPath = path.join(mcpRoot, "secret-store.key");
  if (!fs.existsSync(keyPath)) {
    fs.writeFileSync(keyPath, randomBytes(32).toString("base64"), { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(keyPath, 0o600);
  }
  return new LocalEncryptedSecretStore({
    dbPath,
    keyPath,
  });
}

function createFailingSpawn(errorMessage: string): typeof spawn {
  return ((..._args: Parameters<typeof spawn>) => {
    const child = new EventEmitter() as ChildProcess;
    child.kill = () => true;
    process.nextTick(() => {
      child.emit("error", new Error(errorMessage));
    });
    return child;
  }) as typeof spawn;
}

beforeEach(() => {
  tempDir = null;
  originalCwd = process.cwd();
  Object.assign(process.env, originalEnv);
});

afterEach(() => {
  process.chdir(originalCwd);
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, originalEnv);
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe.sequential("agentgit product CLI", () => {
  it("sets up and removes an OpenClaw integration without clobbering unrelated config", async () => {
    const harness = setupWorkspace();
    tempDir = harness.root;
    const originalConfigText = fs.readFileSync(harness.openclawConfigPath, "utf8");
    const assetRoot = path.join(harness.workspaceRoot, ".agentgit", "runtime-integration");
    const pluginRoot = path.join(assetRoot, "openclaw-plugin");
    const skillPath = path.join(harness.workspaceRoot, "skills", "agentgit_governed_tools", "SKILL.md");

    await runCli(["setup", "--yes"]);

    const updatedConfig = JSON.parse(fs.readFileSync(harness.openclawConfigPath, "utf8")) as Record<string, any>;
    expect(updatedConfig.agents.defaults.workspace).toBe(harness.workspaceRoot);
    expect(updatedConfig.gateway.port).toBe(19001);
    expect(updatedConfig.plugins.entries.demo.enabled).toBe(true);
    expect(updatedConfig.plugins.entries.agentgit.enabled).toBe(true);
    expect(updatedConfig.plugins.load.paths).toContain(pluginRoot);
    expect(updatedConfig.plugins.allow).toContain("agentgit");
    expect(updatedConfig.tools.deny).toEqual(expect.arrayContaining(["exec", "process", "write", "edit", "apply_patch"]));
    expect(fs.existsSync(path.join(pluginRoot, "index.mjs"))).toBe(true);
    expect(fs.existsSync(skillPath)).toBe(true);
    const postSetupStore = new ProductStateStore(process.env);
    expect(postSetupStore.getProfileForWorkspace(harness.workspaceRoot)?.assurance_level).toBe("integrated");
    expect(postSetupStore.getProfileForWorkspace(harness.workspaceRoot)?.governance_mode).toBe("native_integrated");
    expect(postSetupStore.getProfileForWorkspace(harness.workspaceRoot)?.guarantees).toEqual(
      expect.arrayContaining(["native_runtime_integration", "known_plugin_surfaces_governed", "known_shell_entrypoints_governed"]),
    );
    postSetupStore.close();

    await runCli(["setup", "--yes"]);
    const twiceConfig = JSON.parse(fs.readFileSync(harness.openclawConfigPath, "utf8")) as Record<string, any>;
    expect(twiceConfig.agents.defaults.workspace).toBe(harness.workspaceRoot);

    await runCli(["setup", "--remove"]);
    const restoredConfigText = fs.readFileSync(harness.openclawConfigPath, "utf8");
    const restoredConfig = JSON.parse(restoredConfigText) as Record<string, any>;
    expect(restoredConfig.agents.defaults.workspace).toBe("/tmp/original-openclaw-workspace");
    expect(restoredConfigText).toBe(originalConfigText);
    expect(fs.existsSync(assetRoot)).toBe(false);

    const store = new ProductStateStore(process.env);
    expect(store.getProfileForWorkspace(harness.workspaceRoot)).toBeNull();
    store.close();
  }, 20_000);

  it("shows a recent governed launch even before any dangerous action exists", async () => {
    const harness = setupWorkspace();
    tempDir = harness.root;

    await runCli(["setup", "--command", "node -e \"process.exit(0)\""]);
    await runCli(["run"]);

    const service = new AgentRuntimeIntegrationService({
      cwd: harness.workspaceRoot,
      env: process.env,
    });
    const inspectResult = await service.inspect(harness.workspaceRoot);
    expect(inspectResult.found).toBe(true);
    expect(inspectResult.assurance_level).toBe("attached");
    expect(inspectResult.governance_mode).toBe("attached_live");
    expect(inspectResult.guarantees).toEqual(["known_shell_entrypoints_governed"]);
    expect(inspectResult.action_title).toBeTruthy();
    expect(inspectResult.summary.length).toBeGreaterThan(0);
    expect(inspectResult.restore_available).toBe(false);
    service.close();
  }, 20_000);

  it("stores advanced setup preferences and degrades assurance honestly when the target exceeds the adapter ceiling", async () => {
    const harness = setupWorkspace();
    tempDir = harness.root;

    await runCli([
      "setup",
      "--command",
      "node -e \"process.exit(0)\"",
      "--advanced",
      "--policy",
      "strict",
      "--assurance",
      "contained",
    ]);

    const store = new ProductStateStore(process.env);
    const profile = store.getProfileForWorkspace(harness.workspaceRoot);
    expect(profile?.assurance_level).toBe("attached");
    expect(profile?.degraded_reasons).toEqual([
      "Requested contained assurance, but this runtime currently supports attached assurance.",
    ]);
    expect(profile?.adapter_metadata?.policy_strictness).toBe("strict");
    expect(profile?.adapter_metadata?.setup_experience).toBe("advanced");
    expect(profile?.adapter_metadata?.assurance_target).toBe("contained");
    store.close();
  }, 20_000);

  it("captures a governed shell step when the launched runtime spawns a shimmed subprocess", async () => {
    const harness = setupWorkspace();
    tempDir = harness.root;

    await runCli([
      "setup",
      "--command",
      'node -e "const cp=require(\'node:child_process\'); const result=cp.spawnSync(\'ls\',[\'.\'],{encoding:\'utf8\'}); process.stdout.write(result.stdout); process.exit(result.status ?? 0)"',
    ]);
    const runResult = await runCli(["run"]);
    expect(runResult?.exit_code).toBe(0);

    const service = new AgentRuntimeIntegrationService({
      cwd: harness.workspaceRoot,
      env: process.env,
    });
    const inspectResult = await service.inspect(harness.workspaceRoot);
    expect(inspectResult.found).toBe(true);
    expect(inspectResult.summary).not.toContain("no governed file, shell, or MCP action");
    service.close();
  }, 20_000);

  it("supports the generic setup, run, demo, inspect, and restore flow end to end", async () => {
    const harness = setupWorkspace();
    tempDir = harness.root;
    const assetRoot = path.join(harness.workspaceRoot, ".agentgit", "runtime-integration");

    await runCli(["setup", "--command", "node -e \"process.exit(7)\""]);
    expect(fs.existsSync(path.join(assetRoot, "governed-runner.mjs"))).toBe(true);
    expect(fs.existsSync(path.join(assetRoot, "bin", "sh"))).toBe(true);
    const runResult = await runCli(["run"]);
    expect(runResult?.exit_code).toBe(7);

    const demoStartedAt = Date.now();
    await runCli(["demo"]);
    expect(Date.now() - demoStartedAt).toBeLessThan(15_000);

    const inspectService = new AgentRuntimeIntegrationService({
      cwd: harness.workspaceRoot,
      env: process.env,
    });
    const inspectResult = await inspectService.inspect(harness.workspaceRoot);
    expect(inspectResult.found).toBe(true);
    expect(inspectResult.assurance_level).toBe("attached");
    expect(inspectResult.restore_available).toBe(true);

    const store = new ProductStateStore(process.env);
    const demoRun = store.latestDemoRun(harness.workspaceRoot);
    expect(demoRun?.deleted_path.endsWith("important-plan.md")).toBe(true);

    const previewResult = await inspectService.restore(harness.workspaceRoot, { preview: true });
    expect(previewResult.preview_only).toBe(true);

    const restoreResult = await inspectService.restore(harness.workspaceRoot);
    expect(restoreResult.restored).toBe(true);
    expect(fs.readFileSync(demoRun!.deleted_path, "utf8")).toContain("Important plan");

    await runCli(["setup", "--remove"]);
    expect(fs.existsSync(demoRun!.demo_workspace_root)).toBe(false);
    expect(store.listRestoreShortcuts(harness.workspaceRoot)).toHaveLength(0);
    expect(store.listDemoRuns(harness.workspaceRoot)).toHaveLength(0);
    expect(fs.existsSync(assetRoot)).toBe(false);

    inspectService.close();
    store.close();
  }, 20_000);

  it("supports Docker-contained generic execution with governed publish-back and restore", async () => {
    const harness = setupWorkspace();
    tempDir = harness.root;
    const targetPath = path.join(harness.workspaceRoot, "important-plan.md");
    fs.writeFileSync(targetPath, "keep me\n", "utf8");

    await runCli([
      "setup",
      "--command",
      "rm important-plan.md",
      "--contained",
      "--image",
      "alpine:3.20",
      "--yes",
    ]);

    const store = new ProductStateStore(process.env);
    const profile = store.getProfileForWorkspace(harness.workspaceRoot);
    expect(profile?.assurance_level).toBe("contained");
    expect(profile?.governance_mode).toBe("contained_projection");
    expect(profile?.guarantees).toEqual(
      expect.arrayContaining(["real_workspace_protected", "publish_path_governed"]),
    );
    expect(profile?.capability_snapshot).toMatchObject({
      docker_available: true,
      projection_enforced: true,
      read_only_rootfs_enabled: true,
      network_restricted: false,
      credential_brokering_enabled: false,
    });
    expect(profile?.execution_mode).toBe("docker_contained");
    expect(profile?.container_image).toBe("alpine:3.20");

    const runResult = await runCli(["run"]);
    expect(runResult?.exit_code).toBe(0);
    expect(fs.existsSync(targetPath)).toBe(false);

    const containedRun = store.latestContainedRun(harness.workspaceRoot);
    expect(containedRun?.status).toBe("published");
    expect(containedRun?.changed_paths).toContain(targetPath);

    const service = new AgentRuntimeIntegrationService({
      cwd: harness.workspaceRoot,
      env: process.env,
    });
    const inspectResult = await service.inspect(harness.workspaceRoot);
    expect(inspectResult.found).toBe(true);
    expect(inspectResult.assurance_level).toBe("contained");
    expect(inspectResult.governance_mode).toBe("contained_projection");
    expect(inspectResult.guarantees).toEqual(
      expect.arrayContaining(["real_workspace_protected", "publish_path_governed"]),
    );
    expect(inspectResult.contained_details?.capability_snapshot).toMatchObject({
      docker_available: true,
      projection_enforced: true,
      read_only_rootfs_enabled: true,
    });
    expect(inspectResult.restore_available).toBe(true);

    const preview = await service.restore(harness.workspaceRoot, { preview: true });
    expect(preview.preview_only).toBe(true);

    const restored = await service.restore(harness.workspaceRoot);
    expect(restored.restored).toBe(true);
    expect(fs.readFileSync(targetPath, "utf8")).toContain("keep me");

    await runCli(["setup", "--remove"]);
    expect(store.listContainedRuns(harness.workspaceRoot)).toHaveLength(0);

    service.close();
    store.close();
  }, 40_000);

  it("does not persist a latest attached run when the launched process fails to start", async () => {
    const harness = setupWorkspace();
    tempDir = harness.root;

    await runCli(["setup", "--command", "node -e \"process.exit(0)\""]);

    const service = new AgentRuntimeIntegrationService({
      cwd: harness.workspaceRoot,
      env: process.env,
      spawn_process: createFailingSpawn("simulated attached spawn failure"),
    });

    await expect(service.run(harness.workspaceRoot)).rejects.toThrow("Agent process failed to start.");

    const store = new ProductStateStore(process.env);
    expect(store.getProfileForWorkspace(harness.workspaceRoot)?.last_run_id).toBeUndefined();
    expect(store.latestContainedRun(harness.workspaceRoot)).toBeNull();
    store.close();
    service.close();
  }, 20_000);

  it("cleans up contained startup state when Docker launch fails before the runtime starts", async () => {
    const harness = setupWorkspace();
    tempDir = harness.root;

    await runCli([
      "setup",
      "--contained",
      "--command",
      "node -e \"process.exit(0)\"",
    ]);

    const service = new AgentRuntimeIntegrationService({
      cwd: harness.workspaceRoot,
      env: process.env,
      spawn_process: createFailingSpawn("simulated contained spawn failure"),
    });

    await expect(service.run(harness.workspaceRoot)).rejects.toThrow("Contained Docker process failed to start.");

    const store = new ProductStateStore(process.env);
    expect(store.getProfileForWorkspace(harness.workspaceRoot)?.last_run_id).toBeUndefined();
    expect(store.latestContainedRun(harness.workspaceRoot)).toBeNull();
    const containedWorkspaceRoot = path.join(
      store.paths.state_root,
      "contained",
      createHash("sha256").update(harness.workspaceRoot).digest("hex").slice(0, 12),
    );
    const remainingContainedRunRoots = fs.existsSync(containedWorkspaceRoot)
      ? fs.readdirSync(containedWorkspaceRoot)
      : [];
    expect(remainingContainedRunRoots).toHaveLength(0);
    store.close();
    service.close();
  }, 20_000);

  it("requires an explicit host env allowlist before contained direct-env credentials are passed through", async () => {
    const harness = setupWorkspace();
    tempDir = harness.root;
    process.env.OPENAI_API_KEY = "selected-secret";

    await runCli([
      "setup",
      "--contained",
      "--image",
      "alpine:3.20",
      "--command",
      'if [ -z "${OPENAI_API_KEY:-}" ]; then printf "none\\n" > proof.txt; else printf "%s\\n" "$OPENAI_API_KEY" > proof.txt; fi',
      "--yes",
    ]);

    let store = new ProductStateStore(process.env);
    let profile = store.getProfileForWorkspace(harness.workspaceRoot);
    expect(profile?.contained_credential_mode).toBe("direct_env");
    expect(profile?.credential_passthrough_env_keys ?? []).toEqual([]);
    expect(profile?.guarantees).toContain("brokered_credentials_only");
    store.close();

    let runResult = await runCli(["run"]);
    expect(runResult?.exit_code).toBe(0);
    expect(fs.readFileSync(path.join(harness.workspaceRoot, "proof.txt"), "utf8")).toBe("none\n");

    await runCli([
      "setup",
      "--repair",
      "--contained",
      "--credentials",
      "direct-env",
      "--credential-env",
      "OPENAI_API_KEY",
      "--yes",
    ]);

    store = new ProductStateStore(process.env);
    profile = store.getProfileForWorkspace(harness.workspaceRoot);
    expect(profile?.credential_passthrough_env_keys).toEqual(["OPENAI_API_KEY"]);
    expect(profile?.guarantees).not.toContain("brokered_credentials_only");
    store.close();

    runResult = await runCli(["run"]);
    expect(runResult?.exit_code).toBe(0);
    expect(fs.readFileSync(path.join(harness.workspaceRoot, "proof.txt"), "utf8")).toBe("selected-secret\n");

    const inspectService = new AgentRuntimeIntegrationService({
      cwd: harness.workspaceRoot,
      env: process.env,
    });
    const inspectResult = await inspectService.inspect(harness.workspaceRoot);
    expect(inspectResult.contained_details?.credential_mode).toBe("direct_env");
    expect(inspectResult.contained_details?.credential_env_keys).toEqual(["OPENAI_API_KEY"]);
    expect(inspectResult.degraded_reasons).toContain("Container receives direct host credential passthrough for OPENAI_API_KEY.");
    inspectService.close();
  }, 40_000);

  it("enforces strict contained policy by blocking network and withholding host credential env vars", async () => {
    const harness = setupWorkspace();
    tempDir = harness.root;
    process.env.OPENAI_API_KEY = "test-contained-secret";

    await runCli([
      "setup",
      "--command",
      'if [ -z "${OPENAI_API_KEY:-}" ]; then printf "none\\n" > proof.txt; else printf "%s\\n" "$OPENAI_API_KEY" > proof.txt; fi',
      "--contained",
      "--image",
      "alpine:3.20",
      "--policy",
      "strict",
      "--yes",
    ]);

    const store = new ProductStateStore(process.env);
    const profile = store.getProfileForWorkspace(harness.workspaceRoot);
    expect(profile?.execution_mode).toBe("docker_contained");
    expect(profile?.container_network_policy).toBe("none");
    expect(profile?.contained_credential_mode).toBe("none");
    expect(profile?.credential_passthrough_env_keys ?? []).toEqual([]);
    expect(profile?.capability_snapshot).toMatchObject({
      docker_available: true,
      projection_enforced: true,
      read_only_rootfs_enabled: true,
      network_restricted: true,
      credential_brokering_enabled: false,
    });

    const runResult = await runCli(["run"]);
    expect(runResult?.exit_code).toBe(0);

    const proofPath = path.join(harness.workspaceRoot, "proof.txt");
    expect(fs.readFileSync(proofPath, "utf8")).toBe("none\n");

    const inspectService = new AgentRuntimeIntegrationService({
      cwd: harness.workspaceRoot,
      env: process.env,
    });
    const inspectResult = await inspectService.inspect(harness.workspaceRoot);
    expect(inspectResult.contained_details?.network_policy).toBe("none");
    expect(inspectResult.contained_details?.credential_mode).toBe("none");
    expect(inspectResult.contained_details?.capability_snapshot).toMatchObject({
      docker_available: true,
      network_restricted: true,
      credential_brokering_enabled: false,
    });
    inspectService.close();
    store.close();
  }, 40_000);

  it("injects brokered contained secrets from the encrypted store instead of host env passthrough", async () => {
    const harness = setupWorkspace();
    tempDir = harness.root;
    process.env.OPENAI_API_KEY = "host-secret";

    const secretStore = secretStoreForWorkspace(harness.workspaceRoot);
    secretStore.upsertMcpBearerSecret({
      secret_id: "contained_openai",
      bearer_token: "brokered-secret",
      display_name: "Contained OpenAI",
    });
    secretStore.close();

    await runCli([
      "setup",
      "--command",
      'printf "%s\\n" "${OPENAI_API_KEY:-missing}" > proof.txt',
      "--contained",
      "--image",
      "alpine:3.20",
      "--network",
      "none",
      "--credentials",
      "brokered-secret-refs",
      "--secret-env",
      "OPENAI_API_KEY=contained_openai",
      "--yes",
    ]);

    const store = new ProductStateStore(process.env);
    const profile = store.getProfileForWorkspace(harness.workspaceRoot);
    expect(profile?.contained_credential_mode).toBe("brokered_secret_refs");
    expect(profile?.governance_mode).toBe("contained_projection");
    expect(profile?.guarantees).toEqual(
      expect.arrayContaining(["real_workspace_protected", "publish_path_governed", "brokered_credentials_only", "egress_policy_applied"]),
    );
    expect(profile?.credential_passthrough_env_keys ?? []).toEqual([]);
    expect(profile?.contained_secret_env_bindings).toEqual([
      {
        env_key: "OPENAI_API_KEY",
        secret_id: "contained_openai",
      },
    ]);
    expect(profile?.capability_snapshot).toMatchObject({
      docker_available: true,
      projection_enforced: true,
      read_only_rootfs_enabled: true,
      network_restricted: true,
      credential_brokering_enabled: true,
    });

    const runResult = await runCli(["run"]);
    expect(runResult?.exit_code).toBe(0);

    const proofPath = path.join(harness.workspaceRoot, "proof.txt");
    expect(fs.readFileSync(proofPath, "utf8")).toBe("brokered-secret\n");

    const service = new AgentRuntimeIntegrationService({
      cwd: harness.workspaceRoot,
      env: process.env,
    });
    const inspectResult = await service.inspect(harness.workspaceRoot);
    expect(inspectResult.contained_details?.credential_mode).toBe("brokered_secret_refs");
    expect(inspectResult.contained_details?.credential_env_keys).toEqual(["OPENAI_API_KEY"]);
    expect(inspectResult.contained_details?.capability_snapshot).toMatchObject({
      docker_available: true,
      network_restricted: true,
      credential_brokering_enabled: true,
    });
    expect(inspectResult.governance_mode).toBe("contained_projection");
    expect(inspectResult.guarantees).toEqual(
      expect.arrayContaining(["real_workspace_protected", "publish_path_governed", "brokered_credentials_only", "egress_policy_applied"]),
    );
    service.close();
    store.close();
  }, 40_000);

  it("mounts brokered contained secret files read-only from the encrypted store", async () => {
    const harness = setupWorkspace();
    tempDir = harness.root;

    const secretStore = secretStoreForWorkspace(harness.workspaceRoot);
    secretStore.upsertMcpBearerSecret({
      secret_id: "contained_file_secret",
      bearer_token: "file-brokered-secret",
      display_name: "Contained file secret",
    });
    secretStore.close();

    await runCli([
      "setup",
      "--command",
      "cat /run/agentgit-secrets/openai.key > proof-file.txt",
      "--contained",
      "--image",
      "alpine:3.20",
      "--network",
      "none",
      "--credentials",
      "brokered-secret-refs",
      "--secret-file",
      "openai.key=contained_file_secret",
      "--yes",
    ]);

    const store = new ProductStateStore(process.env);
    const profile = store.getProfileForWorkspace(harness.workspaceRoot);
    expect(profile?.contained_credential_mode).toBe("brokered_secret_refs");
    expect(profile?.contained_secret_file_bindings).toEqual([
      {
        relative_path: "openai.key",
        secret_id: "contained_file_secret",
      },
    ]);

    const runResult = await runCli(["run"]);
    expect(runResult?.exit_code).toBe(0);

    const proofPath = path.join(harness.workspaceRoot, "proof-file.txt");
    expect(fs.readFileSync(proofPath, "utf8")).toBe("file-brokered-secret\n");

    const service = new AgentRuntimeIntegrationService({
      cwd: harness.workspaceRoot,
      env: process.env,
    });
    const inspectResult = await service.inspect(harness.workspaceRoot);
    expect(inspectResult.contained_details?.credential_mode).toBe("brokered_secret_refs");
    expect(inspectResult.contained_details?.credential_file_paths).toEqual([
      "/run/agentgit-secrets/openai.key",
    ]);
    expect(inspectResult.contained_details?.capability_snapshot).toMatchObject({
      credential_brokering_enabled: true,
      network_restricted: true,
    });
    service.close();
    store.close();
  }, 40_000);

  it("routes proxy-aware contained HTTP egress through an allowlist proxy", async () => {
    const harness = setupWorkspace();
    tempDir = harness.root;

    const upstreamServer = http.createServer((request, response) => {
      if (request.url === "/allowed") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("proxy-allowed\n");
        return;
      }
      response.writeHead(404).end("missing");
    });
    await new Promise<void>((resolve) => upstreamServer.listen(0, "0.0.0.0", () => resolve()));
    const address = upstreamServer.address();
    if (!address || typeof address === "string") {
      throw new Error("test server failed to bind");
    }

    try {
      await runCli([
        "setup",
        "--command",
        `wget -qO- http://host.docker.internal:${address.port}/allowed > fetched.txt`,
        "--contained",
        "--image",
        "alpine:3.20",
        "--egress-host",
        `host.docker.internal:${address.port}`,
        "--yes",
      ]);

      const store = new ProductStateStore(process.env);
      const profile = store.getProfileForWorkspace(harness.workspaceRoot);
      expect(profile?.contained_proxy_allowlist_hosts).toEqual([`host.docker.internal:${address.port}`]);
      expect(profile?.guarantees).toEqual(
        expect.arrayContaining(["real_workspace_protected", "publish_path_governed", "egress_policy_applied"]),
      );
      expect(profile?.capability_snapshot).toMatchObject({
        proxy_egress_allowlist_applied: true,
        egress_allowlist_hosts: [`host.docker.internal:${address.port}`],
      });
      expect(profile?.degraded_reasons).toContain(
        "Contained egress allowlist is proxy-based and only applies to proxy-aware HTTP(S) clients.",
      );

      const runResult = await runCli(["run"]);
      expect(runResult?.exit_code).toBe(0);

      const fetchedPath = path.join(harness.workspaceRoot, "fetched.txt");
      expect(fs.readFileSync(fetchedPath, "utf8")).toBe("proxy-allowed\n");

      const service = new AgentRuntimeIntegrationService({
        cwd: harness.workspaceRoot,
        env: process.env,
      });
      const inspectResult = await service.inspect(harness.workspaceRoot);
      expect(inspectResult.contained_details?.egress_allowlist_hosts).toEqual([`host.docker.internal:${address.port}`]);
      expect(inspectResult.contained_details?.capability_snapshot).toMatchObject({
        proxy_egress_allowlist_applied: true,
      });
      service.close();
      store.close();
    } finally {
      await new Promise<void>((resolve, reject) => {
        upstreamServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  }, 40_000);

  it("re-checks contained Docker availability during inspect and repair", async () => {
    const harness = setupWorkspace();
    tempDir = harness.root;
    const originalPath = process.env.PATH;

    try {
      await runCli([
        "setup",
        "--command",
        "printf 'still-contained\\n' > contained-proof.txt",
        "--contained",
        "--image",
        "alpine:3.20",
        "--yes",
      ]);

      process.env.PATH = path.join(harness.root, "bin");

      const service = new AgentRuntimeIntegrationService({
        cwd: harness.workspaceRoot,
        env: process.env,
      });
      const inspectResult = await service.inspect(harness.workspaceRoot);
      expect(inspectResult.assurance_level).toBe("contained");
      expect(inspectResult.degraded_reasons).toContain("Docker is not available on this machine.");
      expect(inspectResult.contained_details?.capability_snapshot).toMatchObject({
        docker_available: false,
      });

      const repairResult = service.repair(harness.workspaceRoot);
      expect(repairResult.assurance_level).toBe("contained");
      expect(repairResult.health_checks.some((check) => check.label === "docker contained launch" && !check.ok)).toBe(
        true,
      );
      expect(repairResult.degraded_reasons).toContain("Docker is not available on this machine.");
      service.close();
    } finally {
      process.env.PATH = originalPath;
    }
  }, 40_000);

  it("fails launch preflight for contained profiles when Docker is unavailable and does not register a new run", async () => {
    const harness = setupWorkspace();
    tempDir = harness.root;
    const originalPath = process.env.PATH;

    try {
      await runCli([
        "setup",
        "--command",
        "printf 'still-contained\\n' > contained-proof.txt",
        "--contained",
        "--image",
        "alpine:3.20",
        "--yes",
      ]);

      const store = new ProductStateStore(process.env);
      const beforeProfile = store.getProfileForWorkspace(harness.workspaceRoot);
      expect(beforeProfile?.last_run_id).toBeUndefined();
      store.close();

      process.env.PATH = path.join(harness.root, "bin");

      await expect(runCli(["run"])).rejects.toThrow(/Docker is not available right now/);

      const afterStore = new ProductStateStore(process.env);
      const afterProfile = afterStore.getProfileForWorkspace(harness.workspaceRoot);
      expect(afterProfile?.last_run_id).toBeUndefined();
      expect(afterStore.listContainedRuns(harness.workspaceRoot)).toHaveLength(0);
      afterStore.close();
    } finally {
      process.env.PATH = originalPath;
    }
  }, 40_000);

  it("fails launch preflight for brokered contained secrets that disappeared after setup", async () => {
    const harness = setupWorkspace();
    tempDir = harness.root;

    const secretStore = secretStoreForWorkspace(harness.workspaceRoot);
    secretStore.upsertMcpBearerSecret({
      secret_id: "contained_openai",
      bearer_token: "brokered-secret",
      display_name: "Contained OpenAI",
    });
    secretStore.close();

    await runCli([
      "setup",
      "--command",
      'printf "%s\\n" "${OPENAI_API_KEY:-missing}" > proof.txt',
      "--contained",
      "--image",
      "alpine:3.20",
      "--network",
      "none",
      "--credentials",
      "brokered-secret-refs",
      "--secret-env",
      "OPENAI_API_KEY=contained_openai",
      "--yes",
    ]);

    const removeStore = secretStoreForWorkspace(harness.workspaceRoot);
    removeStore.removeMcpBearerSecret("contained_openai");
    removeStore.close();

    await expect(runCli(["run"])).rejects.toThrow(/Governed MCP secret is not configured/);

    const store = new ProductStateStore(process.env);
    const profile = store.getProfileForWorkspace(harness.workspaceRoot);
    expect(profile?.last_run_id).toBeUndefined();
    expect(store.listContainedRuns(harness.workspaceRoot)).toHaveLength(0);
    store.close();
  }, 40_000);

  it("surfaces missing brokered contained secrets in inspect after setup drift", async () => {
    const harness = setupWorkspace();
    tempDir = harness.root;

    const secretStore = secretStoreForWorkspace(harness.workspaceRoot);
    secretStore.upsertMcpBearerSecret({
      secret_id: "contained_openai",
      bearer_token: "brokered-secret",
      display_name: "Contained OpenAI",
    });
    secretStore.close();

    await runCli([
      "setup",
      "--command",
      'printf "%s\\n" "${OPENAI_API_KEY:-missing}" > proof.txt',
      "--contained",
      "--image",
      "alpine:3.20",
      "--network",
      "none",
      "--credentials",
      "brokered-secret-refs",
      "--secret-env",
      "OPENAI_API_KEY=contained_openai",
      "--yes",
    ]);

    const removeStore = secretStoreForWorkspace(harness.workspaceRoot);
    removeStore.removeMcpBearerSecret("contained_openai");
    removeStore.close();

    const service = new AgentRuntimeIntegrationService({
      cwd: harness.workspaceRoot,
      env: process.env,
    });
    const inspectResult = await service.inspect(harness.workspaceRoot);
    expect(inspectResult.assurance_level).toBe("contained");
    expect(inspectResult.degraded_reasons.some((reason) => reason.includes("Governed MCP secret is not configured."))).toBe(
      true,
    );
    expect(inspectResult.contained_details?.credential_mode).toBe("brokered_secret_refs");
    service.close();
  }, 40_000);

  it("fails launch preflight for OpenClaw drift until repair is requested", async () => {
    const harness = setupWorkspace();
    tempDir = harness.root;

    await runCli(["setup", "--yes"]);

    const config = JSON.parse(fs.readFileSync(harness.openclawConfigPath, "utf8")) as Record<string, any>;
    config.gateway.port = 19009;
    fs.writeFileSync(harness.openclawConfigPath, JSON.stringify(config, null, 2));

    await expect(runCli(["run"])).rejects.toThrow(/setup --repair/);

    const store = new ProductStateStore(process.env);
    const profile = store.getProfileForWorkspace(harness.workspaceRoot);
    expect(profile?.last_run_id).toBeUndefined();
    store.close();
  }, 40_000);

  it("defaults to non-destructive preview when a restore would overwrite later work", async () => {
    const harness = setupWorkspace();
    tempDir = harness.root;

    await runCli(["setup", "--command", "node -e \"process.exit(0)\""]);
    await runCli(["demo"]);

    const store = new ProductStateStore(process.env);
    const demoRun = store.latestDemoRun(harness.workspaceRoot);
    expect(demoRun).not.toBeNull();
    fs.writeFileSync(demoRun!.deleted_path, "post-incident user change\n", "utf8");

    const service = new AgentRuntimeIntegrationService({
      cwd: harness.workspaceRoot,
      env: process.env,
    });
    const previewOnly = await service.restore(harness.workspaceRoot);
    expect(previewOnly.preview_only).toBe(true);
    expect(previewOnly.conflict_detected).toBe(true);
    expect(fs.readFileSync(demoRun!.deleted_path, "utf8")).toContain("post-incident user change");

    const forced = await service.restore(harness.workspaceRoot, { force: true });
    expect(forced.restored).toBe(true);
    expect(fs.readFileSync(demoRun!.deleted_path, "utf8")).toContain("Important plan");

    service.close();
    store.close();
  }, 20_000);

  it("fails closed on OpenClaw config drift until repair is requested", async () => {
    const harness = setupWorkspace();
    tempDir = harness.root;

    await runCli(["setup", "--yes"]);

    const config = JSON.parse(fs.readFileSync(harness.openclawConfigPath, "utf8")) as Record<string, any>;
    config.gateway.port = 19009;
    fs.writeFileSync(harness.openclawConfigPath, JSON.stringify(config, null, 2));

    await expect(runCli(["setup", "--yes"])).rejects.toThrow(/setup --repair/);

    await runCli(["setup", "--repair"]);
    const repaired = JSON.parse(fs.readFileSync(harness.openclawConfigPath, "utf8")) as Record<string, any>;
    expect(repaired.agents.defaults.workspace).toBe(harness.workspaceRoot);
    expect(repaired.gateway.port).toBe(19009);
  }, 20_000);

  it("keeps backups and preserves user config changes during remove conflicts", async () => {
    const harness = setupWorkspace();
    tempDir = harness.root;

    await runCli(["setup", "--yes"]);

    const config = JSON.parse(fs.readFileSync(harness.openclawConfigPath, "utf8")) as Record<string, any>;
    config.agents.defaults.workspace = "/tmp/user-changed-workspace";
    config.gateway.port = 19077;
    fs.writeFileSync(harness.openclawConfigPath, JSON.stringify(config, null, 2));

    const service = new AgentRuntimeIntegrationService({
      cwd: harness.workspaceRoot,
      env: process.env,
    });
    const result = service.remove(harness.workspaceRoot);
    expect(result.preserved_user_changes).toHaveLength(1);

    const postRemove = JSON.parse(fs.readFileSync(harness.openclawConfigPath, "utf8")) as Record<string, any>;
    expect(postRemove.agents.defaults.workspace).toBe("/tmp/user-changed-workspace");
    expect(postRemove.gateway.port).toBe(19077);

    const store = new ProductStateStore(process.env);
    expect(store.listConfigBackups(harness.workspaceRoot)).toHaveLength(1);
    service.close();
    store.close();
  }, 20_000);

  it("survives a fresh service instance between demo, inspect, and restore", async () => {
    const harness = setupWorkspace();
    tempDir = harness.root;

    await runCli(["setup", "--command", "node -e \"process.exit(0)\""]);
    await runCli(["demo"]);

    const firstService = new AgentRuntimeIntegrationService({
      cwd: harness.workspaceRoot,
      env: process.env,
    });
    firstService.close();

    const secondService = new AgentRuntimeIntegrationService({
      cwd: harness.workspaceRoot,
      env: process.env,
    });
    const inspectResult = await secondService.inspect(harness.workspaceRoot);
    expect(inspectResult.found).toBe(true);
    expect(inspectResult.restore_available).toBe(true);

    const previewResult = await secondService.restore(harness.workspaceRoot, { preview: true });
    expect(previewResult.preview_only).toBe(true);

    const restoreResult = await secondService.restore(harness.workspaceRoot);
    expect(restoreResult.restored).toBe(true);
    secondService.close();
  }, 20_000);
});
