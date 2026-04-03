import fs from "node:fs";
import path from "node:path";

import * as TOML from "@iarna/toml";
import type { AuthorityClient } from "@agentgit/authority-sdk";
import { type PolicyConfig, PolicyConfigSchema, type PolicyRule } from "@agentgit/schemas";

import { inputError } from "./cli-contract.js";
import { bulletList, joinOrNone, lines } from "./formatters/core.js";

type EffectivePolicyResult = Awaited<ReturnType<AuthorityClient["getEffectivePolicy"]>>;
type ExplainPolicyActionResult = Awaited<ReturnType<AuthorityClient["explainPolicyAction"]>>;
type PolicyCalibrationReportResult = Awaited<ReturnType<AuthorityClient["getPolicyCalibrationReport"]>>;
type PolicyThresholdRecommendationsResult = Awaited<ReturnType<AuthorityClient["getPolicyThresholdRecommendations"]>>;
type PolicyThresholdReplayResult = Awaited<ReturnType<AuthorityClient["replayPolicyThresholds"]>>;

export interface PolicyValidationResult {
  valid: boolean;
  issues: string[];
  normalized_config: PolicyConfig | null;
  compiled_policy: {
    rules: PolicyRule[];
  } | null;
}

export interface PolicyDiffResult {
  comparison_mode: "candidate_overlay";
  effective_profile_name: string;
  candidate_profile_name: string;
  effective_policy_version: string;
  candidate_policy_version: string;
  threshold_additions: Array<{ action_family: string; ask_below: number }>;
  threshold_changes: Array<{ action_family: string; current_ask_below: number; candidate_ask_below: number }>;
  threshold_unchanged_count: number;
  added_rule_ids: string[];
  changed_rule_ids: string[];
  unchanged_rule_ids: string[];
  omitted_effective_rule_count: number;
}

export interface PolicyThresholdPatchResult {
  generated_at: string;
  effective_policy_profile: string;
  run_id: string | null;
  min_samples: number;
  direction_filter: "tighten" | "relax" | "all";
  included_recommendations: Array<{
    action_family: string;
    current_ask_below: number | null;
    recommended_ask_below: number | null;
    direction: "tighten" | "relax" | "hold";
    rationale: string;
  }>;
  patch_toml: string;
  report_only: true;
  replay: {
    replayable_samples: number;
    skipped_samples: number;
    changed_decisions: number;
    approvals_reduced: number;
    approvals_increased: number;
    historically_denied_auto_allowed: number;
    historically_allowed_newly_gated: number;
  } | null;
}

export function loadPolicyDocument(policyPath: string): unknown {
  const resolvedPath = path.resolve(policyPath);
  const document = fs.readFileSync(resolvedPath, "utf8");
  return resolvedPath.endsWith(".json") ? JSON.parse(document) : TOML.parse(document);
}

export function validatePolicyConfigDocument(document: unknown): PolicyValidationResult {
  const parsed = PolicyConfigSchema.safeParse(document);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) =>
        issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      ),
      normalized_config: null,
      compiled_policy: null,
    };
  }

  return {
    valid: true,
    issues: [],
    normalized_config: parsed.data,
    compiled_policy: {
      rules: parsed.data.rules,
    },
  };
}

export function loadPolicyThresholdCandidates(policyPath: string): PolicyThresholdReplayResult["candidate_thresholds"] {
  const validation = validatePolicyConfigDocument(loadPolicyDocument(policyPath));
  if (!validation.valid || !validation.normalized_config) {
    throw inputError(`Invalid policy config at ${path.resolve(policyPath)}.`, {
      issues: validation.issues,
    });
  }

  return [...(validation.normalized_config.thresholds?.low_confidence ?? [])].sort((left, right) =>
    left.action_family.localeCompare(right.action_family),
  );
}

function stableJson(value: unknown): string {
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

export function buildPolicyDiffResult(
  effectivePolicy: EffectivePolicyResult,
  candidateConfig: NonNullable<PolicyValidationResult["normalized_config"]>,
): PolicyDiffResult {
  const effectiveThresholds = new Map(
    (effectivePolicy.policy.thresholds?.low_confidence ?? []).map((entry) => [entry.action_family, entry.ask_below]),
  );
  const candidateThresholds = candidateConfig.thresholds?.low_confidence ?? [];
  const thresholdAdditions: PolicyDiffResult["threshold_additions"] = [];
  const thresholdChanges: PolicyDiffResult["threshold_changes"] = [];
  let thresholdUnchangedCount = 0;

  for (const threshold of candidateThresholds) {
    const current = effectiveThresholds.get(threshold.action_family);
    if (current === undefined) {
      thresholdAdditions.push({
        action_family: threshold.action_family,
        ask_below: threshold.ask_below,
      });
      continue;
    }

    if (current === threshold.ask_below) {
      thresholdUnchangedCount += 1;
      continue;
    }

    thresholdChanges.push({
      action_family: threshold.action_family,
      current_ask_below: current,
      candidate_ask_below: threshold.ask_below,
    });
  }

  const effectiveRules = new Map(effectivePolicy.policy.rules.map((rule) => [rule.rule_id, rule]));
  const addedRuleIds: string[] = [];
  const changedRuleIds: string[] = [];
  const unchangedRuleIds: string[] = [];

  for (const rule of candidateConfig.rules) {
    const current = effectiveRules.get(rule.rule_id);
    if (!current) {
      addedRuleIds.push(rule.rule_id);
      continue;
    }

    if (stableJson(current) === stableJson(rule)) {
      unchangedRuleIds.push(rule.rule_id);
    } else {
      changedRuleIds.push(rule.rule_id);
    }
  }

  return {
    comparison_mode: "candidate_overlay",
    effective_profile_name: effectivePolicy.summary.profile_name,
    candidate_profile_name: candidateConfig.profile_name,
    effective_policy_version: effectivePolicy.policy.policy_version,
    candidate_policy_version: candidateConfig.policy_version,
    threshold_additions: thresholdAdditions.sort((left, right) =>
      left.action_family.localeCompare(right.action_family),
    ),
    threshold_changes: thresholdChanges.sort((left, right) => left.action_family.localeCompare(right.action_family)),
    threshold_unchanged_count: thresholdUnchangedCount,
    added_rule_ids: addedRuleIds.sort(),
    changed_rule_ids: changedRuleIds.sort(),
    unchanged_rule_ids: unchangedRuleIds.sort(),
    omitted_effective_rule_count: Math.max(0, effectivePolicy.policy.rules.length - candidateConfig.rules.length),
  };
}

export function renderThresholdPatch(
  result: PolicyThresholdRecommendationsResult,
  directionFilter: "tighten" | "relax" | "all",
  replay: PolicyThresholdReplayResult | null = null,
): PolicyThresholdPatchResult {
  const includedRecommendations = result.recommendations
    .filter((entry) => entry.requires_policy_update)
    .filter((entry) => directionFilter === "all" || entry.direction === directionFilter)
    .filter((entry) => entry.recommended_ask_below !== null)
    .map((entry) => ({
      action_family: entry.action_family,
      current_ask_below: entry.current_ask_below,
      recommended_ask_below: entry.recommended_ask_below,
      direction: entry.direction,
      rationale: entry.rationale,
    }))
    .sort((left, right) => left.action_family.localeCompare(right.action_family));

  const patchLines =
    includedRecommendations.length === 0
      ? [
          "# No threshold changes matched the current recommendation filter.",
          "# Review the recommendation report before making manual policy edits.",
        ]
      : [
          "# Suggested threshold patch (report only; review before applying)",
          "[thresholds]",
          "low_confidence = [",
          ...includedRecommendations.map(
            (entry) =>
              `  { action_family = ${JSON.stringify(entry.action_family)}, ask_below = ${entry.recommended_ask_below!.toFixed(3)} },`,
          ),
          "]",
        ];

  return {
    generated_at: result.generated_at,
    effective_policy_profile: result.effective_policy_profile,
    run_id: result.filters.run_id,
    min_samples: result.filters.min_samples,
    direction_filter: directionFilter,
    included_recommendations: includedRecommendations,
    patch_toml: patchLines.join("\n"),
    report_only: true,
    replay: replay
      ? {
          replayable_samples: replay.summary.replayable_samples,
          skipped_samples: replay.summary.skipped_samples,
          changed_decisions: replay.summary.changed_decisions,
          approvals_reduced: replay.summary.approvals_reduced,
          approvals_increased: replay.summary.approvals_increased,
          historically_denied_auto_allowed: replay.summary.historically_denied_auto_allowed,
          historically_allowed_newly_gated: replay.summary.historically_allowed_newly_gated,
        }
      : null,
  };
}

export function formatEffectivePolicy(result: EffectivePolicyResult): string {
  const thresholdLines = result.policy.thresholds?.low_confidence.length
    ? result.policy.thresholds.low_confidence
        .map((threshold) => `${threshold.action_family}: ask_below=${threshold.ask_below.toFixed(3)}`)
        .join("\n")
    : "none";
  const sourceLines =
    result.summary.loaded_sources.length === 0
      ? "none"
      : result.summary.loaded_sources
          .map(
            (source) =>
              `${source.scope}: ${source.profile_name}@${source.policy_version} (${source.rule_count} rule${source.rule_count === 1 ? "" : "s"})${source.path ? ` [${source.path}]` : ""}`,
          )
          .join("\n");
  const ruleLines =
    result.policy.rules.length === 0
      ? "none"
      : result.policy.rules
          .map(
            (rule) =>
              `${rule.rule_id} [${rule.enforcement_mode}/${rule.decision}] priority=${rule.priority} scope=${rule.binding_scope}`,
          )
          .join("\n");

  return lines(
    "Effective policy",
    `Profile: ${result.summary.profile_name}`,
    `Policy versions: ${joinOrNone(result.summary.policy_versions)}`,
    `Compiled rules: ${result.summary.compiled_rule_count}`,
    `Low-confidence thresholds:\n${thresholdLines}`,
    result.summary.warnings.length === 0 ? "Warnings: none" : `Warnings:\n${bulletList(result.summary.warnings)}`,
    `Sources:\n${sourceLines}`,
    `Rules:\n${ruleLines}`,
  );
}

export function formatPolicyValidation(result: PolicyValidationResult): string {
  return lines(
    "Policy validation",
    `Valid: ${result.valid ? "yes" : "no"}`,
    result.normalized_config ? `Profile: ${result.normalized_config.profile_name}` : null,
    result.normalized_config ? `Policy version: ${result.normalized_config.policy_version}` : null,
    result.compiled_policy ? `Compiled rules: ${result.compiled_policy.rules.length}` : null,
    result.issues.length === 0 ? "Issues: none" : `Issues:\n${bulletList(result.issues)}`,
  );
}

export function formatPolicyCalibrationReport(result: PolicyCalibrationReportResult): string {
  const totalCalibration = result.report.totals.calibration ?? {
    resolved_sample_count: 0,
    pending_sample_count: 0,
    approved_count: 0,
    denied_count: 0,
    mean_confidence: null,
    mean_observed_approval_rate: null,
    brier_score: null,
    expected_calibration_error: null,
    max_calibration_error: null,
    bins: [],
  };
  const totalCalibrationLine =
    totalCalibration.resolved_sample_count === 0
      ? "n/a"
      : `resolved=${totalCalibration.resolved_sample_count}, pending=${totalCalibration.pending_sample_count}, brier=${totalCalibration.brier_score?.toFixed(3) ?? "n/a"}, ece=${totalCalibration.expected_calibration_error?.toFixed(3) ?? "n/a"}, max_gap=${totalCalibration.max_calibration_error?.toFixed(3) ?? "n/a"}`;
  const calibrationBins =
    totalCalibration.bins.length === 0
      ? "none"
      : totalCalibration.bins
          .map(
            (bin) =>
              `${bin.confidence_floor.toFixed(1)}-${bin.confidence_ceiling.toFixed(1)}: n=${bin.sample_count}, resolved=${bin.resolved_sample_count}, approval_rate=${bin.approval_rate?.toFixed(3) ?? "n/a"}, avg_confidence=${bin.average_confidence?.toFixed(3) ?? "n/a"}, gap=${bin.absolute_gap?.toFixed(3) ?? "n/a"}`,
          )
          .join("\n");
  const families =
    result.report.action_families.length === 0
      ? "none"
      : result.report.action_families
          .map((family) => {
            const familyCalibration = family.calibration ?? {
              resolved_sample_count: 0,
              pending_sample_count: 0,
              approved_count: 0,
              denied_count: 0,
              mean_confidence: null,
              mean_observed_approval_rate: null,
              brier_score: null,
              expected_calibration_error: null,
              max_calibration_error: null,
              bins: [],
            };
            const confidence =
              family.confidence.average === null
                ? "n/a"
                : `${family.confidence.average.toFixed(3)} (${family.confidence.min?.toFixed(3) ?? "n/a"}-${family.confidence.max?.toFixed(3) ?? "n/a"})`;
            return [
              `${family.action_family}: ${family.sample_count} sample${family.sample_count === 1 ? "" : "s"}`,
              `  decisions: allow=${family.decisions.allow}, allow_with_snapshot=${family.decisions.allow_with_snapshot}, ask=${family.decisions.ask}, deny=${family.decisions.deny}`,
              `  approvals: requested=${family.approvals.requested}, pending=${family.approvals.pending}, approved=${family.approvals.approved}, denied=${family.approvals.denied}`,
              `  confidence: ${confidence}`,
              `  calibration: resolved=${familyCalibration.resolved_sample_count}, brier=${familyCalibration.brier_score?.toFixed(3) ?? "n/a"}, ece=${familyCalibration.expected_calibration_error?.toFixed(3) ?? "n/a"}, max_gap=${familyCalibration.max_calibration_error?.toFixed(3) ?? "n/a"}`,
              `  snapshot classes: ${family.snapshot_classes.length === 0 ? "none" : family.snapshot_classes.map((entry) => `${entry.key}=${entry.count}`).join(", ")}`,
            ].join("\n");
          })
          .join("\n");
  const sampleSection =
    result.report.samples && result.report.samples.length > 0
      ? `Samples:\n${result.report.samples
          .map(
            (sample) =>
              `${sample.action_id} [${sample.action_family}] decision=${sample.decision} confidence=${sample.normalization_confidence.toFixed(3)} approval=${sample.approval_status ?? "none"} recovery=${sample.recovery_attempted ? (sample.recovery_result ?? "attempted") : "none"}`,
          )
          .join("\n")}`
      : result.report.filters.include_samples
        ? "Samples: none"
        : null;

  return lines(
    "Policy calibration report",
    `Generated: ${result.report.generated_at}`,
    `Run filter: ${result.report.filters.run_id ?? "all"}`,
    `Samples: ${result.report.totals.sample_count}`,
    `Action families: ${result.report.totals.unique_action_families}`,
    `Confidence average: ${result.report.totals.confidence.average === null ? "n/a" : result.report.totals.confidence.average.toFixed(3)}`,
    `Decisions: allow=${result.report.totals.decisions.allow}, allow_with_snapshot=${result.report.totals.decisions.allow_with_snapshot}, ask=${result.report.totals.decisions.ask}, deny=${result.report.totals.decisions.deny}`,
    `Approvals: requested=${result.report.totals.approvals.requested}, pending=${result.report.totals.approvals.pending}, approved=${result.report.totals.approvals.approved}, denied=${result.report.totals.approvals.denied}`,
    `Calibration: ${totalCalibrationLine}`,
    `Calibration bins:\n${calibrationBins}`,
    `Recovery attempted: ${result.report.totals.recovery_attempted_count}`,
    `Samples truncated: ${result.report.samples_truncated ? "yes" : "no"}`,
    `Action families:\n${families}`,
    sampleSection,
  );
}

export function formatPolicyExplanation(result: ExplainPolicyActionResult): string {
  const reasonLines =
    result.policy_outcome.reasons.length === 0
      ? "none"
      : result.policy_outcome.reasons
          .map((reason) => `${reason.code} [${reason.severity}] ${reason.message}`)
          .join("\n");
  const matchedRules =
    result.policy_outcome.policy_context.matched_rules.length === 0
      ? "none"
      : result.policy_outcome.policy_context.matched_rules.join(", ");
  const snapshotLine = result.snapshot_selection
    ? `${result.snapshot_selection.snapshot_class} (${joinOrNone(result.snapshot_selection.reason_codes)})`
    : "none";

  return lines(
    "Policy explanation",
    `Profile: ${result.effective_policy_profile}`,
    `Action family: ${result.action_family}`,
    `Decision: ${result.policy_outcome.decision}`,
    `Normalization confidence: ${result.action.normalization.normalization_confidence.toFixed(3)}`,
    `Low-confidence threshold: ${result.low_confidence_threshold === null ? "none" : result.low_confidence_threshold.toFixed(3)}`,
    `Confidence-triggered: ${result.confidence_triggered ? "yes" : "no"}`,
    `Matched rules: ${matchedRules}`,
    `Snapshot selection: ${snapshotLine}`,
    `Reasons:\n${reasonLines}`,
  );
}

export function formatPolicyThresholdRecommendations(result: PolicyThresholdRecommendationsResult): string {
  const recommendationLines =
    result.recommendations.length === 0
      ? "none"
      : result.recommendations
          .map((entry) => {
            const thresholdLine =
              entry.recommended_ask_below === null
                ? "none"
                : `${entry.current_ask_below === null ? "unset" : entry.current_ask_below.toFixed(3)} -> ${entry.recommended_ask_below.toFixed(3)}`;
            return [
              `${entry.action_family}: ${entry.direction}`,
              `  threshold: ${thresholdLine}`,
              `  samples: ${entry.sample_count}`,
              `  approvals: requested=${entry.approvals_requested}, approved=${entry.approvals_approved}, denied=${entry.approvals_denied}`,
              `  confidence: observed=${entry.observed_confidence_min?.toFixed(3) ?? "n/a"}-${entry.observed_confidence_max?.toFixed(3) ?? "n/a"}, denied_max=${entry.denied_confidence_max?.toFixed(3) ?? "n/a"}, approved_min=${entry.approved_confidence_min?.toFixed(3) ?? "n/a"}`,
              `  policy update required: ${entry.requires_policy_update ? "yes" : "no"}`,
              `  rationale: ${entry.rationale}`,
            ].join("\n");
          })
          .join("\n");

  return lines(
    "Policy threshold recommendations",
    `Generated: ${result.generated_at}`,
    `Profile: ${result.effective_policy_profile}`,
    `Run filter: ${result.filters.run_id ?? "all"}`,
    `Minimum samples: ${result.filters.min_samples}`,
    "Report only: yes",
    `Recommendations:\n${recommendationLines}`,
  );
}

export function formatPolicyThresholdReplay(result: PolicyThresholdReplayResult): string {
  const familyLines =
    result.action_families.length === 0
      ? "none"
      : result.action_families
          .map((family) =>
            [
              `${family.action_family}: replayable=${family.replayable_samples}, skipped=${family.skipped_samples}`,
              `  changed=${family.changed_decisions}, unchanged=${family.unchanged_decisions}`,
              `  approvals: current=${family.current_approvals_requested}, candidate=${family.candidate_approvals_requested}, reduced=${family.approvals_reduced}, increased=${family.approvals_increased}`,
              `  historical risk: denied_auto_allowed=${family.historically_denied_auto_allowed}, allowed_newly_gated=${family.historically_allowed_newly_gated}`,
            ].join("\n"),
          )
          .join("\n");
  const changedSampleLines =
    result.changed_samples && result.changed_samples.length > 0
      ? result.changed_samples
          .map(
            (sample) =>
              `${sample.action_id} [${sample.action_family}] ${sample.current_decision} -> ${sample.candidate_decision} (${sample.change_kind}, confidence=${sample.confidence_score.toFixed(3)})`,
          )
          .join("\n")
      : result.filters.include_changed_samples
        ? "none"
        : null;

  return lines(
    "Policy threshold replay",
    `Generated: ${result.generated_at}`,
    `Profile: ${result.effective_policy_profile}`,
    `Run filter: ${result.filters.run_id ?? "all"}`,
    `Candidate thresholds: ${result.candidate_thresholds.length === 0 ? "none" : result.candidate_thresholds.map((entry) => `${entry.action_family}=${entry.ask_below.toFixed(3)}`).join(", ")}`,
    `Replayable samples: ${result.summary.replayable_samples}`,
    `Skipped samples: ${result.summary.skipped_samples}`,
    `Changed decisions: ${result.summary.changed_decisions}`,
    `Current approvals: ${result.summary.current_approvals_requested}`,
    `Candidate approvals: ${result.summary.candidate_approvals_requested}`,
    `Approvals reduced: ${result.summary.approvals_reduced}`,
    `Approvals increased: ${result.summary.approvals_increased}`,
    `Historical risk: denied_auto_allowed=${result.summary.historically_denied_auto_allowed}, approved_auto_allowed=${result.summary.historically_approved_auto_allowed}, allowed_newly_gated=${result.summary.historically_allowed_newly_gated}`,
    `Current-vs-recorded: matches=${result.summary.current_matches_recorded}, diverges=${result.summary.current_diverges_from_recorded}`,
    `Action families:\n${familyLines}`,
    changedSampleLines ? `Changed samples:\n${changedSampleLines}` : null,
  );
}

export function formatPolicyDiff(result: PolicyDiffResult): string {
  const thresholdAdditionLines =
    result.threshold_additions.length === 0
      ? "none"
      : result.threshold_additions
          .map((entry) => `${entry.action_family}: add ask_below=${entry.ask_below.toFixed(3)}`)
          .join("\n");
  const thresholdChangeLines =
    result.threshold_changes.length === 0
      ? "none"
      : result.threshold_changes
          .map(
            (entry) =>
              `${entry.action_family}: ${entry.current_ask_below.toFixed(3)} -> ${entry.candidate_ask_below.toFixed(3)}`,
          )
          .join("\n");

  return lines(
    "Policy diff",
    `Comparison mode: ${result.comparison_mode}`,
    `Effective profile: ${result.effective_profile_name} @ ${result.effective_policy_version}`,
    `Candidate profile: ${result.candidate_profile_name} @ ${result.candidate_policy_version}`,
    `Threshold additions:\n${thresholdAdditionLines}`,
    `Threshold changes:\n${thresholdChangeLines}`,
    `Thresholds unchanged: ${result.threshold_unchanged_count}`,
    `Rule additions: ${joinOrNone(result.added_rule_ids)}`,
    `Rule changes: ${joinOrNone(result.changed_rule_ids)}`,
    `Rule unchanged: ${joinOrNone(result.unchanged_rule_ids)}`,
    `Effective rules omitted by candidate overlay: ${result.omitted_effective_rule_count}`,
    "Note: this compares the candidate file as an overlay against the current effective policy; rules not mentioned by the candidate may still exist from other loaded sources.",
  );
}

export function formatPolicyThresholdPatch(result: PolicyThresholdPatchResult): string {
  const included =
    result.included_recommendations.length === 0
      ? "none"
      : result.included_recommendations
          .map(
            (entry) =>
              `${entry.action_family}: ${entry.direction} ${entry.current_ask_below === null ? "unset" : entry.current_ask_below.toFixed(3)} -> ${entry.recommended_ask_below?.toFixed(3) ?? "none"}`,
          )
          .join("\n");
  const replayLine = result.replay
    ? `Replay summary: replayable=${result.replay.replayable_samples}, skipped=${result.replay.skipped_samples}, changed=${result.replay.changed_decisions}, approvals_reduced=${result.replay.approvals_reduced}, approvals_increased=${result.replay.approvals_increased}, denied_auto_allowed=${result.replay.historically_denied_auto_allowed}, allowed_newly_gated=${result.replay.historically_allowed_newly_gated}`
    : null;

  return lines(
    "Policy threshold patch",
    `Generated: ${result.generated_at}`,
    `Profile: ${result.effective_policy_profile}`,
    `Run filter: ${result.run_id ?? "all"}`,
    `Minimum samples: ${result.min_samples}`,
    `Direction filter: ${result.direction_filter}`,
    `Report only: ${result.report_only ? "yes" : "no"}`,
    `Included recommendations:\n${included}`,
    replayLine,
    `Patch:\n${result.patch_toml}`,
    "Apply step: review this patch and merge it into your policy TOML manually.",
  );
}
