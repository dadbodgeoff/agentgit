import path from "node:path";

import { inputError, usageError } from "../cli-contract.js";
import {
  type CliProfileRecord,
  type CliResolvedConfig,
  getProfileFromResolvedConfig,
  listProfileNames,
  readUserConfig,
  removeUserProfile,
  setActiveUserProfile,
  upsertUserProfile,
  writeUserConfig,
} from "../cli-config.js";
import { printResult } from "../cli-output.js";
import { lines } from "../formatters/core.js";
import { formatProfileList } from "../lifecycle.js";
import type { ProfileListResult } from "./lifecycle-types.js";
import { parseIntegerFlag, shiftCommandValue } from "../parsers/common.js";

function parseProfileUpsertArgs(args: string[]): { name: string; values: CliProfileRecord } {
  const [name, ...rest] = args;
  if (!name) {
    throw usageError(
      "Usage: agentgit-authority [global-flags] profile upsert <name> [--socket-path <path>] [--workspace-root <path>] [--connect-timeout-ms <ms>] [--response-timeout-ms <ms>] [--max-connect-retries <count>] [--connect-retry-delay-ms <ms>]",
    );
  }

  const values: CliProfileRecord = {};
  while (rest.length > 0) {
    const current = rest.shift()!;
    switch (current) {
      case "--socket-path":
        values.socket_path = path.resolve(shiftCommandValue(rest, "--socket-path"));
        break;
      case "--workspace-root":
        values.workspace_root = path.resolve(shiftCommandValue(rest, "--workspace-root"));
        break;
      case "--connect-timeout-ms":
        values.connect_timeout_ms = parseIntegerFlag(
          shiftCommandValue(rest, "--connect-timeout-ms"),
          "--connect-timeout-ms",
        );
        break;
      case "--response-timeout-ms":
        values.response_timeout_ms = parseIntegerFlag(
          shiftCommandValue(rest, "--response-timeout-ms"),
          "--response-timeout-ms",
        );
        break;
      case "--max-connect-retries":
        values.max_connect_retries = parseIntegerFlag(
          shiftCommandValue(rest, "--max-connect-retries"),
          "--max-connect-retries",
        );
        break;
      case "--connect-retry-delay-ms":
        values.connect_retry_delay_ms = parseIntegerFlag(
          shiftCommandValue(rest, "--connect-retry-delay-ms"),
          "--connect-retry-delay-ms",
        );
        break;
      default:
        throw inputError(`Unknown profile upsert flag: ${current}`, {
          flag: current,
        });
    }
  }

  return {
    name,
    values,
  };
}

export async function runProfileCommand(
  resolvedConfig: CliResolvedConfig,
  rest: string[],
  jsonOutput: boolean,
): Promise<void> {
  const subcommand = rest[0];
  if (subcommand === "list") {
    const result = {
      active_profile: resolvedConfig.active_profile,
      profiles: listProfileNames(resolvedConfig),
    } satisfies ProfileListResult;
    printResult(result, jsonOutput, formatProfileList);
    return;
  }

  const userConfig = readUserConfig(resolvedConfig.paths.configRoot, process.cwd(), process.env);

  if (subcommand === "show") {
    const selectedProfile = getProfileFromResolvedConfig(resolvedConfig, rest[1]);
    if (!selectedProfile) {
      throw inputError(`Profile ${rest[1] ?? resolvedConfig.active_profile ?? "<none>"} is not configured.`);
    }

    printResult(
      {
        profile: selectedProfile,
      },
      jsonOutput,
      (value: { profile: NonNullable<ReturnType<typeof getProfileFromResolvedConfig>> }) =>
        lines(
          `Profile ${value.profile.name}`,
          `Source: ${value.profile.source}`,
          `Socket path: ${value.profile.profile.socket_path ?? "unset"}`,
          `Workspace root: ${value.profile.profile.workspace_root ?? "unset"}`,
          `Connect timeout: ${value.profile.profile.connect_timeout_ms ?? "unset"}`,
          `Response timeout: ${value.profile.profile.response_timeout_ms ?? "unset"}`,
          `Max connect retries: ${value.profile.profile.max_connect_retries ?? "unset"}`,
          `Connect retry delay: ${value.profile.profile.connect_retry_delay_ms ?? "unset"}`,
        ),
    );
    return;
  }

  if (subcommand === "use") {
    const profileName = rest[1];
    if (!profileName) {
      throw usageError("Usage: agentgit-authority [global-flags] profile use <name>");
    }

    const updated = setActiveUserProfile(userConfig.config, profileName);
    writeUserConfig(userConfig.path, updated);
    printResult(
      {
        active_profile: profileName,
        config_path: userConfig.path,
      },
      jsonOutput,
      (value) => lines(`Active CLI profile: ${value.active_profile}`, `Config: ${value.config_path}`),
    );
    return;
  }

  if (subcommand === "upsert") {
    const parsed = parseProfileUpsertArgs(rest.slice(1));
    const updated = upsertUserProfile(userConfig.config, parsed.name, parsed.values);
    writeUserConfig(userConfig.path, updated);
    printResult(
      {
        profile_name: parsed.name,
        config_path: userConfig.path,
        values: parsed.values,
      },
      jsonOutput,
      (value) => lines(`Updated CLI profile ${value.profile_name}`, `Config: ${value.config_path}`),
    );
    return;
  }

  if (subcommand === "remove") {
    const profileName = rest[1];
    if (!profileName) {
      throw usageError("Usage: agentgit-authority [global-flags] profile remove <name>");
    }

    const updated = removeUserProfile(userConfig.config, profileName);
    writeUserConfig(userConfig.path, updated);
    printResult(
      {
        profile_name: profileName,
        removed: true,
        config_path: userConfig.path,
      },
      jsonOutput,
      (value) => lines(`Removed CLI profile ${value.profile_name}`, `Config: ${value.config_path}`),
    );
    return;
  }

  throw usageError("Usage: agentgit-authority [global-flags] profile <list|show|use|upsert|remove> [...]");
}
