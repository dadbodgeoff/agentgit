import path from "node:path";

import { AuthorityClient } from "@agentgit/authority-sdk";

import { CLI_EXIT_CODES, usageError } from "../cli-contract.js";
import { type CliGlobalFlags, type CliResolvedConfig, validateCliConfig } from "../cli-config.js";
import { printResult } from "../cli-output.js";
import {
  cloudRoadmapResult,
  type ConfigShowResult,
  formatCloudRoadmapResult,
  formatConfigShow,
  formatConfigValidation,
  formatHello,
  formatRegisterRun,
  formatVersion,
  versionResult,
} from "../lifecycle.js";
import {
  formatReleaseArtifactVerifyResult,
  parseReleaseVerifyCommandArgs,
  verifyReleaseArtifacts,
} from "../release.js";

const CONNECTED_GENERAL_COMMANDS = new Set(["config", "ping", "register-run"]);

export function tryRunStandaloneGeneralCommand(options: {
  command: string;
  rest: string[];
  flags: CliGlobalFlags;
  jsonOutput: boolean;
  cliVersion: string;
}): boolean {
  const { command, rest, flags, jsonOutput, cliVersion } = options;

  switch (command) {
    case "version": {
      printResult(versionResult(cliVersion), jsonOutput, formatVersion);
      return true;
    }
    case "release-verify-artifacts": {
      const workspaceRootForLocal = path.resolve(flags.workspaceRoot ?? process.cwd());
      const verifyOptions = parseReleaseVerifyCommandArgs(rest, workspaceRootForLocal);
      const result = verifyReleaseArtifacts(verifyOptions);
      printResult(result, jsonOutput, formatReleaseArtifactVerifyResult);
      return true;
    }
    case "cloud-roadmap": {
      if (rest.length > 0) {
        throw usageError("Usage: agentgit-authority [global-flags] cloud-roadmap");
      }
      const result = cloudRoadmapResult();
      printResult(result, jsonOutput, formatCloudRoadmapResult);
      return true;
    }
    case "config": {
      if (rest[0] !== "validate") {
        return false;
      }

      const result = validateCliConfig(process.cwd(), {
        configRoot: flags.configRoot,
        workspaceRoot: flags.workspaceRoot,
      });
      printResult(result, jsonOutput, formatConfigValidation);
      if (!result.valid) {
        process.exitCode = CLI_EXIT_CODES.CONFIG_ERROR;
      }
      return true;
    }
    default:
      return false;
  }
}

export function isConnectedGeneralCommand(command: string): boolean {
  return CONNECTED_GENERAL_COMMANDS.has(command);
}

export async function runConnectedGeneralCommand(options: {
  command: string;
  client: AuthorityClient;
  resolvedConfig: CliResolvedConfig;
  workspaceRoot: string;
  rest: string[];
  jsonOutput: boolean;
}): Promise<void> {
  const { command, client, resolvedConfig, workspaceRoot, rest, jsonOutput } = options;

  switch (command) {
    case "config": {
      const subcommand = rest[0];
      if (subcommand === "show") {
        printResult({ resolved: resolvedConfig } satisfies ConfigShowResult, jsonOutput, formatConfigShow);
        return;
      }

      throw usageError("Usage: agentgit-authority [global-flags] config <show|validate>");
    }
    case "ping": {
      const result = await client.hello([workspaceRoot]);
      printResult(result, jsonOutput, formatHello);
      return;
    }
    case "register-run": {
      const workflowName = rest[0] ?? "cli-run";
      const maxMutatingActions = rest[1] ? Number(rest[1]) : null;
      const maxDestructiveActions = rest[2] ? Number(rest[2]) : null;
      const result = await client.registerRun({
        workflow_name: workflowName,
        agent_framework: "cli",
        agent_name: "agentgit-cli",
        workspace_roots: [workspaceRoot],
        client_metadata: {
          invoked_from: "authority-cli",
        },
        budget_config:
          maxMutatingActions !== null || maxDestructiveActions !== null
            ? {
                max_mutating_actions: Number.isFinite(maxMutatingActions) ? maxMutatingActions : null,
                max_destructive_actions: Number.isFinite(maxDestructiveActions) ? maxDestructiveActions : null,
              }
            : undefined,
      });
      printResult(result, jsonOutput, formatRegisterRun);
      return;
    }
    default:
      throw usageError(`Unsupported connected general command: ${command}`);
  }
}
