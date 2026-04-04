import { AuthorityClient } from "@agentgit/authority-sdk";

import { inputError, usageError } from "../cli-contract.js";
import {
  type CliResolvedConfig,
  readUserConfig,
  setActiveUserProfile,
  upsertUserProfile,
  writeUserConfig,
} from "../cli-config.js";
import { shiftCommandValue } from "../parsers/common.js";
import { buildDoctorResult } from "./doctor.js";
import type { InitCommandResult } from "./lifecycle-types.js";

export function parseInitCommandOptions(args: string[]): {
  profileName: string;
  force: boolean;
} {
  let productionMode = false;
  let profileName = "production";
  let force = false;
  const rest = [...args];

  while (rest.length > 0) {
    const current = rest.shift()!;
    switch (current) {
      case "--production":
        productionMode = true;
        break;
      case "--profile-name":
        profileName = shiftCommandValue(rest, "--profile-name");
        break;
      case "--force":
        force = true;
        break;
      default:
        throw inputError(`Unknown init flag: ${current}`, {
          flag: current,
        });
    }
  }

  if (!productionMode) {
    throw usageError("Usage: agentgit-authority [global-flags] init --production [--profile-name <name>] [--force]");
  }

  return {
    profileName,
    force,
  };
}

export async function runInitProductionCommand(
  client: AuthorityClient,
  resolvedConfig: CliResolvedConfig,
  options: {
    profileName: string;
    force: boolean;
  },
  cliVersion: string,
): Promise<InitCommandResult> {
  const userConfig = readUserConfig(resolvedConfig.paths.configRoot, process.cwd(), process.env);
  const existingProfile = userConfig.config.profiles?.[options.profileName];
  if (existingProfile && !options.force) {
    throw inputError(
      `Profile ${options.profileName} already exists in ${userConfig.path}. Re-run with --force to overwrite it.`,
      {
        profile: options.profileName,
        config_path: userConfig.path,
      },
    );
  }

  const configured = upsertUserProfile(userConfig.config, options.profileName, {
    socket_path: resolvedConfig.socket_path.value,
    workspace_root: resolvedConfig.workspace_root.value,
    connect_timeout_ms: resolvedConfig.connect_timeout_ms.value,
    response_timeout_ms: resolvedConfig.response_timeout_ms.value,
    max_connect_retries: resolvedConfig.max_connect_retries.value,
    connect_retry_delay_ms: resolvedConfig.connect_retry_delay_ms.value,
  });
  const activated = setActiveUserProfile(configured, options.profileName);
  writeUserConfig(userConfig.path, activated);

  const doctor = await buildDoctorResult(client, resolvedConfig, cliVersion);
  return {
    mode: "production",
    profile_name: options.profileName,
    config_path: userConfig.path,
    profile_created: !existingProfile,
    profile_overwritten: Boolean(existingProfile),
    readiness_passed: doctor.checks.every((check) => check.status !== "fail"),
    doctor,
  };
}
