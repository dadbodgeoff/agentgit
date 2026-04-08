import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CLI_CONFIG_SCHEMA_VERSION } from "./cli-contract.js";
import {
  createCliConfigPaths,
  getProfileFromResolvedConfig,
  parseGlobalFlags,
  removeUserProfile,
  resolveCliConfig,
  setActiveUserProfile,
  upsertUserProfile,
  validateCliConfig,
  writeUserConfig,
} from "./cli-config.js";

const tempRoots: string[] = [];

function createTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cli-config-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("cli config", () => {
  it("parses global flags and falls back to env for workspace and socket paths", () => {
    const root = createTempRoot();
    const workspaceRoot = path.join(root, "workspace");
    const socketPath = path.join(root, "authority.sock");

    const flags = parseGlobalFlags(["--json", "ping"], {
      AGENTGIT_ROOT: workspaceRoot,
      AGENTGIT_SOCKET_PATH: socketPath,
    });

    expect(flags.jsonOutput).toBe(true);
    expect(flags.command).toBe("ping");
    expect(flags.workspaceRoot).toBe(path.resolve(workspaceRoot));
    expect(flags.socketPath).toBe(path.resolve(socketPath));
  });

  it("ignores INIT_CWD when inferring workspace defaults", () => {
    const flags = parseGlobalFlags(["ping"], {
      INIT_CWD: "/tmp/should-not-win",
    });

    expect(flags.workspaceRoot).toBeUndefined();
  });

  it("resolves layered config precedence across user, workspace, env, and runtime flags", () => {
    const root = createTempRoot();
    const cwd = path.join(root, "cwd");
    const workspaceRoot = path.join(root, "runtime-workspace");
    const configRoot = path.join(root, "config");
    const paths = createCliConfigPaths(cwd, {}, configRoot, workspaceRoot);

    fs.mkdirSync(path.dirname(paths.workspaceConfigPath), { recursive: true });
    writeUserConfig(paths.userConfigPath, {
      schema_version: CLI_CONFIG_SCHEMA_VERSION,
      defaults: {
        connect_timeout_ms: 1000,
        response_timeout_ms: 5000,
      },
      profiles: {
        local: {
          workspace_root: "/user/workspace",
          socket_path: "/user/authority.sock",
          max_connect_retries: 1,
          connect_retry_delay_ms: 50,
        },
      },
    });
    fs.writeFileSync(
      paths.workspaceConfigPath,
      [
        `schema_version = "${CLI_CONFIG_SCHEMA_VERSION}"`,
        'active_profile = "local"',
        "",
        "[profiles.local]",
        'workspace_root = "/workspace/config/workspace"',
        'socket_path = "/workspace/config.sock"',
        "max_connect_retries = 3",
      ].join("\n"),
      "utf8",
    );

    const resolved = resolveCliConfig(
      cwd,
      {
        jsonOutput: false,
        configRoot,
        workspaceRoot,
        socketPath: path.join(root, "runtime.sock"),
        rest: [],
      },
      {
        AGENTGIT_ROOT: path.join(root, "env-workspace"),
        AGENTGIT_SOCKET_PATH: path.join(root, "env.sock"),
      },
    );

    expect(resolved.active_profile).toBe("local");
    expect(resolved.workspace_root.value).toBe(path.resolve(path.join(root, "runtime-workspace")));
    expect(resolved.workspace_root.source).toBe("runtime_flag:workspace_root");
    expect(resolved.socket_path.value).toBe(path.resolve(path.join(root, "runtime.sock")));
    expect(resolved.socket_path.source).toBe("runtime_flag:socket_path");
    expect(resolved.connect_timeout_ms.value).toBe(1000);
    expect(resolved.response_timeout_ms.value).toBe(5000);
    expect(resolved.max_connect_retries.value).toBe(3);
    expect(resolved.max_connect_retries.source).toBe("workspace_profile:local");
    expect(resolved.connect_retry_delay_ms.value).toBe(50);
    expect(resolved.connect_retry_delay_ms.source).toBe("user_profile:local");
  });

  it("supports user profile lifecycle helpers and active profile lookup", () => {
    const root = createTempRoot();
    const cwd = path.join(root, "cwd");
    const configRoot = path.join(root, "config");
    let config = {
      schema_version: CLI_CONFIG_SCHEMA_VERSION,
      profiles: {},
    };

    config = upsertUserProfile(config, "Local", {
      workspace_root: "/tmp/workspace",
      socket_path: "/tmp/authority.sock",
    });
    config = setActiveUserProfile(config, "local");
    config = upsertUserProfile(config, "audit", {
      workspace_root: "/tmp/audit",
      socket_path: "/tmp/audit.sock",
    });

    const userConfigPath = path.join(configRoot, "authority-cli.toml");
    writeUserConfig(userConfigPath, config);

    const resolved = resolveCliConfig(
      cwd,
      {
        jsonOutput: false,
        configRoot,
        rest: [],
      },
      {},
    );
    const selected = getProfileFromResolvedConfig(resolved);

    expect(selected).not.toBeNull();
    expect(selected?.name).toBe("local");
    expect(selected?.profile.socket_path).toBe("/tmp/authority.sock");

    const removed = removeUserProfile(config, "audit");
    expect(removed.profiles?.audit).toBeUndefined();
    expect(removed.active_profile).toBe("local");
  });

  it("writes the user config with owner-only permissions", () => {
    const root = createTempRoot();
    const userConfigPath = path.join(root, "config", "authority-cli.toml");

    writeUserConfig(userConfigPath, {
      schema_version: CLI_CONFIG_SCHEMA_VERSION,
      profiles: {
        local: {
          workspace_root: "/tmp/workspace",
          socket_path: "/tmp/authority.sock",
        },
      },
    });

    expect(fs.statSync(userConfigPath).mode & 0o777).toBe(0o600);
  });

  it("keeps the active profile workspace when INIT_CWD is present", () => {
    const root = createTempRoot();
    const cwd = path.join(root, "cwd");
    const configRoot = path.join(root, "config");
    const userConfigPath = path.join(configRoot, "authority-cli.toml");

    writeUserConfig(userConfigPath, {
      schema_version: CLI_CONFIG_SCHEMA_VERSION,
      active_profile: "local",
      profiles: {
        local: {
          workspace_root: "/tmp/profile-workspace",
          socket_path: "/tmp/profile.sock",
        },
      },
    });

    const resolved = resolveCliConfig(
      cwd,
      {
        jsonOutput: false,
        configRoot,
        rest: [],
      },
      {
        INIT_CWD: "/tmp/init-cwd-noise",
      },
    );

    expect(resolved.workspace_root.value).toBe("/tmp/profile-workspace");
    expect(resolved.workspace_root.source).toBe("user_profile:local");
  });

  it("reports invalid TOML during validation", () => {
    const root = createTempRoot();
    const cwd = path.join(root, "cwd");
    const workspaceRoot = path.join(root, "workspace");
    const configRoot = path.join(root, "config");
    const paths = createCliConfigPaths(cwd, {}, configRoot, workspaceRoot);

    fs.mkdirSync(path.dirname(paths.workspaceConfigPath), { recursive: true });
    fs.writeFileSync(paths.workspaceConfigPath, "profiles = [", "utf8");

    const validation = validateCliConfig(cwd, { configRoot, workspaceRoot }, {});

    expect(validation.valid).toBe(false);
    expect(validation.issues[0]).toContain("Workspace config invalid:");
  });
});
