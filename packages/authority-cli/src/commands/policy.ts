import { AuthorityClient } from "@agentgit/authority-sdk";

import { CLI_EXIT_CODES, inputError, usageError } from "../cli-contract.js";
import { printResult } from "../cli-output.js";
import { parseIntegerFlag, parseJsonArgOrFile, shiftCommandValue } from "../parsers/common.js";
import {
  buildPolicyDiffResult,
  formatEffectivePolicy,
  formatPolicyCalibrationReport,
  formatPolicyDiff,
  formatPolicyExplanation,
  formatPolicyThresholdPatch,
  formatPolicyThresholdRecommendations,
  formatPolicyThresholdReplay,
  formatPolicyValidation,
  loadPolicyDocument,
  loadPolicyThresholdCandidates,
  renderThresholdPatch,
  validatePolicyConfigDocument,
} from "../policy.js";

type PolicyThresholdDirection = "tighten" | "relax" | "all";

function parsePositiveIntegerFlag(value: string, flag: string): number {
  const parsed = parseIntegerFlag(value, flag);
  if (parsed <= 0) {
    throw inputError(`${flag} expects a positive integer.`, {
      flag,
      value: parsed,
    });
  }

  return parsed;
}

function parseThresholdDirection(args: string[], flag: string): PolicyThresholdDirection {
  const parsed = shiftCommandValue(args, flag);
  if (parsed !== "tighten" && parsed !== "relax" && parsed !== "all") {
    throw inputError(`${flag} expects one of: tighten, relax, all.`, {
      flag,
      value: parsed,
    });
  }

  return parsed;
}

function runPolicyValidate(rest: string[], jsonOutput: boolean): void {
  const policyPath = rest[1];
  if (!policyPath) {
    throw usageError("Usage: agentgit-authority [global-flags] policy validate <path>");
  }

  const result = validatePolicyConfigDocument(loadPolicyDocument(policyPath));
  printResult(result, jsonOutput, formatPolicyValidation);
  if (!result.valid) {
    process.exitCode = CLI_EXIT_CODES.CONFIG_ERROR;
  }
}

export function tryRunStandalonePolicyCommand(rest: string[], jsonOutput: boolean): boolean {
  if (rest[0] !== "validate") {
    return false;
  }

  runPolicyValidate(rest, jsonOutput);
  return true;
}

export async function runPolicyCommand(
  client: AuthorityClient,
  rest: string[],
  jsonOutput: boolean,
): Promise<void> {
  const subcommand = rest[0];

  if (subcommand === "show") {
    const result = await client.getEffectivePolicy();
    printResult(result, jsonOutput, formatEffectivePolicy);
    return;
  }

  if (subcommand === "validate") {
    runPolicyValidate(rest, jsonOutput);
    return;
  }

  if (subcommand === "diff") {
    const policyPath = rest[1];
    if (!policyPath) {
      throw usageError("Usage: agentgit-authority [global-flags] policy diff <path>");
    }

    const validation = validatePolicyConfigDocument(loadPolicyDocument(policyPath));
    if (!validation.valid || !validation.normalized_config) {
      throw inputError(
        `Policy diff requires a valid policy file: ${validation.issues.join("; ") || "unknown validation error"}`,
      );
    }

    const effectivePolicy = await client.getEffectivePolicy();
    const result = buildPolicyDiffResult(effectivePolicy, validation.normalized_config);
    printResult(result, jsonOutput, formatPolicyDiff);
    return;
  }

  if (subcommand === "explain") {
    const definitionArg = rest[1];
    if (!definitionArg) {
      throw usageError("Usage: agentgit-authority [global-flags] policy explain <attempt-json-or-path>");
    }

    const result = await client.explainPolicyAction(
      parseJsonArgOrFile(definitionArg) as Parameters<AuthorityClient["explainPolicyAction"]>[0],
    );
    printResult(result, jsonOutput, formatPolicyExplanation);
    return;
  }

  if (subcommand === "calibration-report") {
    const args = rest.slice(1);
    let runId: string | undefined;
    let includeSamples = false;
    let sampleLimit: number | undefined;

    while (args.length > 0) {
      const current = args.shift()!;
      switch (current) {
        case "--run-id":
          runId = shiftCommandValue(args, "--run-id");
          break;
        case "--include-samples":
          includeSamples = true;
          break;
        case "--sample-limit":
          sampleLimit = parsePositiveIntegerFlag(shiftCommandValue(args, "--sample-limit"), "--sample-limit");
          break;
        default:
          throw inputError(`Unknown policy calibration-report flag: ${current}`, {
            flag: current,
          });
      }
    }

    const result = await client.getPolicyCalibrationReport({
      ...(runId ? { run_id: runId } : {}),
      include_samples: includeSamples,
      ...(sampleLimit !== undefined ? { sample_limit: sampleLimit } : {}),
    });
    printResult(result, jsonOutput, formatPolicyCalibrationReport);
    return;
  }

  if (subcommand === "recommend-thresholds") {
    const args = rest.slice(1);
    let runId: string | undefined;
    let minSamples: number | undefined;

    while (args.length > 0) {
      const current = args.shift()!;
      switch (current) {
        case "--run-id":
          runId = shiftCommandValue(args, "--run-id");
          break;
        case "--min-samples":
          minSamples = parsePositiveIntegerFlag(shiftCommandValue(args, "--min-samples"), "--min-samples");
          break;
        default:
          throw inputError(`Unknown policy recommend-thresholds flag: ${current}`, {
            flag: current,
          });
      }
    }

    const result = await client.getPolicyThresholdRecommendations({
      ...(runId ? { run_id: runId } : {}),
      ...(minSamples !== undefined ? { min_samples: minSamples } : {}),
    });
    printResult(result, jsonOutput, formatPolicyThresholdRecommendations);
    return;
  }

  if (subcommand === "replay-thresholds") {
    const args = rest.slice(1);
    let runId: string | undefined;
    let minSamples: number | undefined;
    let directionFilter: PolicyThresholdDirection = "all";
    let candidatePolicyPath: string | undefined;
    let includeChangedSamples = false;
    let sampleLimit: number | undefined;

    while (args.length > 0) {
      const current = args.shift()!;
      switch (current) {
        case "--run-id":
          runId = shiftCommandValue(args, "--run-id");
          break;
        case "--candidate-policy":
          candidatePolicyPath = shiftCommandValue(args, "--candidate-policy");
          break;
        case "--min-samples":
          minSamples = parsePositiveIntegerFlag(shiftCommandValue(args, "--min-samples"), "--min-samples");
          break;
        case "--direction":
          directionFilter = parseThresholdDirection(args, "--direction");
          break;
        case "--include-changed-samples":
          includeChangedSamples = true;
          break;
        case "--sample-limit":
          sampleLimit = parsePositiveIntegerFlag(shiftCommandValue(args, "--sample-limit"), "--sample-limit");
          break;
        default:
          throw inputError(`Unknown policy replay-thresholds flag: ${current}`, {
            flag: current,
          });
      }
    }

    const candidateThresholds = candidatePolicyPath
      ? loadPolicyThresholdCandidates(candidatePolicyPath)
      : renderThresholdPatch(
          await client.getPolicyThresholdRecommendations({
            ...(runId ? { run_id: runId } : {}),
            ...(minSamples !== undefined ? { min_samples: minSamples } : {}),
          }),
          directionFilter,
        ).included_recommendations.map((entry) => ({
          action_family: entry.action_family,
          ask_below: entry.recommended_ask_below!,
        }));

    const result = await client.replayPolicyThresholds({
      ...(runId ? { run_id: runId } : {}),
      candidate_thresholds: candidateThresholds,
      ...(includeChangedSamples ? { include_changed_samples: true } : {}),
      ...(sampleLimit !== undefined ? { sample_limit: sampleLimit } : {}),
    });
    printResult(result, jsonOutput, formatPolicyThresholdReplay);
    return;
  }

  if (subcommand === "render-threshold-patch") {
    const args = rest.slice(1);
    let runId: string | undefined;
    let minSamples: number | undefined;
    let directionFilter: PolicyThresholdDirection = "all";

    while (args.length > 0) {
      const current = args.shift()!;
      switch (current) {
        case "--run-id":
          runId = shiftCommandValue(args, "--run-id");
          break;
        case "--min-samples":
          minSamples = parsePositiveIntegerFlag(shiftCommandValue(args, "--min-samples"), "--min-samples");
          break;
        case "--direction":
          directionFilter = parseThresholdDirection(args, "--direction");
          break;
        default:
          throw inputError(`Unknown policy render-threshold-patch flag: ${current}`, {
            flag: current,
          });
      }
    }

    const recommendations = await client.getPolicyThresholdRecommendations({
      ...(runId ? { run_id: runId } : {}),
      ...(minSamples !== undefined ? { min_samples: minSamples } : {}),
    });
    const candidateThresholds = renderThresholdPatch(recommendations, directionFilter).included_recommendations.map(
      (entry) => ({
        action_family: entry.action_family,
        ask_below: entry.recommended_ask_below!,
      }),
    );
    const replay = await client.replayPolicyThresholds({
      ...(runId ? { run_id: runId } : {}),
      candidate_thresholds: candidateThresholds,
    });
    const result = renderThresholdPatch(recommendations, directionFilter, replay);
    printResult(result, jsonOutput, formatPolicyThresholdPatch);
    return;
  }

  throw usageError(
    "Usage: agentgit-authority [global-flags] policy <show|validate <path>|diff <path>|explain <attempt-json-or-path>|calibration-report [--run-id <run-id>] [--include-samples] [--sample-limit <n>]|recommend-thresholds [--run-id <run-id>] [--min-samples <n>]|replay-thresholds [--run-id <run-id>] [--candidate-policy <path>] [--min-samples <n>] [--direction <tighten|relax|all>] [--include-changed-samples] [--sample-limit <n>]|render-threshold-patch [--run-id <run-id>] [--min-samples <n>] [--direction <tighten|relax|all>]>",
  );
}
