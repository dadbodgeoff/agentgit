import path from "node:path";

import {
  type ActionRecord,
  type ApprovalRequest,
  type CapabilityRecord,
  type GetPolicyThresholdReplayResponsePayload,
  type PolicyCalibrationSample,
  InternalError,
  type McpServerDefinition,
  type PolicyCalibrationReport,
  type PolicyConfig,
  type PolicyLowConfidenceThreshold,
  PolicyConfigSchema,
  type PolicyOutcomeRecord,
  type PolicyPredicate,
  type PolicyRule,
  type PolicyReason,
  type PolicyThresholdRecommendation,
  type RunSummary,
} from "@agentgit/schemas";
import { v7 as uuidv7 } from "uuid";

import { DEFAULT_POLICY_PACK } from "./default-policy-pack.js";

export { DEFAULT_POLICY_PACK } from "./default-policy-pack.js";

const SAFE_FS_WRITE_BYTES = 256 * 1024;

const POLICY_DECISION_STRENGTH: Record<PolicyOutcomeRecord["decision"], number> = {
  deny: 4,
  ask: 3,
  allow_with_snapshot: 2,
  simulate: 1,
  allow: 0,
};

export interface CompiledPolicyRule {
  profile_name: string;
  policy_version: string;
  source_index: number;
  rule_index: number;
  rule: PolicyRule;
}

export interface CompiledPolicyPack {
  profile_name: string;
  policy_versions: string[];
  rules: CompiledPolicyRule[];
  thresholds: {
    low_confidence: Record<string, number>;
  };
}

export interface PolicyThresholdRecommendationOptions {
  min_samples?: number;
  tighten_buffer?: number;
  relax_buffer?: number;
}

export interface PolicyThresholdReplayRecord {
  run_id: string;
  action_id: string;
  evaluated_at: string;
  action_family: string;
  recorded_decision: PolicyCalibrationSample["decision"];
  approval_status: ApprovalRequest["status"] | null;
  confidence_score: number;
  low_confidence_threshold: number | null;
  confidence_triggered: boolean;
  action: ActionRecord | null;
}

export interface PolicyThresholdReplayOptions {
  include_changed_samples?: boolean;
  sample_limit?: number | null;
}

export interface PolicyConfigValidationResult {
  valid: boolean;
  issues: string[];
  normalized_config: PolicyConfig | null;
  compiled_policy: CompiledPolicyPack | null;
}

type ReplayChangeKind =
  | "approval_removed"
  | "approval_added"
  | "unsafe_auto_allow"
  | "historical_allow_now_gated"
  | "decision_changed";

export interface PolicyEvaluationContext {
  run_summary?: Pick<RunSummary, "budget_config" | "budget_usage">;
  mcp_server_registry?: {
    servers: McpServerDefinition[];
  } | null;
  cached_capability_state?: {
    capabilities: CapabilityRecord[];
    degraded_mode_warnings: string[];
    refreshed_at: string;
    stale_after_ms: number;
    is_stale: boolean;
  } | null;
  compiled_policy?: CompiledPolicyPack | null;
}

export const DEFAULT_COMPILED_POLICY_PACK = compilePolicyPack([DEFAULT_POLICY_PACK]);

function createPolicyOutcomeId(): string {
  return `pol_${uuidv7().replaceAll("-", "")}`;
}

function makeOutcome(
  action: ActionRecord,
  decision: PolicyOutcomeRecord["decision"],
  reasons: PolicyReason[],
  matchedRules: string[],
  trustRequirements?: Partial<PolicyOutcomeRecord["trust_requirements"]>,
  policyContext?: Partial<PolicyOutcomeRecord["policy_context"]>,
): PolicyOutcomeRecord {
  return {
    schema_version: "policy-outcome.v1",
    policy_outcome_id: createPolicyOutcomeId(),
    action_id: action.action_id,
    decision,
    reasons,
    trust_requirements: {
      wrapped_path_required: true,
      brokered_credentials_required: trustRequirements?.brokered_credentials_required ?? false,
      direct_credentials_forbidden: trustRequirements?.direct_credentials_forbidden ?? false,
    },
    preconditions: {
      snapshot_required: decision === "allow_with_snapshot",
      approval_required: decision === "ask",
      simulation_supported: false,
    },
    approval: null,
    budget_effects: {
      budget_check: "passed",
      estimated_cost: 0,
      remaining_mutating_actions: null,
      remaining_destructive_actions: null,
    },
    policy_context: {
      matched_rules: matchedRules,
      sticky_decision_applied: false,
      ...policyContext,
    },
    evaluated_at: new Date().toISOString(),
  };
}

function makeRecoveryProofContext(
  policyContext: Pick<
    PolicyOutcomeRecord["policy_context"],
    "recoverability_class" | "recovery_proof_kind" | "recovery_proof_source" | "recovery_proof_scope"
  >,
): Partial<PolicyOutcomeRecord["policy_context"]> {
  return policyContext;
}

function makeCapabilityApprovalOutcome(
  action: ActionRecord,
  reason: PolicyReason,
  matchedRule: string,
  snapshotRequired = false,
  trustRequirements?: Partial<PolicyOutcomeRecord["trust_requirements"]>,
): PolicyOutcomeRecord {
  const outcome = makeOutcome(
    action,
    "ask",
    [reason],
    [matchedRule],
    trustRequirements,
    makeRecoveryProofContext({
      recoverability_class: "unrecoverable_or_degraded",
    }),
  );
  if (snapshotRequired) {
    outcome.preconditions.snapshot_required = true;
  }
  return outcome;
}

function makeDirectCredentialDenyOutcome(
  action: ActionRecord,
  message: string,
  matchedRule: string,
): PolicyOutcomeRecord {
  return makeOutcome(
    action,
    "deny",
    [
      {
        code: "DIRECT_CREDENTIALS_FORBIDDEN",
        severity: "high",
        message,
      },
    ],
    [matchedRule],
    {
      direct_credentials_forbidden: true,
    },
    makeRecoveryProofContext({
      recoverability_class: "unrecoverable_or_degraded",
    }),
  );
}

function makeAutomaticSnapshotOutcome(
  action: ActionRecord,
  reason: PolicyReason,
  matchedRule: string,
  trustRequirements?: Partial<PolicyOutcomeRecord["trust_requirements"]>,
  policyContext?: Partial<PolicyOutcomeRecord["policy_context"]>,
): PolicyOutcomeRecord {
  return makeOutcome(action, "allow_with_snapshot", [reason], [matchedRule], trustRequirements, policyContext);
}

function getFieldValue(record: unknown, fieldPath: string): unknown {
  return fieldPath.split(".").reduce<unknown>((current, segment) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    return (current as Record<string, unknown>)[segment];
  }, record);
}

function evaluateFieldPredicate(predicate: Extract<PolicyPredicate, { type: "field" }>, action: ActionRecord): boolean {
  const actualValue = getFieldValue(action, predicate.field);

  switch (predicate.operator) {
    case "eq":
      return actualValue === predicate.value;
    case "neq":
      return actualValue !== predicate.value;
    case "matches":
      return typeof actualValue === "string" && typeof predicate.value === "string"
        ? new RegExp(predicate.value, "u").test(actualValue)
        : false;
    case "contains":
      return typeof actualValue === "string" && typeof predicate.value === "string"
        ? actualValue.includes(predicate.value)
        : Array.isArray(actualValue)
          ? actualValue.includes(predicate.value)
          : false;
    case "gt":
      return typeof actualValue === "number" && typeof predicate.value === "number"
        ? actualValue > predicate.value
        : false;
    case "gte":
      return typeof actualValue === "number" && typeof predicate.value === "number"
        ? actualValue >= predicate.value
        : false;
    case "lt":
      return typeof actualValue === "number" && typeof predicate.value === "number"
        ? actualValue < predicate.value
        : false;
    case "lte":
      return typeof actualValue === "number" && typeof predicate.value === "number"
        ? actualValue <= predicate.value
        : false;
    case "in":
      return Array.isArray(predicate.value) ? predicate.value.includes(actualValue) : false;
    case "not_in":
      return Array.isArray(predicate.value) ? !predicate.value.includes(actualValue) : false;
    case "exists":
      return predicate.value === false ? actualValue === undefined : actualValue !== undefined;
    default:
      return false;
  }
}

function matchesPolicyPredicate(predicate: PolicyPredicate, action: ActionRecord): boolean {
  switch (predicate.type) {
    case "field":
      return evaluateFieldPredicate(predicate, action);
    case "all":
      return predicate.conditions.every((condition) => matchesPolicyPredicate(condition, action));
    case "any":
      return predicate.conditions.some((condition) => matchesPolicyPredicate(condition, action));
    case "not":
      return !matchesPolicyPredicate(predicate.condition, action);
    default:
      return false;
  }
}

function compareCompiledRules(left: CompiledPolicyRule, right: CompiledPolicyRule): number {
  const decisionDelta =
    POLICY_DECISION_STRENGTH[right.rule.decision as PolicyOutcomeRecord["decision"]] -
    POLICY_DECISION_STRENGTH[left.rule.decision as PolicyOutcomeRecord["decision"]];
  if (decisionDelta !== 0) {
    return decisionDelta;
  }

  const priorityDelta = right.rule.priority - left.rule.priority;
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const sourceDelta = left.source_index - right.source_index;
  if (sourceDelta !== 0) {
    return sourceDelta;
  }

  return left.rule_index - right.rule_index;
}

function enforcementModeStrengthensDecision(rule: PolicyRule): PolicyOutcomeRecord["decision"] | null {
  if (rule.enforcement_mode === "disabled" || rule.enforcement_mode === "audit" || rule.enforcement_mode === "warn") {
    return null;
  }

  if (rule.enforcement_mode === "require_approval") {
    return "ask";
  }

  return rule.decision;
}

function actionFamilyForAction(action: ActionRecord): string {
  return `${action.operation.domain}/${action.operation.kind}`;
}

function actionConfidenceScore(action: ActionRecord): number {
  return action.confidence_assessment?.score ?? action.normalization.normalization_confidence;
}

export function resolvePolicyLowConfidenceThreshold(
  compiledPolicy: CompiledPolicyPack | null | undefined,
  actionFamilyOrAction: string | ActionRecord,
): number | null {
  const lowConfidence =
    compiledPolicy?.thresholds.low_confidence ?? DEFAULT_COMPILED_POLICY_PACK.thresholds.low_confidence;
  const actionFamily =
    typeof actionFamilyOrAction === "string" ? actionFamilyOrAction : actionFamilyForAction(actionFamilyOrAction);
  const domain = actionFamily.includes("/") ? actionFamily.slice(0, actionFamily.indexOf("/")) : actionFamily;

  if (Object.hasOwn(lowConfidence, actionFamily)) {
    return lowConfidence[actionFamily] ?? null;
  }

  const domainWildcard = `${domain}/*`;
  if (Object.hasOwn(lowConfidence, domainWildcard)) {
    return lowConfidence[domainWildcard] ?? null;
  }

  if (Object.hasOwn(lowConfidence, "*")) {
    return lowConfidence["*"] ?? null;
  }

  return null;
}

function roundThreshold(value: number): number {
  return Number(Math.max(0, Math.min(1, value)).toFixed(3));
}

export function recommendPolicyThresholds(
  report: PolicyCalibrationReport,
  compiledPolicy: CompiledPolicyPack | null | undefined,
  options: PolicyThresholdRecommendationOptions = {},
): PolicyThresholdRecommendation[] {
  const minSamples = options.min_samples ?? 5;
  const tightenBuffer = options.tighten_buffer ?? 0.01;
  const relaxBuffer = options.relax_buffer ?? 0.01;
  const samplesByFamily = new Map<string, PolicyCalibrationSample[]>();

  for (const sample of report.samples ?? []) {
    const familySamples = samplesByFamily.get(sample.action_family) ?? [];
    familySamples.push(sample);
    samplesByFamily.set(sample.action_family, familySamples);
  }

  return report.action_families.map((family): PolicyThresholdRecommendation => {
    const currentThreshold = resolvePolicyLowConfidenceThreshold(compiledPolicy, family.action_family);
    const samples = samplesByFamily.get(family.action_family) ?? [];
    const deniedSamples = samples.filter((sample) => sample.approval_status === "denied");
    const approvedSamples = samples.filter((sample) => sample.approval_status === "approved");
    const deniedConfidenceMax =
      deniedSamples.length > 0 ? Math.max(...deniedSamples.map((sample) => sample.confidence_score)) : null;
    const approvedConfidenceMin =
      approvedSamples.length > 0 ? Math.min(...approvedSamples.map((sample) => sample.confidence_score)) : null;

    if (family.sample_count < minSamples) {
      return {
        action_family: family.action_family,
        current_ask_below: currentThreshold,
        recommended_ask_below: currentThreshold,
        direction: "hold",
        sample_count: family.sample_count,
        approvals_requested: family.approvals.requested,
        approvals_approved: family.approvals.approved,
        approvals_denied: family.approvals.denied,
        observed_confidence_min: family.confidence.min,
        observed_confidence_max: family.confidence.max,
        denied_confidence_max: deniedConfidenceMax,
        approved_confidence_min: approvedConfidenceMin,
        rationale: `Hold: only ${family.sample_count} sample${family.sample_count === 1 ? "" : "s"} observed; need at least ${minSamples}.`,
        requires_policy_update: false,
        automatic_live_application_allowed: false,
      };
    }

    if (deniedConfidenceMax !== null) {
      const recommended = roundThreshold(Math.max(currentThreshold ?? 0, deniedConfidenceMax + tightenBuffer));
      if (currentThreshold === null || recommended > currentThreshold) {
        return {
          action_family: family.action_family,
          current_ask_below: currentThreshold,
          recommended_ask_below: recommended,
          direction: "tighten",
          sample_count: family.sample_count,
          approvals_requested: family.approvals.requested,
          approvals_approved: family.approvals.approved,
          approvals_denied: family.approvals.denied,
          observed_confidence_min: family.confidence.min,
          observed_confidence_max: family.confidence.max,
          denied_confidence_max: deniedConfidenceMax,
          approved_confidence_min: approvedConfidenceMin,
          rationale: `Tighten: denied approvals were observed up to confidence ${deniedConfidenceMax.toFixed(3)}.`,
          requires_policy_update: true,
          automatic_live_application_allowed: false,
        };
      }
    }

    if (
      currentThreshold !== null &&
      approvedConfidenceMin !== null &&
      family.approvals.requested > 0 &&
      family.approvals.denied === 0 &&
      family.approvals.approved === family.approvals.requested
    ) {
      const recommended = roundThreshold(Math.min(currentThreshold, approvedConfidenceMin - relaxBuffer));
      if (recommended < currentThreshold) {
        return {
          action_family: family.action_family,
          current_ask_below: currentThreshold,
          recommended_ask_below: recommended,
          direction: "relax",
          sample_count: family.sample_count,
          approvals_requested: family.approvals.requested,
          approvals_approved: family.approvals.approved,
          approvals_denied: family.approvals.denied,
          observed_confidence_min: family.confidence.min,
          observed_confidence_max: family.confidence.max,
          denied_confidence_max: deniedConfidenceMax,
          approved_confidence_min: approvedConfidenceMin,
          rationale: `Relax with human review: all approval-gated samples were approved, with lowest approved confidence ${approvedConfidenceMin.toFixed(3)}.`,
          requires_policy_update: true,
          automatic_live_application_allowed: false,
        };
      }
    }

    return {
      action_family: family.action_family,
      current_ask_below: currentThreshold,
      recommended_ask_below: currentThreshold,
      direction: "hold",
      sample_count: family.sample_count,
      approvals_requested: family.approvals.requested,
      approvals_approved: family.approvals.approved,
      approvals_denied: family.approvals.denied,
      observed_confidence_min: family.confidence.min,
      observed_confidence_max: family.confidence.max,
      denied_confidence_max: deniedConfidenceMax,
      approved_confidence_min: approvedConfidenceMin,
      rationale: "Hold: observed approvals do not justify a threshold change.",
      requires_policy_update: false,
      automatic_live_application_allowed: false,
    };
  });
}

function normalizeReplayCandidateThresholds(
  thresholds: PolicyLowConfidenceThreshold[],
): PolicyLowConfidenceThreshold[] {
  const deduped = new Map<string, number>();

  for (const threshold of thresholds) {
    deduped.set(threshold.action_family, roundThreshold(threshold.ask_below));
  }

  return [...deduped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([action_family, ask_below]) => ({
      action_family,
      ask_below,
    }));
}

function overlayLowConfidenceThresholds(
  compiledPolicy: CompiledPolicyPack | null | undefined,
  thresholds: PolicyLowConfidenceThreshold[],
): CompiledPolicyPack {
  const basePolicy = compiledPolicy ?? DEFAULT_COMPILED_POLICY_PACK;

  return {
    ...basePolicy,
    thresholds: {
      low_confidence: {
        ...basePolicy.thresholds.low_confidence,
        ...Object.fromEntries(thresholds.map((threshold) => [threshold.action_family, threshold.ask_below])),
      },
    },
  };
}

function emptyReplaySummary(): GetPolicyThresholdReplayResponsePayload["summary"] {
  return {
    replayable_samples: 0,
    skipped_samples: 0,
    changed_decisions: 0,
    unchanged_decisions: 0,
    current_approvals_requested: 0,
    candidate_approvals_requested: 0,
    approvals_reduced: 0,
    approvals_increased: 0,
    historically_denied_auto_allowed: 0,
    historically_approved_auto_allowed: 0,
    historically_allowed_newly_gated: 0,
    current_matches_recorded: 0,
    current_diverges_from_recorded: 0,
  };
}

function classifyReplayChange(
  sample: PolicyThresholdReplayRecord,
  currentOutcome: PolicyOutcomeRecord,
  candidateOutcome: PolicyOutcomeRecord,
): {
  kind: ReplayChangeKind;
  summary: string;
} {
  if (currentOutcome.preconditions.approval_required && !candidateOutcome.preconditions.approval_required) {
    if (sample.approval_status === "denied") {
      return {
        kind: "unsafe_auto_allow",
        summary: `Historical denial would become automatic (${currentOutcome.decision} -> ${candidateOutcome.decision}).`,
      };
    }

    return {
      kind: "approval_removed",
      summary: `Approval gate removed (${currentOutcome.decision} -> ${candidateOutcome.decision}).`,
    };
  }

  if (!currentOutcome.preconditions.approval_required && candidateOutcome.preconditions.approval_required) {
    if (
      sample.approval_status === null &&
      (sample.recorded_decision === "allow" || sample.recorded_decision === "allow_with_snapshot")
    ) {
      return {
        kind: "historical_allow_now_gated",
        summary: `Historically automatic action would now require approval (${currentOutcome.decision} -> ${candidateOutcome.decision}).`,
      };
    }

    return {
      kind: "approval_added",
      summary: `Approval gate added (${currentOutcome.decision} -> ${candidateOutcome.decision}).`,
    };
  }

  return {
    kind: "decision_changed",
    summary: `Decision changes from ${currentOutcome.decision} to ${candidateOutcome.decision}.`,
  };
}

export function replayPolicyThresholds(
  records: PolicyThresholdReplayRecord[],
  compiledPolicy: CompiledPolicyPack | null | undefined,
  candidateThresholds: PolicyLowConfidenceThreshold[],
  options: PolicyThresholdReplayOptions = {},
): Omit<GetPolicyThresholdReplayResponsePayload, "generated_at" | "filters" | "effective_policy_profile"> {
  const normalizedCandidateThresholds = normalizeReplayCandidateThresholds(candidateThresholds);
  const currentCompiledPolicy = compiledPolicy ?? DEFAULT_COMPILED_POLICY_PACK;
  const candidateCompiledPolicy = overlayLowConfidenceThresholds(currentCompiledPolicy, normalizedCandidateThresholds);
  const includeChangedSamples = options.include_changed_samples ?? false;
  const sampleLimit = includeChangedSamples ? (options.sample_limit ?? 200) : null;
  const summary = emptyReplaySummary();
  const familySummaries = new Map<string, GetPolicyThresholdReplayResponsePayload["action_families"][number]>();
  const changedSamples: NonNullable<GetPolicyThresholdReplayResponsePayload["changed_samples"]> = [];

  for (const record of records) {
    const familySummary =
      familySummaries.get(record.action_family) ??
      (() => {
        const created: GetPolicyThresholdReplayResponsePayload["action_families"][number] = {
          action_family: record.action_family,
          current_ask_below: null,
          candidate_ask_below: null,
          replayable_samples: 0,
          skipped_samples: 0,
          changed_decisions: 0,
          unchanged_decisions: 0,
          current_approvals_requested: 0,
          candidate_approvals_requested: 0,
          approvals_reduced: 0,
          approvals_increased: 0,
          historically_denied_auto_allowed: 0,
          historically_approved_auto_allowed: 0,
          historically_allowed_newly_gated: 0,
          current_matches_recorded: 0,
          current_diverges_from_recorded: 0,
        };
        familySummaries.set(record.action_family, created);
        return created;
      })();

    if (!record.action) {
      summary.skipped_samples += 1;
      familySummary.skipped_samples += 1;
      continue;
    }

    const currentOutcome = evaluatePolicy(record.action, {
      compiled_policy: currentCompiledPolicy,
    });
    const candidateOutcome = evaluatePolicy(record.action, {
      compiled_policy: candidateCompiledPolicy,
    });
    const currentConfidenceThreshold = resolvePolicyLowConfidenceThreshold(currentCompiledPolicy, record.action);
    const candidateConfidenceThreshold = resolvePolicyLowConfidenceThreshold(candidateCompiledPolicy, record.action);
    const currentConfidenceTriggered =
      currentConfidenceThreshold !== null && record.confidence_score < currentConfidenceThreshold;
    const candidateConfidenceTriggered =
      candidateConfidenceThreshold !== null && record.confidence_score < candidateConfidenceThreshold;
    familySummary.current_ask_below = currentConfidenceThreshold;
    familySummary.candidate_ask_below = candidateConfidenceThreshold;

    summary.replayable_samples += 1;
    familySummary.replayable_samples += 1;

    if (currentOutcome.preconditions.approval_required) {
      summary.current_approvals_requested += 1;
      familySummary.current_approvals_requested += 1;
    }
    if (candidateOutcome.preconditions.approval_required) {
      summary.candidate_approvals_requested += 1;
      familySummary.candidate_approvals_requested += 1;
    }

    if (currentOutcome.preconditions.approval_required && !candidateOutcome.preconditions.approval_required) {
      summary.approvals_reduced += 1;
      familySummary.approvals_reduced += 1;
      if (record.approval_status === "denied") {
        summary.historically_denied_auto_allowed += 1;
        familySummary.historically_denied_auto_allowed += 1;
      }
      if (record.approval_status === "approved") {
        summary.historically_approved_auto_allowed += 1;
        familySummary.historically_approved_auto_allowed += 1;
      }
    }

    if (!currentOutcome.preconditions.approval_required && candidateOutcome.preconditions.approval_required) {
      summary.approvals_increased += 1;
      familySummary.approvals_increased += 1;
      if (
        record.approval_status === null &&
        (record.recorded_decision === "allow" || record.recorded_decision === "allow_with_snapshot")
      ) {
        summary.historically_allowed_newly_gated += 1;
        familySummary.historically_allowed_newly_gated += 1;
      }
    }

    if (currentOutcome.decision === record.recorded_decision) {
      summary.current_matches_recorded += 1;
      familySummary.current_matches_recorded += 1;
    } else {
      summary.current_diverges_from_recorded += 1;
      familySummary.current_diverges_from_recorded += 1;
    }

    if (currentOutcome.decision === candidateOutcome.decision) {
      summary.unchanged_decisions += 1;
      familySummary.unchanged_decisions += 1;
      continue;
    }

    summary.changed_decisions += 1;
    familySummary.changed_decisions += 1;

    if (includeChangedSamples) {
      const change = classifyReplayChange(record, currentOutcome, candidateOutcome);
      changedSamples.push({
        run_id: record.run_id,
        action_id: record.action_id,
        evaluated_at: record.evaluated_at,
        action_family: record.action_family,
        confidence_score: roundThreshold(record.confidence_score),
        recorded_decision: record.recorded_decision,
        current_decision: currentOutcome.decision,
        candidate_decision: candidateOutcome.decision,
        approval_status: record.approval_status,
        current_confidence_triggered: currentConfidenceTriggered,
        candidate_confidence_triggered: candidateConfidenceTriggered,
        change_kind: change.kind,
        summary: change.summary,
      });
    }
  }

  return {
    candidate_thresholds: normalizedCandidateThresholds,
    summary,
    action_families: [...familySummaries.values()].sort((left, right) => {
      if (right.replayable_samples !== left.replayable_samples) {
        return right.replayable_samples - left.replayable_samples;
      }
      return left.action_family.localeCompare(right.action_family);
    }),
    changed_samples: includeChangedSamples ? changedSamples.slice(0, sampleLimit ?? changedSamples.length) : undefined,
    samples_truncated: includeChangedSamples && sampleLimit !== null ? changedSamples.length > sampleLimit : false,
  };
}

function evaluateCompiledPolicy(
  action: ActionRecord,
  compiledPolicy: CompiledPolicyPack | null | undefined,
): PolicyOutcomeRecord | null {
  if (!compiledPolicy || compiledPolicy.rules.length === 0) {
    return null;
  }

  const matchedRule = compiledPolicy.rules
    .filter((candidate) => enforcementModeStrengthensDecision(candidate.rule) !== null)
    .filter((candidate) => matchesPolicyPredicate(candidate.rule.match, action))
    .sort(compareCompiledRules)[0];

  if (!matchedRule) {
    return null;
  }

  const effectiveDecision = enforcementModeStrengthensDecision(matchedRule.rule);
  if (!effectiveDecision) {
    return null;
  }

  return makeOutcome(
    action,
    effectiveDecision,
    [matchedRule.rule.reason],
    [`policy.config.${matchedRule.rule.rule_id}`],
  );
}

function applyPolicyOverlay(
  baseOutcome: PolicyOutcomeRecord,
  overlayOutcome: PolicyOutcomeRecord | null,
): PolicyOutcomeRecord {
  if (!overlayOutcome) {
    return baseOutcome;
  }

  if (POLICY_DECISION_STRENGTH[overlayOutcome.decision] > POLICY_DECISION_STRENGTH[baseOutcome.decision]) {
    if (overlayOutcome.decision === "ask" && baseOutcome.preconditions.snapshot_required) {
      return {
        ...overlayOutcome,
        preconditions: {
          ...overlayOutcome.preconditions,
          snapshot_required: true,
        },
      };
    }
    return overlayOutcome;
  }

  return baseOutcome;
}

export function compilePolicyPack(configs: PolicyConfig[]): CompiledPolicyPack {
  const rules: CompiledPolicyRule[] = [];
  const lowConfidenceThresholds: Record<string, number> = {};

  configs.forEach((config, sourceIndex) => {
    for (const threshold of config.thresholds?.low_confidence ?? []) {
      if (!Object.hasOwn(lowConfidenceThresholds, threshold.action_family)) {
        lowConfidenceThresholds[threshold.action_family] = threshold.ask_below;
      }
    }

    config.rules.forEach((rule, ruleIndex) => {
      rules.push({
        profile_name: config.profile_name,
        policy_version: config.policy_version,
        source_index: sourceIndex,
        rule_index: ruleIndex,
        rule,
      });
    });
  });

  return {
    profile_name: configs[0]?.profile_name ?? "empty",
    policy_versions: [...new Set(configs.map((config) => config.policy_version))],
    rules,
    thresholds: {
      low_confidence: lowConfidenceThresholds,
    },
  };
}

export function validatePolicyConfigDocument(document: unknown): PolicyConfigValidationResult {
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
    compiled_policy: compilePolicyPack([parsed.data]),
  };
}

function actionTargetPath(action: ActionRecord): string | null {
  const locator = action.target.primary.locator;
  if (action.target.primary.type !== "path" || !locator) {
    return null;
  }

  return path.resolve(locator);
}

function capabilityWorkspaceRoot(capability: CapabilityRecord): string | null {
  const workspaceRoot = capability.details.workspace_root;
  return typeof workspaceRoot === "string" && workspaceRoot.length > 0 ? path.resolve(workspaceRoot) : null;
}

function isPathWithinWorkspaceRoot(targetPath: string, workspaceRoot: string): boolean {
  return targetPath === workspaceRoot || targetPath.startsWith(`${workspaceRoot}${path.sep}`);
}

function findCapability(capabilities: CapabilityRecord[], capabilityName: string): CapabilityRecord | null {
  return capabilities.find((capability) => capability.capability_name === capabilityName) ?? null;
}

function findWorkspaceCapabilityForAction(
  action: ActionRecord,
  capabilities: CapabilityRecord[],
): CapabilityRecord | null {
  const targetPath = actionTargetPath(action);
  if (!targetPath) {
    return null;
  }

  return (
    capabilities.find((capability) => {
      if (capability.capability_name !== "workspace.root_access") {
        return false;
      }

      const workspaceRoot = capabilityWorkspaceRoot(capability);
      return workspaceRoot !== null && isPathWithinWorkspaceRoot(targetPath, workspaceRoot);
    }) ?? null
  );
}

function evaluateFilesystemCapabilityState(
  action: ActionRecord,
  context: PolicyEvaluationContext,
  snapshotRequired: boolean,
): PolicyOutcomeRecord | null {
  const capabilityState = context.cached_capability_state;
  if (!capabilityState) {
    return null;
  }

  if (capabilityState.is_stale) {
    return makeCapabilityApprovalOutcome(
      action,
      {
        code: "CAPABILITY_STATE_STALE",
        severity: "high",
        message:
          "Cached workspace capability state is stale; rerun capability_refresh or approve explicitly before automatic execution.",
      },
      "capability.workspace.stale.ask",
      snapshotRequired,
    );
  }

  const workspaceCapability = findWorkspaceCapabilityForAction(action, capabilityState.capabilities);
  if (!workspaceCapability) {
    return makeCapabilityApprovalOutcome(
      action,
      {
        code: "CAPABILITY_STATE_INCOMPLETE",
        severity: "high",
        message:
          "Cached capability state did not include governed workspace access for this path; rerun capability_refresh or approve explicitly before automatic execution.",
      },
      "capability.workspace.missing.ask",
      snapshotRequired,
    );
  }

  if (workspaceCapability.status !== "available") {
    return makeCapabilityApprovalOutcome(
      action,
      {
        code: "WORKSPACE_CAPABILITY_UNAVAILABLE",
        severity: "high",
        message: `Cached workspace access capability is ${workspaceCapability.status}; rerun capability_refresh or approve explicitly before automatic execution.`,
      },
      "capability.workspace.unavailable.ask",
      snapshotRequired,
    );
  }

  if (!snapshotRequired) {
    return null;
  }

  const runtimeStorageCapability = findCapability(capabilityState.capabilities, "host.runtime_storage");
  if (!runtimeStorageCapability) {
    return makeCapabilityApprovalOutcome(
      action,
      {
        code: "CAPABILITY_STATE_INCOMPLETE",
        severity: "high",
        message:
          "Cached capability state did not include runtime snapshot storage readiness; rerun capability_refresh or approve explicitly before automatic execution.",
      },
      "capability.runtime_storage.missing.ask",
      snapshotRequired,
    );
  }

  if (runtimeStorageCapability.status !== "available") {
    return makeCapabilityApprovalOutcome(
      action,
      {
        code: "RUNTIME_STORAGE_CAPABILITY_DEGRADED",
        severity: "high",
        message: `Cached runtime storage capability is ${runtimeStorageCapability.status}; rerun capability_refresh or approve explicitly before automatic execution that requires snapshot protection.`,
      },
      "capability.runtime_storage.degraded.ask",
      snapshotRequired,
    );
  }

  return null;
}

function evaluateShellCapabilityState(
  action: ActionRecord,
  context: PolicyEvaluationContext,
): PolicyOutcomeRecord | null {
  const capabilityState = context.cached_capability_state;
  if (!capabilityState) {
    return null;
  }

  if (capabilityState.is_stale) {
    return makeCapabilityApprovalOutcome(
      action,
      {
        code: "CAPABILITY_STATE_STALE",
        severity: "high",
        message:
          "Cached capability state for snapshot-backed shell execution is stale; rerun capability_refresh or approve explicitly before automatic execution.",
      },
      "capability.shell.stale.ask",
      true,
    );
  }

  const runtimeStorageCapability = findCapability(capabilityState.capabilities, "host.runtime_storage");
  if (!runtimeStorageCapability) {
    return makeCapabilityApprovalOutcome(
      action,
      {
        code: "CAPABILITY_STATE_INCOMPLETE",
        severity: "high",
        message:
          "Cached capability state did not include runtime snapshot storage readiness; rerun capability_refresh or approve explicitly before automatic shell execution.",
      },
      "capability.shell.runtime_storage.missing.ask",
      true,
    );
  }

  if (runtimeStorageCapability.status !== "available") {
    return makeCapabilityApprovalOutcome(
      action,
      {
        code: "RUNTIME_STORAGE_CAPABILITY_DEGRADED",
        severity: "high",
        message: `Cached runtime storage capability is ${runtimeStorageCapability.status}; rerun capability_refresh or approve explicitly before automatic shell execution that requires snapshot protection.`,
      },
      "capability.shell.runtime_storage.degraded.ask",
      true,
    );
  }

  return null;
}

function hasUnrecoverableExternalRisk(action: ActionRecord): boolean {
  const externalEffects = action.risk_hints.external_effects;
  const reversibilityHint = action.risk_hints.reversibility_hint;

  return (
    externalEffects === "communication" ||
    externalEffects === "financial" ||
    reversibilityHint === "irreversible" ||
    (externalEffects === "unknown" && reversibilityHint === "unknown")
  );
}

function recoveryProofScopeForAction(
  action: ActionRecord,
): PolicyOutcomeRecord["policy_context"]["recovery_proof_scope"] {
  return action.target.scope.breadth === "single" || action.target.scope.breadth === "set" ? "path" : "workspace";
}

function localSnapshotRecoveryContext(action: ActionRecord): Partial<PolicyOutcomeRecord["policy_context"]> {
  return makeRecoveryProofContext({
    recoverability_class: "recoverable_local",
    recovery_proof_kind: "snapshot_preimage",
    recovery_proof_source: "snapshot-engine.preimage",
    recovery_proof_scope: recoveryProofScopeForAction(action),
  });
}

function evaluateFilesystem(action: ActionRecord, context: PolicyEvaluationContext): PolicyOutcomeRecord {
  const locator = action.target.primary.locator;
  const confidenceScore = actionConfidenceScore(action);
  const lowConfidenceThreshold = resolvePolicyLowConfidenceThreshold(
    context.compiled_policy ?? DEFAULT_COMPILED_POLICY_PACK,
    action,
  );
  const fsFacet = action.facets.filesystem as { operation?: string; byte_length?: number } | undefined;
  const operation = fsFacet?.operation ?? action.operation.kind;
  const byteLength = fsFacet?.byte_length ?? 0;

  if (!locator || action.target.scope.unknowns.includes("scope")) {
    return makeOutcome(
      action,
      "deny",
      [
        {
          code: "PATH_NOT_GOVERNED",
          severity: "critical",
          message: "Filesystem path is outside the governed workspace roots.",
        },
      ],
      ["filesystem.outside_workspace.deny"],
    );
  }

  if (lowConfidenceThreshold !== null && confidenceScore < lowConfidenceThreshold) {
    return (
      evaluateFilesystemCapabilityState(action, context, true) ??
      makeAutomaticSnapshotOutcome(
        action,
        {
          code: "LOW_NORMALIZATION_CONFIDENCE",
          severity: "moderate",
          message:
            "Filesystem action confidence is below the configured automation threshold, so AgentGit will create a recovery boundary before continuing.",
        },
        "normalization.low_confidence.snapshot",
        undefined,
        localSnapshotRecoveryContext(action),
      )
    );
  }

  if (operation === "delete") {
    return (
      evaluateFilesystemCapabilityState(action, context, true) ??
      makeOutcome(
        action,
        "allow_with_snapshot",
        [
          {
            code: "FS_DESTRUCTIVE_WORKSPACE_MUTATION",
            severity: "moderate",
            message: "Destructive filesystem mutations require a recovery boundary.",
          },
        ],
        ["filesystem.delete.requires_snapshot"],
        undefined,
        localSnapshotRecoveryContext(action),
      )
    );
  }

  if (byteLength <= SAFE_FS_WRITE_BYTES) {
    return (
      evaluateFilesystemCapabilityState(action, context, false) ??
      makeOutcome(
        action,
        "allow",
        [
          {
            code: "TRUSTED_GOVERNED_FS_WRITE",
            severity: "low",
            message: "Small governed filesystem writes are allowed in safe mode.",
          },
        ],
        ["filesystem.safe.small_write"],
      )
    );
  }

  return (
    evaluateFilesystemCapabilityState(action, context, true) ??
    makeOutcome(
      action,
      "allow_with_snapshot",
      [
        {
          code: "FS_MUTATION_REQUIRES_SNAPSHOT",
          severity: "moderate",
          message: "Large governed filesystem writes require snapshot protection.",
        },
      ],
      ["filesystem.large_write.requires_snapshot"],
      undefined,
      localSnapshotRecoveryContext(action),
    )
  );
}

function evaluateShell(action: ActionRecord, context: PolicyEvaluationContext): PolicyOutcomeRecord {
  const shellFacet = action.facets.shell as { command_family?: string } | undefined;
  const commandFamily = shellFacet?.command_family ?? "unclassified";
  const lowConfidenceThreshold = resolvePolicyLowConfidenceThreshold(
    context.compiled_policy ?? DEFAULT_COMPILED_POLICY_PACK,
    action,
  );
  const confidenceTriggered = lowConfidenceThreshold !== null && actionConfidenceScore(action) < lowConfidenceThreshold;

  if (action.risk_hints.side_effect_level === "read_only") {
    if (confidenceTriggered) {
      return (
        evaluateShellCapabilityState(action, context) ??
        makeAutomaticSnapshotOutcome(
          action,
          {
            code: "LOW_NORMALIZATION_CONFIDENCE",
            severity: "moderate",
            message:
              "Shell command confidence is below the configured automation threshold, so AgentGit will create a recovery boundary before continuing.",
          },
          "shell.low_confidence.snapshot",
          undefined,
          localSnapshotRecoveryContext(action),
        )
      );
    }

    return makeOutcome(
      action,
      "allow",
      [
        {
          code: "TRUSTED_READONLY_ALLOWED",
          severity: "low",
          message: "Known read-only shell commands are allowed in safe mode.",
        },
      ],
      ["shell.safe.read_only"],
    );
  }

  if (hasUnrecoverableExternalRisk(action)) {
    return makeOutcome(
      action,
      "ask",
      [
        {
          code: "EXTERNAL_CONSENT_BOUNDARY_REQUIRES_APPROVAL",
          severity: "high",
          message:
            "Shell command crosses a consent or irreversibility boundary that AgentGit cannot automatically recover today.",
        },
      ],
      ["shell.external_consent.ask"],
      undefined,
      makeRecoveryProofContext({
        recoverability_class: "unrecoverable_or_degraded",
      }),
    );
  }

  if (confidenceTriggered) {
    return (
      evaluateShellCapabilityState(action, context) ??
      makeAutomaticSnapshotOutcome(
        action,
        {
          code: "LOW_NORMALIZATION_CONFIDENCE",
          severity: "moderate",
          message:
            "Shell command confidence is below the configured automation threshold, so AgentGit will create a recovery boundary before continuing.",
        },
        "shell.low_confidence.snapshot",
        undefined,
        localSnapshotRecoveryContext(action),
      )
    );
  }

  if (
    action.risk_hints.side_effect_level === "destructive" ||
    (action.risk_hints.side_effect_level === "mutating" &&
      (commandFamily === "filesystem_primitive" || commandFamily === "version_control_mutating"))
  ) {
    return (
      evaluateShellCapabilityState(action, context) ??
      makeOutcome(
        action,
        "allow_with_snapshot",
        [
          {
            code: "FS_DESTRUCTIVE_WORKSPACE_MUTATION",
            severity: "high",
            message: "Mutating shell commands require snapshot protection before proceeding.",
          },
        ],
        ["shell.mutating.requires_snapshot"],
        undefined,
        localSnapshotRecoveryContext(action),
      )
    );
  }

  if (commandFamily === "package_manager") {
    return (
      evaluateShellCapabilityState(action, context) ??
      makeAutomaticSnapshotOutcome(
        action,
        {
          code: "PACKAGE_MANAGER_REQUIRES_SNAPSHOT",
          severity: "moderate",
          message:
            "Package manager commands are allowed automatically when AgentGit can create a recovery boundary first.",
        },
        "shell.package_manager.snapshot",
        undefined,
        localSnapshotRecoveryContext(action),
      )
    );
  }

  if (commandFamily === "build_tool") {
    return (
      evaluateShellCapabilityState(action, context) ??
      makeAutomaticSnapshotOutcome(
        action,
        {
          code: "BUILD_TOOL_REQUIRES_SNAPSHOT",
          severity: "moderate",
          message: "Build tool commands are allowed automatically when AgentGit can create a recovery boundary first.",
        },
        "shell.build_tool.snapshot",
        undefined,
        localSnapshotRecoveryContext(action),
      )
    );
  }

  if (commandFamily === "interpreter") {
    return (
      evaluateShellCapabilityState(action, context) ??
      makeAutomaticSnapshotOutcome(
        action,
        {
          code: "INTERPRETER_EXECUTION_REQUIRES_SNAPSHOT",
          severity: "high",
          message:
            "Interpreter-launched scripts remain opaque, so AgentGit will create a recovery boundary before continuing automatically.",
        },
        "shell.interpreter.snapshot",
        undefined,
        localSnapshotRecoveryContext(action),
      )
    );
  }

  return (
    evaluateShellCapabilityState(action, context) ??
    makeAutomaticSnapshotOutcome(
      action,
      {
        code: "OPAQUE_SHELL_REQUIRES_SNAPSHOT",
        severity: "high",
        message:
          "Opaque shell commands are allowed automatically only after AgentGit creates a recovery boundary first.",
      },
      "shell.unclassified.snapshot",
      undefined,
      localSnapshotRecoveryContext(action),
    )
  );
}

function evaluateFunction(action: ActionRecord, context: PolicyEvaluationContext): PolicyOutcomeRecord {
  const functionFacet = action.facets.function as
    | {
        integration?: string;
        operation?: string;
        trusted_compensator?: string;
      }
    | undefined;
  const integration = functionFacet?.integration ?? "unknown";
  const operation = functionFacet?.operation ?? action.operation.kind;
  const lowConfidenceThreshold = resolvePolicyLowConfidenceThreshold(
    context.compiled_policy ?? DEFAULT_COMPILED_POLICY_PACK,
    action,
  );
  const hasTrustedCompensator =
    typeof functionFacet?.trusted_compensator === "string" && functionFacet.trusted_compensator.length > 0;
  const hasRecoverableFunctionBoundary =
    hasTrustedCompensator &&
    action.execution_path.credential_mode !== "direct" &&
    (action.risk_hints.reversibility_hint === "reversible" || action.risk_hints.reversibility_hint === "compensatable");

  if (
    integration === "drafts" &&
    (operation === "create_draft" ||
      operation === "archive_draft" ||
      operation === "delete_draft" ||
      operation === "unarchive_draft" ||
      operation === "update_draft" ||
      operation === "restore_draft" ||
      operation === "add_label" ||
      operation === "remove_label") &&
    functionFacet?.trusted_compensator
  ) {
    if (action.execution_path.credential_mode === "direct") {
      return makeDirectCredentialDenyOutcome(
        action,
        "Owned draft integrations may not execute with direct credentials.",
        "credentials.direct.forbidden",
      );
    }

    return makeOutcome(
      action,
      "allow_with_snapshot",
      [
        {
          code: "OWNED_FUNCTION_COMPENSATABLE",
          severity: "moderate",
          message: "Owned draft mutation is allowed with a recovery boundary because a trusted compensator exists.",
        },
      ],
      ["function.drafts.compensatable.requires_snapshot"],
      undefined,
      makeRecoveryProofContext({
        recoverability_class: "recoverable_external_compensated",
        recovery_proof_kind: "trusted_compensator",
        recovery_proof_source: functionFacet.trusted_compensator,
        recovery_proof_scope: "external_object",
      }),
    );
  }

  if (
    integration === "notes" &&
    (operation === "create_note" ||
      operation === "archive_note" ||
      operation === "unarchive_note" ||
      operation === "update_note" ||
      operation === "restore_note" ||
      operation === "delete_note") &&
    functionFacet?.trusted_compensator
  ) {
    if (action.execution_path.credential_mode === "direct") {
      return makeDirectCredentialDenyOutcome(
        action,
        "Owned note integrations may not execute with direct credentials.",
        "credentials.direct.forbidden",
      );
    }

    return makeOutcome(
      action,
      "allow_with_snapshot",
      [
        {
          code: "OWNED_FUNCTION_COMPENSATABLE",
          severity: "moderate",
          message: "Owned note mutation is allowed with a recovery boundary because a trusted compensator exists.",
        },
      ],
      ["function.notes.compensatable.requires_snapshot"],
      undefined,
      makeRecoveryProofContext({
        recoverability_class: "recoverable_external_compensated",
        recovery_proof_kind: "trusted_compensator",
        recovery_proof_source: functionFacet.trusted_compensator,
        recovery_proof_scope: "external_object",
      }),
    );
  }

  if (
    integration === "tickets" &&
    (operation === "create_ticket" ||
      operation === "update_ticket" ||
      operation === "delete_ticket" ||
      operation === "restore_ticket" ||
      operation === "close_ticket" ||
      operation === "reopen_ticket" ||
      operation === "add_label" ||
      operation === "remove_label" ||
      operation === "assign_user" ||
      operation === "unassign_user") &&
    functionFacet?.trusted_compensator
  ) {
    if (action.execution_path.credential_mode !== "brokered") {
      return makeOutcome(
        action,
        "deny",
        [
          {
            code:
              action.execution_path.credential_mode === "direct"
                ? "DIRECT_CREDENTIALS_FORBIDDEN"
                : "BROKERED_CREDENTIALS_REQUIRED",
            severity: "critical",
            message:
              action.execution_path.credential_mode === "direct"
                ? "Owned ticket integrations may not execute with direct credentials."
                : "Owned ticket integrations require brokered credentials.",
          },
        ],
        [
          action.execution_path.credential_mode === "direct"
            ? "credentials.direct.forbidden"
            : "credentials.brokered.required",
        ],
        {
          brokered_credentials_required: true,
          direct_credentials_forbidden: true,
        },
      );
    }

    const capabilityState = context.cached_capability_state;
    if (capabilityState) {
      if (capabilityState.is_stale) {
        return makeCapabilityApprovalOutcome(
          action,
          {
            code: "CAPABILITY_STATE_STALE",
            severity: "high",
            message:
              "Cached ticket capability state is stale; rerun capability_refresh or approve explicitly before automatic execution.",
          },
          "capability.tickets.stale.ask",
          true,
          {
            brokered_credentials_required: true,
            direct_credentials_forbidden: true,
          },
        );
      }

      const ticketCapability = capabilityState.capabilities.find(
        (capability) => capability.capability_name === "adapter.tickets_brokered_credentials",
      );
      if (!ticketCapability) {
        return makeCapabilityApprovalOutcome(
          action,
          {
            code: "CAPABILITY_STATE_INCOMPLETE",
            severity: "high",
            message:
              "Cached capability state did not include ticket broker readiness; rerun capability_refresh or approve explicitly before automatic execution.",
          },
          "capability.tickets.missing.ask",
          true,
          {
            brokered_credentials_required: true,
            direct_credentials_forbidden: true,
          },
        );
      }

      if (ticketCapability.status !== "available") {
        return makeCapabilityApprovalOutcome(
          action,
          {
            code: "BROKERED_CAPABILITY_UNAVAILABLE",
            severity: "high",
            message: `Cached ticket broker capability is ${ticketCapability.status}; rerun capability_refresh or approve explicitly before automatic execution.`,
          },
          "capability.tickets.unavailable.ask",
          true,
          {
            brokered_credentials_required: true,
            direct_credentials_forbidden: true,
          },
        );
      }
    }

    return makeOutcome(
      action,
      "allow_with_snapshot",
      [
        {
          code: "OWNED_FUNCTION_COMPENSATABLE",
          severity: "moderate",
          message:
            "Owned ticket mutation is allowed with a recovery boundary because a trusted compensator and brokered credentials exist.",
        },
      ],
      ["function.tickets.compensatable.requires_snapshot"],
      {
        brokered_credentials_required: true,
        direct_credentials_forbidden: true,
      },
      makeRecoveryProofContext({
        recoverability_class: "recoverable_external_compensated",
        recovery_proof_kind: "trusted_compensator",
        recovery_proof_source: functionFacet.trusted_compensator,
        recovery_proof_scope: "external_object",
      }),
    );
  }

  if (hasRecoverableFunctionBoundary) {
    return makeOutcome(
      action,
      "allow_with_snapshot",
      [
        {
          code: "FUNCTION_TRUSTED_COMPENSATABLE",
          severity: "moderate",
          message:
            "This function integration declared a trusted compensator, so AgentGit will create a recovery boundary and continue automatically.",
        },
      ],
      ["function.compensatable.requires_snapshot"],
      undefined,
      makeRecoveryProofContext({
        recoverability_class: "recoverable_external_compensated",
        recovery_proof_kind: "trusted_compensator",
        recovery_proof_source: functionFacet?.trusted_compensator ?? "declared_compensator",
        recovery_proof_scope: "external_object",
      }),
    );
  }

  if (lowConfidenceThreshold !== null && actionConfidenceScore(action) < lowConfidenceThreshold) {
    return makeOutcome(
      action,
      "ask",
      [
        {
          code: "FUNCTION_LOW_CONFIDENCE_REQUIRES_APPROVAL",
          severity: "high",
          message: "Function action confidence is below the configured automation threshold and requires approval.",
        },
      ],
      ["function.low_confidence.ask"],
    );
  }

  return makeOutcome(
    action,
    "ask",
    [
      {
        code: "FUNCTION_REQUIRES_APPROVAL",
        severity: "high",
        message: "This function integration is not yet trusted for automatic execution.",
      },
    ],
    ["function.untrusted.ask"],
    undefined,
    makeRecoveryProofContext({
      recoverability_class: "unrecoverable_or_degraded",
    }),
  );
}

function evaluateMcp(action: ActionRecord, context: PolicyEvaluationContext): PolicyOutcomeRecord {
  const mcpFacet = action.facets.mcp as
    | {
        server_id?: string;
        server_profile_id?: string;
        candidate_id?: string;
        tool_name?: string;
        execution_mode_requested?: "local_proxy" | "hosted_delegated";
        drift_state_at_submit?: "clean" | "drifted" | "unknown";
        credential_binding_mode?:
          | "oauth_session"
          | "derived_token"
          | "bearer_secret_ref"
          | "session_token"
          | "hosted_token_exchange";
        profile_status?: "draft" | "pending_approval" | "active" | "quarantined" | "revoked";
        allowed_execution_modes?: Array<"local_proxy" | "hosted_delegated">;
      }
    | undefined;
  const serverId = typeof mcpFacet?.server_id === "string" ? mcpFacet.server_id : "";
  const serverProfileId = typeof mcpFacet?.server_profile_id === "string" ? mcpFacet.server_profile_id : "";
  const candidateId = typeof mcpFacet?.candidate_id === "string" ? mcpFacet.candidate_id : "";
  const toolName = typeof mcpFacet?.tool_name === "string" ? mcpFacet.tool_name : "";
  const executionModeRequested =
    mcpFacet?.execution_mode_requested === "local_proxy" || mcpFacet?.execution_mode_requested === "hosted_delegated"
      ? mcpFacet.execution_mode_requested
      : null;
  const driftState =
    mcpFacet?.drift_state_at_submit === "clean" ||
    mcpFacet?.drift_state_at_submit === "drifted" ||
    mcpFacet?.drift_state_at_submit === "unknown"
      ? mcpFacet.drift_state_at_submit
      : null;
  const credentialBindingMode =
    mcpFacet?.credential_binding_mode === "oauth_session" ||
    mcpFacet?.credential_binding_mode === "derived_token" ||
    mcpFacet?.credential_binding_mode === "bearer_secret_ref" ||
    mcpFacet?.credential_binding_mode === "session_token" ||
    mcpFacet?.credential_binding_mode === "hosted_token_exchange"
      ? mcpFacet.credential_binding_mode
      : null;
  const profileStatus =
    mcpFacet?.profile_status === "draft" ||
    mcpFacet?.profile_status === "pending_approval" ||
    mcpFacet?.profile_status === "active" ||
    mcpFacet?.profile_status === "quarantined" ||
    mcpFacet?.profile_status === "revoked"
      ? mcpFacet.profile_status
      : null;
  const allowedExecutionModes = Array.isArray(mcpFacet?.allowed_execution_modes)
    ? mcpFacet.allowed_execution_modes.filter(
        (entry): entry is "local_proxy" | "hosted_delegated" => entry === "local_proxy" || entry === "hosted_delegated",
      )
    : [];

  if (action.execution_path.credential_mode === "direct") {
    return makeDirectCredentialDenyOutcome(
      action,
      "Governed MCP proxy execution does not accept direct client-provided credentials.",
      "mcp.direct_credentials.deny",
    );
  }

  if (candidateId.length > 0 && serverProfileId.length === 0) {
    return makeOutcome(
      action,
      "deny",
      [
        {
          code: "MCP_CANDIDATE_NOT_EXECUTABLE",
          severity: "high",
          message: "Raw MCP candidates are not executable until they are resolved into an active profile.",
        },
      ],
      ["mcp.candidate.execution.deny"],
    );
  }

  if (profileStatus && profileStatus !== "active") {
    return makeOutcome(
      action,
      "deny",
      [
        {
          code:
            profileStatus === "quarantined"
              ? "MCP_PROFILE_QUARANTINED"
              : profileStatus === "revoked"
                ? "MCP_PROFILE_REAPPROVAL_REQUIRED"
                : "MCP_PROFILE_NOT_ACTIVE",
          severity: "high",
          message:
            profileStatus === "quarantined"
              ? `MCP profile "${serverProfileId || serverId}" is quarantined and must be re-reviewed before execution.`
              : profileStatus === "revoked"
                ? `MCP profile "${serverProfileId || serverId}" has been revoked and must be explicitly re-approved before execution.`
                : `MCP profile "${serverProfileId || serverId}" is not active for governed execution.`,
        },
      ],
      [profileStatus === "quarantined" ? "mcp.profile.quarantined.deny" : "mcp.profile.inactive.deny"],
    );
  }

  if (driftState === "drifted") {
    return makeOutcome(
      action,
      "deny",
      [
        {
          code: "MCP_REMOTE_IDENTITY_CHANGED",
          severity: "high",
          message: `MCP profile "${serverProfileId || serverId}" has unresolved material drift and cannot execute until it is re-resolved.`,
        },
      ],
      ["mcp.profile.drifted.deny"],
    );
  }

  if (
    executionModeRequested &&
    allowedExecutionModes.length > 0 &&
    !allowedExecutionModes.includes(executionModeRequested)
  ) {
    return makeOutcome(
      action,
      "deny",
      [
        {
          code: "MCP_PROFILE_NOT_ACTIVE",
          severity: "high",
          message: `MCP profile "${serverProfileId || serverId}" is not approved for ${executionModeRequested} execution.`,
        },
      ],
      ["mcp.execution_mode.disallowed.deny"],
    );
  }

  if (executionModeRequested === "hosted_delegated" && credentialBindingMode === "session_token") {
    return makeOutcome(
      action,
      "deny",
      [
        {
          code: "MCP_AUTH_BINDING_MISSING",
          severity: "high",
          message:
            "Hosted delegated MCP execution requires a lease-safe credential binding; session_token bindings are degraded and local-only.",
        },
      ],
      ["mcp.hosted.session_token.deny"],
    );
  }

  if (!context.mcp_server_registry || context.mcp_server_registry.servers.length === 0) {
    return makeOutcome(
      action,
      "deny",
      [
        {
          code: "CAPABILITY_UNAVAILABLE",
          severity: "high",
          message: "No trusted MCP server registry is configured for governed MCP execution.",
        },
      ],
      ["mcp.registry.missing.deny"],
    );
  }

  const server = context.mcp_server_registry.servers.find((candidate) => candidate.server_id === serverId);
  if (!server) {
    return makeOutcome(
      action,
      "deny",
      [
        {
          code: "CAPABILITY_UNAVAILABLE",
          severity: "high",
          message: `MCP server "${serverId}" is not registered for governed execution.`,
        },
      ],
      ["mcp.server.unregistered.deny"],
    );
  }

  const toolPolicy = server.tools.find((candidate) => candidate.tool_name === toolName);
  if (!toolPolicy) {
    return makeOutcome(
      action,
      "deny",
      [
        {
          code: "CAPABILITY_UNAVAILABLE",
          severity: "high",
          message: `MCP tool "${toolName}" is not registered for governed execution on server "${serverId}".`,
        },
      ],
      ["mcp.tool.unregistered.deny"],
    );
  }

  if (toolPolicy.side_effect_level === "read_only" && toolPolicy.approval_mode !== "ask") {
    return makeOutcome(
      action,
      "allow",
      [
        {
          code: "MCP_TOOL_TRUSTED_READ_ONLY",
          severity: "low",
          message: "This MCP tool is explicitly registered as read-only and trusted for automatic execution.",
        },
      ],
      ["mcp.tool.read_only.allow"],
    );
  }

  return makeOutcome(
    action,
    "ask",
    [
      {
        code: "MCP_TOOL_APPROVAL_REQUIRED",
        severity: "moderate",
        message:
          toolPolicy.side_effect_level === "read_only"
            ? "This MCP tool is registered as read-only, but operator policy requires explicit approval."
            : "Mutating MCP tools require explicit approval in the governed runtime.",
      },
    ],
    [toolPolicy.side_effect_level === "read_only" ? "mcp.tool.read_only.ask" : "mcp.tool.mutating.ask"],
  );
}

function withBudgetEffects(
  action: ActionRecord,
  outcome: PolicyOutcomeRecord,
  context: PolicyEvaluationContext,
): PolicyOutcomeRecord {
  const runSummary = context.run_summary;
  if (!runSummary) {
    return outcome;
  }

  const updatedOutcome: PolicyOutcomeRecord = {
    ...outcome,
    reasons: [...outcome.reasons],
    budget_effects: {
      ...outcome.budget_effects,
    },
    policy_context: {
      ...outcome.policy_context,
      matched_rules: [...outcome.policy_context.matched_rules],
    },
  };

  const mutatingRelevant =
    action.risk_hints.side_effect_level === "mutating" || action.risk_hints.side_effect_level === "destructive";
  const destructiveRelevant = action.risk_hints.side_effect_level === "destructive";

  if (mutatingRelevant && runSummary.budget_config.max_mutating_actions !== null) {
    const remaining = runSummary.budget_config.max_mutating_actions - runSummary.budget_usage.mutating_actions - 1;
    updatedOutcome.budget_effects.remaining_mutating_actions = Math.max(remaining, 0);

    if (remaining < 0) {
      updatedOutcome.decision = "deny";
      updatedOutcome.preconditions.snapshot_required = false;
      updatedOutcome.preconditions.approval_required = false;
      updatedOutcome.budget_effects.budget_check = "hard_limit";
      updatedOutcome.reasons.push({
        code: "MUTATING_ACTION_BUDGET_EXCEEDED",
        severity: "critical",
        message: "Run mutating action budget is exhausted.",
      });
      updatedOutcome.policy_context.matched_rules.push("budget.mutating.hard_limit");
      return updatedOutcome;
    }

    if (remaining === 0) {
      updatedOutcome.budget_effects.budget_check = "soft_limit";
      updatedOutcome.reasons.push({
        code: "MUTATING_ACTION_BUDGET_AT_LIMIT",
        severity: "moderate",
        message: "This action would consume the final mutating action slot for the run.",
      });
      updatedOutcome.policy_context.matched_rules.push("budget.mutating.soft_limit");
    }
  }

  if (destructiveRelevant && runSummary.budget_config.max_destructive_actions !== null) {
    const remaining =
      runSummary.budget_config.max_destructive_actions - runSummary.budget_usage.destructive_actions - 1;
    updatedOutcome.budget_effects.remaining_destructive_actions = Math.max(remaining, 0);

    if (remaining < 0) {
      updatedOutcome.decision = "deny";
      updatedOutcome.preconditions.snapshot_required = false;
      updatedOutcome.preconditions.approval_required = false;
      updatedOutcome.budget_effects.budget_check = "hard_limit";
      updatedOutcome.reasons.push({
        code: "DESTRUCTIVE_ACTION_BUDGET_EXCEEDED",
        severity: "critical",
        message: "Run destructive action budget is exhausted.",
      });
      updatedOutcome.policy_context.matched_rules.push("budget.destructive.hard_limit");
      return updatedOutcome;
    }

    if (remaining === 0) {
      updatedOutcome.budget_effects.budget_check = "soft_limit";
      updatedOutcome.reasons.push({
        code: "DESTRUCTIVE_ACTION_BUDGET_AT_LIMIT",
        severity: "high",
        message: "This action would consume the final destructive action slot for the run.",
      });
      updatedOutcome.policy_context.matched_rules.push("budget.destructive.soft_limit");
    }
  }

  updatedOutcome.preconditions.snapshot_required =
    updatedOutcome.decision === "allow_with_snapshot" ||
    (updatedOutcome.decision === "ask" && updatedOutcome.preconditions.snapshot_required);
  updatedOutcome.preconditions.approval_required = updatedOutcome.decision === "ask";
  return updatedOutcome;
}

export function evaluatePolicy(action: ActionRecord, context: PolicyEvaluationContext = {}): PolicyOutcomeRecord {
  try {
    const compiledPolicyOutcome = evaluateCompiledPolicy(
      action,
      context.compiled_policy ?? DEFAULT_COMPILED_POLICY_PACK,
    );
    const baseOutcome =
      action.operation.domain === "filesystem"
        ? evaluateFilesystem(action, context)
        : action.operation.domain === "shell"
          ? evaluateShell(action, context)
          : action.operation.domain === "mcp"
            ? evaluateMcp(action, context)
            : action.operation.domain === "function"
              ? evaluateFunction(action, context)
              : makeOutcome(
                  action,
                  "ask",
                  [
                    {
                      code: "CAPABILITY_UNAVAILABLE",
                      severity: "high",
                      message: "No policy evaluator exists for this action domain yet.",
                    },
                  ],
                  ["policy.domain.unsupported"],
                );

    return withBudgetEffects(action, applyPolicyOverlay(baseOutcome, compiledPolicyOutcome), context);
  } catch (error) {
    const wrapped =
      error instanceof InternalError
        ? error
        : new InternalError("Policy evaluation failed.", {
            cause: error instanceof Error ? error.message : String(error),
          });

    return makeOutcome(
      action,
      "deny",
      [
        {
          code: "POLICY_EVALUATION_ERROR",
          severity: "critical",
          message: wrapped.message,
        },
      ],
      ["policy.evaluation.error"],
    );
  }
}
