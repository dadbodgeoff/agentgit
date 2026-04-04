import fs from "node:fs";
import path from "node:path";

import { inputError } from "../cli-contract.js";
import {
  type CliProfileRecord,
  type CliResolvedConfig,
  readUserConfig,
  setActiveUserProfile,
  upsertUserProfile,
  writeUserConfig,
} from "../cli-config.js";
import { shiftCommandValue } from "../parsers/common.js";
import { buildDaemonRuntimeEnvironment } from "./daemon.js";
import type { SetupCommandResult } from "./lifecycle-types.js";

function profileValuesEqual(left: CliProfileRecord | undefined, right: CliProfileRecord): boolean {
  return (
    (left?.socket_path ?? undefined) === right.socket_path &&
    (left?.workspace_root ?? undefined) === right.workspace_root &&
    (left?.connect_timeout_ms ?? undefined) === right.connect_timeout_ms &&
    (left?.response_timeout_ms ?? undefined) === right.response_timeout_ms &&
    (left?.max_connect_retries ?? undefined) === right.max_connect_retries &&
    (left?.connect_retry_delay_ms ?? undefined) === right.connect_retry_delay_ms
  );
}

function ensureSetupDirectories(daemonEnv: NodeJS.ProcessEnv, configRoot: string): string[] {
  const created = new Set<string>();

  const ensureDir = (value: string | undefined, kind: "dir" | "file" | "unix-endpoint" = "dir") => {
    if (!value) {
      return;
    }

    const target =
      kind === "dir"
        ? value
        : kind === "unix-endpoint"
          ? value.startsWith("unix:")
            ? path.dirname(value.slice("unix:".length))
            : null
          : path.dirname(value);
    if (!target) {
      return;
    }

    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
      created.add(target);
    }
  };

  ensureDir(configRoot);
  ensureDir(path.resolve(daemonEnv.AGENTGIT_ROOT ?? process.cwd(), ".agentgit"));
  ensureDir(daemonEnv.AGENTGIT_SOCKET_PATH, "file");
  ensureDir(daemonEnv.AGENTGIT_JOURNAL_PATH, "file");
  ensureDir(daemonEnv.AGENTGIT_SNAPSHOT_ROOT);
  ensureDir(daemonEnv.AGENTGIT_MCP_REGISTRY_PATH, "file");
  ensureDir(daemonEnv.AGENTGIT_MCP_SECRET_STORE_PATH, "file");
  ensureDir(daemonEnv.AGENTGIT_MCP_SECRET_KEY_PATH, "file");
  ensureDir(daemonEnv.AGENTGIT_MCP_HOST_POLICY_PATH, "file");
  ensureDir(daemonEnv.AGENTGIT_MCP_CONCURRENCY_LEASE_PATH, "file");
  ensureDir(daemonEnv.AGENTGIT_MCP_HOSTED_WORKER_ENDPOINT, "unix-endpoint");
  ensureDir(daemonEnv.AGENTGIT_MCP_HOSTED_WORKER_ATTESTATION_KEY_PATH, "file");
  ensureDir(daemonEnv.AGENTGIT_POLICY_WORKSPACE_CONFIG_PATH, "file");
  ensureDir(daemonEnv.AGENTGIT_POLICY_CALIBRATION_CONFIG_PATH, "file");
  ensureDir(daemonEnv.AGENTGIT_POLICY_GLOBAL_CONFIG_PATH, "file");

  return [...created].sort();
}

function setupCommandExample(configRoot: string, command: string): string {
  return `agentgit-authority --config-root ${JSON.stringify(configRoot)} ${command}`;
}

export function parseSetupCommandOptions(args: string[]): {
  profileName: string;
  force: boolean;
} {
  let profileName = "local";
  let force = false;
  const rest = [...args];

  while (rest.length > 0) {
    const current = rest.shift()!;
    switch (current) {
      case "--profile-name":
        profileName = shiftCommandValue(rest, "--profile-name");
        break;
      case "--force":
        force = true;
        break;
      default:
        throw inputError(`Unknown setup flag: ${current}`, {
          flag: current,
        });
    }
  }

  return {
    profileName,
    force,
  };
}

export function runSetupCommand(
  resolvedConfig: CliResolvedConfig,
  options: {
    profileName: string;
    force: boolean;
  },
): SetupCommandResult {
  const userConfig = readUserConfig(resolvedConfig.paths.configRoot, process.cwd(), process.env);
  const nextProfile: CliProfileRecord = {
    socket_path: resolvedConfig.socket_path.value,
    workspace_root: resolvedConfig.workspace_root.value,
    connect_timeout_ms: resolvedConfig.connect_timeout_ms.value,
    response_timeout_ms: resolvedConfig.response_timeout_ms.value,
    max_connect_retries: resolvedConfig.max_connect_retries.value,
    connect_retry_delay_ms: resolvedConfig.connect_retry_delay_ms.value,
  };
  const existingProfile = userConfig.config.profiles?.[options.profileName];

  if (existingProfile && !options.force && !profileValuesEqual(existingProfile, nextProfile)) {
    throw inputError(
      `Profile ${options.profileName} already exists in ${userConfig.path} with different settings. Re-run with --force to overwrite it.`,
      {
        profile: options.profileName,
        config_path: userConfig.path,
      },
    );
  }

  const configured = upsertUserProfile(userConfig.config, options.profileName, nextProfile);
  const activated = setActiveUserProfile(configured, options.profileName);
  writeUserConfig(userConfig.path, activated);

  const daemonEnv = buildDaemonRuntimeEnvironment(resolvedConfig);
  const createdDirectories = ensureSetupDirectories(daemonEnv, resolvedConfig.paths.configRoot);

  return {
    mode: "local",
    profile_name: options.profileName,
    config_path: userConfig.path,
    profile_created: !existingProfile,
    profile_overwritten: Boolean(existingProfile && !profileValuesEqual(existingProfile, nextProfile)),
    created_directories: createdDirectories,
    workspace_root: resolvedConfig.workspace_root.value,
    socket_path: resolvedConfig.socket_path.value,
    daemon_start_command: setupCommandExample(resolvedConfig.paths.configRoot, "daemon start"),
    doctor_command: setupCommandExample(resolvedConfig.paths.configRoot, "doctor"),
  };
}
