import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { OpenClawAdapter, createAdapterContext, detectBestRuntime, planSetup } from "./adapters.js";
import { ProductStateStore } from "./state.js";
import type { CommandRunOptions, CommandRunResult, CommandRunner } from "./utils.js";

class FakeOpenClawRunner implements CommandRunner {
  constructor(private readonly configPath: string) {}

  run(command: string, args: string[] = [], _options: CommandRunOptions = {}): CommandRunResult {
    if (command === "git" && args[0] === "rev-parse") {
      return this.success(path.dirname(this.configPath));
    }

    if (command !== "openclaw" || args[0] !== "config") {
      return this.failure("unsupported command");
    }

    if (args[1] === "file") {
      return this.success(this.configPath);
    }

    if (args[1] === "validate") {
      JSON.parse(fs.readFileSync(this.configPath, "utf8"));
      return this.success("ok");
    }

    if (args[1] === "get") {
      const config = JSON.parse(fs.readFileSync(this.configPath, "utf8")) as Record<string, any>;
      const value = args[2]!.split(".").reduce<any>((current, key) => current?.[key], config);
      return value === undefined ? this.failure("") : this.success(typeof value === "string" ? value : JSON.stringify(value));
    }

    if (args[1] === "set") {
      const config = JSON.parse(fs.readFileSync(this.configPath, "utf8")) as Record<string, any>;
      const pathParts = args[2]!.split(".");
      let current: Record<string, any> = config;
      for (const key of pathParts.slice(0, -1)) {
        current[key] ??= {};
        current = current[key] as Record<string, any>;
      }
      current[pathParts[pathParts.length - 1]!] = args.includes("--strict-json") ? JSON.parse(args[3]!) : args[3];
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
      return this.success("");
    }

    if (args[1] === "unset") {
      const config = JSON.parse(fs.readFileSync(this.configPath, "utf8")) as Record<string, any>;
      const pathParts = args[2]!.split(".");
      let current: Record<string, any> = config;
      for (const key of pathParts.slice(0, -1)) {
        current = (current[key] ?? {}) as Record<string, any>;
      }
      delete current[pathParts[pathParts.length - 1]!];
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
      return this.success("");
    }

    return this.failure("unsupported openclaw subcommand");
  }

  private success(stdout: string): CommandRunResult {
    return { ok: true, exit_code: 0, stdout, stderr: "" };
  }

  private failure(stderr: string): CommandRunResult {
    return { ok: false, exit_code: 1, stdout: "", stderr };
  }
}

class FakeDockerRunner implements CommandRunner {
  run(command: string, args: string[] = [], _options: CommandRunOptions = {}): CommandRunResult {
    if (command === "git" && args[0] === "rev-parse") {
      return { ok: true, exit_code: 0, stdout: "/tmp/workspace", stderr: "" };
    }

    if (command === "docker" && args[0] === "version") {
      return {
        ok: true,
        exit_code: 0,
        stdout: JSON.stringify({
          Server: {
            Platform: { Name: "Docker Desktop 4.63.0 (177762)" },
            Os: "linux",
            Arch: "aarch64",
          },
        }),
        stderr: "",
      };
    }

    if (command === "docker" && args[0] === "info") {
      return {
        ok: true,
        exit_code: 0,
        stdout: JSON.stringify({
          OperatingSystem: "Docker Desktop",
          SecurityOptions: ["name=rootless"],
        }),
        stderr: "",
      };
    }

    return { ok: false, exit_code: 1, stdout: "", stderr: "unsupported command" };
  }
}

class FakeMissingDockerRunner implements CommandRunner {
  run(command: string, args: string[] = [], _options: CommandRunOptions = {}): CommandRunResult {
    if (command === "git" && args[0] === "rev-parse") {
      return { ok: true, exit_code: 0, stdout: "/tmp/workspace", stderr: "" };
    }

    if (command === "docker") {
      return {
        ok: false,
        exit_code: 1,
        stdout: "",
        stderr: "Cannot connect to the Docker daemon.",
      };
    }

    return { ok: false, exit_code: 1, stdout: "", stderr: "unsupported command" };
  }
}

let tempDir: string | null = null;
let previousConfigRoot: string | undefined;

function makeTempDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-runtime-adapters-"));
  tempDir = root;
  previousConfigRoot = process.env.AGENTGIT_CLI_CONFIG_ROOT;
  process.env.AGENTGIT_CLI_CONFIG_ROOT = path.join(root, "config");
  return root;
}

afterEach(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
  if (previousConfigRoot === undefined) {
    delete process.env.AGENTGIT_CLI_CONFIG_ROOT;
  } else {
    process.env.AGENTGIT_CLI_CONFIG_ROOT = previousConfigRoot;
  }
});

describe("adapter planning", () => {
  it("detects OpenClaw when a supported runtime is available", () => {
    const root = makeTempDir();
    const workspaceRoot = path.join(root, "workspace");
    const configPath = path.join(root, "openclaw.json");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ agents: { defaults: { workspace: "/tmp/original" } }, gateway: { port: 19001 } }, null, 2),
    );

    const store = new ProductStateStore(process.env);
    const context = createAdapterContext({
      workspace_root: workspaceRoot,
      state: store,
      runner: new FakeOpenClawRunner(configPath),
      env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath },
      cwd: workspaceRoot,
    });

    const detected = detectBestRuntime(context);
    expect(detected?.detection.runtime_id).toBe("openclaw");
    expect(detected?.detection.assurance_ceiling).toBe("integrated");
    store.close();
  });

  it("fails closed on OpenClaw config drift until repair mode is used", () => {
    const root = makeTempDir();
    const workspaceRoot = path.join(root, "workspace");
    const configPath = path.join(root, "openclaw.json");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    fs.writeFileSync(
      configPath,
      JSON.stringify({ agents: { defaults: { workspace: "/tmp/original" } }, gateway: { port: 19001 } }, null, 2),
    );

    const store = new ProductStateStore(process.env);
    const runner = new FakeOpenClawRunner(configPath);
    const adapter = new OpenClawAdapter();
    const baseContext = createAdapterContext({
      workspace_root: workspaceRoot,
      state: store,
      runner,
      env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath },
      cwd: workspaceRoot,
    });
    const firstPlan = planSetup(baseContext);
    adapter.apply(baseContext, firstPlan.plan);

    const drifted = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, any>;
    drifted.gateway.port = 19009;
    fs.writeFileSync(configPath, JSON.stringify(drifted, null, 2));

    expect(() => planSetup(baseContext)).toThrow(/setup --repair/);

    const repairContext = createAdapterContext({
      workspace_root: workspaceRoot,
      state: store,
      runner,
      env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath },
      cwd: workspaceRoot,
      repair_mode: true,
    });
    expect(() => planSetup(repairContext)).not.toThrow();
    store.close();
  });

  it("plans the generic fallback when the user supplies a launch command", () => {
    const root = makeTempDir();
    const workspaceRoot = path.join(root, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const store = new ProductStateStore(process.env);
    const context = createAdapterContext({
      workspace_root: workspaceRoot,
      state: store,
      user_command: "my-agent --start",
      cwd: workspaceRoot,
    });

    const planned = planSetup(context);
    expect(planned.plan.runtime_id).toBe("generic-command");
    expect(planned.plan.launch_command).toBe("my-agent --start");
    expect(planned.plan.assurance_level).toBe("attached");
    expect(planned.plan.governance_mode).toBe("attached_live");
    expect(planned.plan.guarantees).toEqual(["known_shell_entrypoints_governed"]);
    expect(planned.detection.assurance_ceiling).toBe("attached");
    store.close();
  });

  it("plans contained Docker setup with explicit network and credential policy", () => {
    const root = makeTempDir();
    const workspaceRoot = path.join(root, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const store = new ProductStateStore(process.env);
    const context = createAdapterContext({
      workspace_root: workspaceRoot,
      state: store,
      user_command: "my-agent --start",
      cwd: workspaceRoot,
      runner: new FakeDockerRunner(),
      env: { ...process.env, OPENAI_API_KEY: "test-secret" },
      setup_preferences: {
        experience: "advanced",
        policy_strictness: "balanced",
        install_scope: "workspace",
        containment_backend: "docker",
        container_network_policy: "inherit",
        contained_credential_mode: "direct_env",
        credential_passthrough_env_keys: ["OPENAI_API_KEY"],
        contained_proxy_allowlist_hosts: ["api.example.com:443"],
      },
    });

    const planned = planSetup(context);
    expect(planned.plan.execution_mode).toBe("docker_contained");
    expect(planned.plan.assurance_level).toBe("contained");
    expect(planned.plan.governance_mode).toBe("contained_projection");
    expect(planned.plan.guarantees).toEqual(
      expect.arrayContaining(["real_workspace_protected", "publish_path_governed", "egress_policy_applied"]),
    );
    expect(planned.plan.container_network_policy).toBe("inherit");
    expect(planned.plan.contained_credential_mode).toBe("direct_env");
    expect(planned.plan.contained_proxy_allowlist_hosts).toEqual(["api.example.com:443"]);
    expect(planned.plan.credential_passthrough_env_keys).toContain("OPENAI_API_KEY");
    expect(planned.plan.capability_snapshot).toMatchObject({
      docker_available: true,
      docker_desktop_vm: true,
      rootless_docker: true,
      projection_enforced: true,
      read_only_rootfs_enabled: true,
      network_restricted: false,
      credential_brokering_enabled: false,
      proxy_egress_allowlist_applied: true,
      egress_allowlist_hosts: ["api.example.com:443"],
    });
    expect(planned.plan.degraded_reasons).toContain("Container receives direct host credential passthrough for OPENAI_API_KEY.");
    store.close();
  });

  it("plans brokered contained secret refs without host env passthrough", () => {
    const root = makeTempDir();
    const workspaceRoot = path.join(root, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const store = new ProductStateStore(process.env);
    const context = createAdapterContext({
      workspace_root: workspaceRoot,
      state: store,
      user_command: "my-agent --start",
      cwd: workspaceRoot,
      runner: new FakeDockerRunner(),
      env: { ...process.env },
      setup_preferences: {
        experience: "advanced",
        policy_strictness: "strict",
        install_scope: "workspace",
        containment_backend: "docker",
        container_network_policy: "none",
        contained_credential_mode: "brokered_secret_refs",
        contained_secret_env_bindings: [
          {
            env_key: "OPENAI_API_KEY",
            secret_id: "contained_openai",
          },
        ],
        contained_secret_file_bindings: [
          {
            relative_path: "openai.key",
            secret_id: "contained_openai",
          },
        ],
      },
    });

    const planned = planSetup(context);
    expect(planned.plan.execution_mode).toBe("docker_contained");
    expect(planned.plan.contained_credential_mode).toBe("brokered_secret_refs");
    expect(planned.plan.governance_mode).toBe("contained_projection");
    expect(planned.plan.guarantees).toEqual(
      expect.arrayContaining(["real_workspace_protected", "publish_path_governed", "brokered_credentials_only", "egress_policy_applied"]),
    );
    expect(planned.plan.capability_snapshot).toMatchObject({
      docker_available: true,
      docker_desktop_vm: true,
      rootless_docker: true,
      projection_enforced: true,
      read_only_rootfs_enabled: true,
      network_restricted: true,
      credential_brokering_enabled: true,
    });
    expect(planned.plan.credential_passthrough_env_keys).toEqual([]);
    expect(planned.plan.contained_secret_env_bindings).toEqual([
      {
        env_key: "OPENAI_API_KEY",
        secret_id: "contained_openai",
      },
    ]);
    expect(planned.plan.contained_secret_file_bindings).toEqual([
      {
        relative_path: "openai.key",
        secret_id: "contained_openai",
      },
    ]);
    expect(planned.plan.degraded_reasons).toEqual([]);
    store.close();
  });

  it("re-verifies contained profiles against live Docker availability", () => {
    const root = makeTempDir();
    const workspaceRoot = path.join(root, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const store = new ProductStateStore(process.env);
    const setupContext = createAdapterContext({
      workspace_root: workspaceRoot,
      state: store,
      user_command: "my-agent --start",
      cwd: workspaceRoot,
      runner: new FakeDockerRunner(),
      env: { ...process.env },
      setup_preferences: {
        experience: "advanced",
        policy_strictness: "balanced",
        install_scope: "workspace",
        assurance_target: "contained",
        containment_backend: "docker",
      },
    });

    const initial = planSetup(setupContext);
    initial.adapter.apply(setupContext, initial.plan);

    const verifyContext = createAdapterContext({
      workspace_root: workspaceRoot,
      state: store,
      cwd: workspaceRoot,
      runner: new FakeMissingDockerRunner(),
      env: { ...process.env },
      setup_preferences: {
        experience: "advanced",
        policy_strictness: "balanced",
        install_scope: "workspace",
        assurance_target: "contained",
        containment_backend: "docker",
        container_image: initial.plan.container_image,
        container_network_policy: initial.plan.container_network_policy,
        contained_credential_mode: initial.plan.contained_credential_mode,
        contained_secret_env_bindings: initial.plan.contained_secret_env_bindings,
        contained_secret_file_bindings: initial.plan.contained_secret_file_bindings,
        contained_proxy_allowlist_hosts: initial.plan.contained_proxy_allowlist_hosts,
      },
    });

    const repaired = planSetup(verifyContext);
    const verifyResult = repaired.adapter.verify(verifyContext, repaired.plan);

    expect(repaired.plan.execution_mode).toBe("docker_contained");
    expect(verifyResult.ready).toBe(false);
    expect(verifyResult.health_checks[0]).toMatchObject({
      label: "docker contained launch",
      ok: false,
    });
    expect(verifyResult.degraded_reasons).toContain("Docker is not available on this machine.");
    expect(verifyResult.recommended_next_command).toBe("agentgit setup --repair --contained");
    store.close();
  });
});
