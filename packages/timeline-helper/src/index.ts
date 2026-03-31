import {
  type HelperQuestionType,
  type PreviewBudgetSummary,
  type QueryHelperResponsePayload,
  type ReasonDetail,
  type TimelineStep,
  type VisibilityScope,
} from "@agentgit/schemas";

export interface JournalEventRecord {
  sequence: number;
  event_type: string;
  occurred_at: string;
  recorded_at: string;
  payload?: Record<string, unknown>;
}

function eventStatus(eventType: string): TimelineStep["status"] {
  if (eventType.endsWith(".failed")) {
    return "failed";
  }

  if (eventType === "execution.outcome_unknown") {
    return "partial";
  }

  if (eventType === "policy.evaluated") {
    return "completed";
  }

  return "completed";
}

interface ActionEventGroup {
  actionId: string;
  events: JournalEventRecord[];
}

interface RecoveryEventGroup {
  recoveryKey: string;
  snapshotId: string | null;
  actionId: string | null;
  events: JournalEventRecord[];
}

type RecoveryTargetType =
  | "snapshot_id"
  | "action_boundary"
  | "external_object"
  | "run_checkpoint"
  | "branch_point"
  | "path_subset";

interface ApprovalEventGroup {
  approvalId: string;
  events: JournalEventRecord[];
}

export interface TimelineProjectionView {
  visibility_scope: VisibilityScope;
  redactions_applied: number;
  preview_budget: PreviewBudgetSummary;
  steps: TimelineStep[];
}

type HelperAnswer = Omit<QueryHelperResponsePayload, "visibility_scope" | "redactions_applied" | "preview_budget">;

interface ProjectionTracker {
  redactions_applied: number;
  preview_chars_used: number;
  truncated_previews: number;
  omitted_previews: number;
}

const MAX_INLINE_PREVIEW_CHARS = 160;
const MAX_TOTAL_INLINE_PREVIEW_CHARS = 1200;
const MIN_REMAINING_PREVIEW_CHARS = 32;

function payloadRecord(event: JournalEventRecord): Record<string, unknown> {
  return event.payload ?? {};
}

function reasonDetailFromUnknown(value: unknown): ReasonDetail | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const code = (value as Record<string, unknown>).code;
  const message = (value as Record<string, unknown>).message;
  if (typeof code !== "string" || code.length === 0 || typeof message !== "string" || message.length === 0) {
    return null;
  }

  return {
    code,
    message,
  };
}

function visibilityRank(scope: VisibilityScope): number {
  switch (scope) {
    case "user":
      return 0;
    case "model":
      return 1;
    case "internal":
      return 2;
    case "sensitive_internal":
      return 3;
  }

  return 0;
}

function parseVisibilityScope(value: unknown): VisibilityScope | null {
  return value === "user" || value === "model" || value === "internal" || value === "sensitive_internal"
    ? value
    : null;
}

function parseRecoveryTargetType(value: string | null): RecoveryTargetType | null {
  switch (value) {
    case "snapshot_id":
    case "action_boundary":
    case "external_object":
    case "run_checkpoint":
    case "branch_point":
    case "path_subset":
      return value;
    default:
      return null;
  }
}

function formatRecoveryTargetLabel(params: {
  targetType: RecoveryTargetType | null;
  snapshotId: string | null;
  actionId: string | null;
  runCheckpoint: string | null;
  branchPointRunId: string | null;
  branchPointSequence: number | null;
  externalObjectId: string | null;
  targetPaths: string[];
  boundaryLabel: string;
}): string {
  switch (params.targetType) {
    case "snapshot_id":
      return params.snapshotId ? `snapshot ${params.snapshotId}` : params.boundaryLabel;
    case "action_boundary":
      return params.actionId ? `action ${params.actionId}` : params.boundaryLabel;
    case "external_object":
      return params.externalObjectId ? `external object ${params.externalObjectId}` : params.boundaryLabel;
    case "run_checkpoint":
      return params.runCheckpoint ? `run checkpoint ${params.runCheckpoint}` : params.boundaryLabel;
    case "branch_point":
      return params.branchPointRunId && params.branchPointSequence
        ? `branch point ${params.branchPointRunId}#${params.branchPointSequence}`
        : params.boundaryLabel;
    case "path_subset":
      return params.snapshotId
        ? `path subset ${params.snapshotId}${params.targetPaths.length > 0 ? ` @ ${params.targetPaths.join(", ")}` : ""}`
        : params.boundaryLabel;
    default:
      return params.boundaryLabel;
  }
}

function canAccessVisibility(fieldVisibility: VisibilityScope, requestedVisibility: VisibilityScope): boolean {
  return visibilityRank(requestedVisibility) >= visibilityRank(fieldVisibility);
}

function payloadVisibilityField(
  event: JournalEventRecord | undefined,
  key: string,
  fallback: VisibilityScope,
): VisibilityScope {
  const rawVisibility = payloadRecord(event ?? { sequence: 0, event_type: "", occurred_at: "", recorded_at: "" })[
    `${key}_visibility`
  ];
  return parseVisibilityScope(rawVisibility) ?? fallback;
}

function eventStepType(eventType: string): TimelineStep["step_type"] {
  if (eventType.startsWith("approval.")) {
    return "approval_step";
  }

  if (eventType.startsWith("recovery.")) {
    return "recovery_step";
  }

  if (eventType.startsWith("action.") || eventType.startsWith("policy.") || eventType.startsWith("execution.") || eventType.startsWith("snapshot.")) {
    return "action_step";
  }

  return "system_step";
}

function actionDisplayName(group: ActionEventGroup): string {
  const normalizedEvent = group.events.find((event) => event.event_type === "action.normalized");
  const operation = payloadRecord(normalizedEvent ?? group.events[0]).operation;

  if (operation && typeof operation === "object") {
    const displayName = (operation as Record<string, unknown>).display_name;
    const name = (operation as Record<string, unknown>).name;

    if (typeof displayName === "string" && displayName.length > 0) {
      return displayName;
    }

    if (typeof name === "string" && name.length > 0) {
      return name;
    }
  }

  return "Governed action";
}

function eventTitle(event: JournalEventRecord): string {
  switch (event.event_type) {
    case "run.created":
      return "Run created";
    case "run.started":
      return "Run started";
    case "action.normalized":
      return "Action normalized";
    case "policy.evaluated":
      return "Policy evaluated";
    case "snapshot.created":
      return "Snapshot created";
    case "execution.started":
      return "Execution started";
    case "execution.completed":
      return "Execution completed";
    case "execution.simulated":
      return "Execution simulated";
    case "execution.failed":
      return "Execution failed";
    case "execution.outcome_unknown":
      return "Execution outcome unknown";
    case "approval.requested":
      return "Approval requested";
    case "approval.resolved":
      return "Approval resolved";
    case "recovery.planned":
      return "Recovery planned";
    case "recovery.executed":
      return "Recovery executed";
    default:
      return event.event_type;
  }
}

function eventSummary(event: JournalEventRecord): string {
  const payload = payloadRecord(event);

  switch (event.event_type) {
    case "run.created":
      return `Registered run for workflow ${String(payload.workflow_name ?? "unknown")}.`;
    case "run.started":
      return "Run entered active execution state.";
    case "action.normalized":
      return `Normalized action ${String(payload.action_id ?? "unknown")} for policy evaluation.`;
    case "policy.evaluated":
      return `Policy decided ${String(payload.decision ?? "unknown")} for action ${String(payload.action_id ?? "unknown")}.`;
    case "snapshot.created":
      return `Created snapshot ${String(payload.snapshot_id ?? "unknown")} before execution.`;
    case "execution.started":
      return `Started execution for action ${String(payload.action_id ?? "unknown")}.`;
    case "execution.completed":
      return `Completed execution ${String(payload.execution_id ?? "unknown")}.`;
    case "execution.simulated":
      return `Simulated execution ${String(payload.execution_id ?? "unknown")}.`;
    case "execution.failed":
      return `Execution failed: ${String(payload.error ?? "unknown error")}.`;
    case "execution.outcome_unknown":
      return String(
        payload.message ??
          `Execution outcome is unknown for action ${String(payload.action_id ?? "unknown")}.`,
      );
    case "approval.requested":
      return `Queued approval ${String(payload.approval_id ?? "unknown")} for action ${String(payload.action_id ?? "unknown")}.`;
    case "approval.resolved":
      return `Approval resolved as ${String(payload.resolution ?? "unknown")}.`;
    case "recovery.planned":
      return payload.recovery_class === "review_only"
        ? "Planned manual recovery review."
        : `Planned recovery strategy ${String(payload.strategy ?? "unknown")}.`;
    case "recovery.executed":
      return payload.outcome === "compensated"
        ? `Executed compensating recovery for ${String(payload.snapshot_id ?? payload.action_id ?? "unknown")}.`
        : `Executed recovery for snapshot ${String(payload.snapshot_id ?? "unknown")}.`;
    default:
      return `Recorded ${event.event_type}.`;
  }
}

function reversibilityForEvent(eventType: string): TimelineStep["reversibility_class"] {
  if (eventType === "snapshot.created" || eventType.startsWith("recovery.")) {
    return "reversible";
  }

  if (eventType === "execution.completed") {
    return "compensatable";
  }

  if (eventType === "execution.simulated") {
    return null;
  }

  return null;
}

function parseRecoveryClass(value: string | null): TimelineStep["reversibility_class"] {
  if (
    value === "reversible" ||
    value === "compensatable" ||
    value === "review_only" ||
    value === "irreversible"
  ) {
    return value;
  }

  return null;
}

function decisionForEvent(event: JournalEventRecord): TimelineStep["decision"] {
  const decision = payloadRecord(event).decision;
  return typeof decision === "string" ? (decision as TimelineStep["decision"]) : null;
}

function reasonMessages(event: JournalEventRecord | undefined): string[] {
  const reasons = payloadRecord(event ?? { sequence: 0, event_type: "", occurred_at: "", recorded_at: "" }).reasons;
  if (!Array.isArray(reasons)) {
    return [];
  }

  return reasons
    .map((reason) =>
      reason && typeof reason === "object" && typeof (reason as Record<string, unknown>).message === "string"
        ? ((reason as Record<string, unknown>).message as string)
        : null,
    )
    .filter((message): message is string => Boolean(message));
}

function visibleReasonMessages(
  event: JournalEventRecord | undefined,
  visibilityScope: VisibilityScope,
  tracker: ProjectionTracker,
): string[] {
  const reasons = reasonMessages(event);
  if (reasons.length === 0) {
    return [];
  }

  if (!canAccessVisibility(payloadVisibilityField(event, "reasons", "user"), visibilityScope)) {
    tracker.redactions_applied += 1;
    return [];
  }

  return reasons;
}

function payloadStringField(event: JournalEventRecord | undefined, key: string): string | null {
  const value = payloadRecord(event ?? { sequence: 0, event_type: "", occurred_at: "", recorded_at: "" })[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function visiblePayloadStringField(
  event: JournalEventRecord | undefined,
  key: string,
  visibilityScope: VisibilityScope,
  tracker: ProjectionTracker,
  fallbackVisibility: VisibilityScope = "user",
): string | null {
  const value = payloadStringField(event, key);
  if (!value) {
    return null;
  }

  if (!canAccessVisibility(payloadVisibilityField(event, key, fallbackVisibility), visibilityScope)) {
    tracker.redactions_applied += 1;
    return null;
  }

  return value;
}

function budgetPreview(value: string, tracker: ProjectionTracker): string | null {
  if (value.length === 0) {
    return null;
  }

  const remainingBudget = MAX_TOTAL_INLINE_PREVIEW_CHARS - tracker.preview_chars_used;
  if (remainingBudget <= 0 || remainingBudget < MIN_REMAINING_PREVIEW_CHARS) {
    tracker.omitted_previews += 1;
    return null;
  }

  const maxLength = Math.min(MAX_INLINE_PREVIEW_CHARS, remainingBudget);
  let preview = value;
  if (value.length > maxLength) {
    tracker.truncated_previews += 1;
    if (maxLength <= 1) {
      tracker.omitted_previews += 1;
      return null;
    }

    preview = `${value.slice(0, maxLength - 1).trimEnd()}…`;
  }

  tracker.preview_chars_used += preview.length;
  return preview;
}

function visiblePayloadPreviewField(
  event: JournalEventRecord | undefined,
  key: string,
  visibilityScope: VisibilityScope,
  tracker: ProjectionTracker,
  fallbackVisibility: VisibilityScope = "user",
): string | null {
  const value = visiblePayloadStringField(event, key, visibilityScope, tracker, fallbackVisibility);
  if (!value) {
    return null;
  }

  return budgetPreview(value, tracker);
}

function payloadNumberField(event: JournalEventRecord | undefined, key: string): number | null {
  const value = payloadRecord(event ?? { sequence: 0, event_type: "", occurred_at: "", recorded_at: "" })[key];
  return typeof value === "number" ? value : null;
}

function payloadStringList(event: JournalEventRecord | undefined, key: string): string[] {
  const value = payloadRecord(event ?? { sequence: 0, event_type: "", occurred_at: "", recorded_at: "" })[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.length > 0);
}

function visiblePayloadStringList(
  event: JournalEventRecord | undefined,
  key: string,
  visibilityScope: VisibilityScope,
  tracker: ProjectionTracker,
  fallbackVisibility: VisibilityScope = "user",
): string[] {
  const value = payloadStringList(event, key);
  if (value.length === 0) {
    return [];
  }

  if (!canAccessVisibility(payloadVisibilityField(event, key, fallbackVisibility), visibilityScope)) {
    tracker.redactions_applied += 1;
    return [];
  }

  return value;
}

interface PayloadArtifactSummary {
  artifact_id: string;
  type: string;
  visibility: VisibilityScope;
  integrity?: NonNullable<TimelineStep["primary_artifacts"][number]["integrity"]>;
}

function payloadArtifactSummaries(event: JournalEventRecord | undefined): PayloadArtifactSummary[] {
  const value = payloadRecord(event ?? { sequence: 0, event_type: "", occurred_at: "", recorded_at: "" }).artifacts;
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry): PayloadArtifactSummary[] => {
      if (entry === null || typeof entry !== "object") {
        return [];
      }

      const candidate = entry as Record<string, unknown>;
      const artifactId = typeof candidate.artifact_id === "string" ? candidate.artifact_id : null;
      const type = typeof candidate.type === "string" ? candidate.type : null;
      const visibility = parseVisibilityScope(candidate.visibility) ?? "user";
      const integrityCandidate =
        candidate.integrity !== null && typeof candidate.integrity === "object"
          ? (candidate.integrity as Record<string, unknown>)
          : null;
      const integrity =
        integrityCandidate &&
        integrityCandidate.schema_version === "artifact-integrity.v1" &&
        integrityCandidate.digest_algorithm === "sha256" &&
        (typeof integrityCandidate.digest === "string" || integrityCandidate.digest === null)
          ? {
              schema_version: "artifact-integrity.v1" as const,
              digest_algorithm: "sha256" as const,
              digest: integrityCandidate.digest,
            }
          : undefined;

      if (!artifactId || !type) {
        return [];
      }

      return [{
        artifact_id: artifactId,
        type,
        visibility,
        integrity,
      }];
    });
}

function visibleArtifactId(
  artifact: PayloadArtifactSummary | undefined,
  visibilityScope: VisibilityScope,
): string | undefined {
  if (!artifact) {
    return undefined;
  }

  return canAccessVisibility(artifact.visibility, visibilityScope) ? artifact.artifact_id : undefined;
}

function visibleArtifactIntegrity(
  artifact: PayloadArtifactSummary | undefined,
  visibilityScope: VisibilityScope,
): PayloadArtifactSummary["integrity"] | undefined {
  if (!artifact) {
    return undefined;
  }

  return canAccessVisibility(artifact.visibility, visibilityScope) ? artifact.integrity : undefined;
}

function parseProvenanceMode(value: unknown): TimelineStep["provenance"] | null {
  return value === "governed" || value === "observed" || value === "imported" || value === "unknown"
    ? value
    : null;
}

function inferredProvenance(event: JournalEventRecord | undefined): TimelineStep["provenance"] {
  const payload = payloadRecord(event ?? { sequence: 0, event_type: "", occurred_at: "", recorded_at: "" });
  const explicitMode = parseProvenanceMode(payload.provenance_mode);
  if (explicitMode) {
    return explicitMode;
  }

  if (event?.event_type === "action.imported") {
    return "imported";
  }

  if (event?.event_type === "action.observed") {
    return "observed";
  }

  if (payload.governed === false) {
    return "unknown";
  }

  return "governed";
}

function provenanceConfidence(event: JournalEventRecord | undefined, fallback = 0.97): number {
  const value = payloadRecord(event ?? { sequence: 0, event_type: "", occurred_at: "", recorded_at: "" })
    .provenance_confidence;
  return typeof value === "number" ? value : fallback;
}

function provenanceSummary(provenance: TimelineStep["provenance"], displayName: string): string {
  switch (provenance) {
    case "observed":
      return `${displayName} was observed after execution and was not controlled pre-execution.`;
    case "imported":
      return `${displayName} was imported from external history and was not governed pre-execution.`;
    case "unknown":
      return `${displayName} has insufficient trustworthy provenance to claim pre-execution control.`;
    default:
      return `${displayName} was processed through the governed pipeline.`;
  }
}

function nonGovernedProvenanceSummary(steps: TimelineStep[]): {
  total: number;
  imported: number;
  observed: number;
  unknown: number;
} {
  const summary = {
    total: 0,
    imported: 0,
    observed: 0,
    unknown: 0,
  };

  for (const step of steps) {
    if (step.provenance === "governed") {
      continue;
    }

    summary.total += 1;

    if (step.provenance === "imported") {
      summary.imported += 1;
    } else if (step.provenance === "observed") {
      summary.observed += 1;
    } else if (step.provenance === "unknown") {
      summary.unknown += 1;
    }
  }

  return summary;
}

function nonGovernedProvenanceClauses(steps: TimelineStep[]): string[] {
  const summary = nonGovernedProvenanceSummary(steps);

  if (summary.total === 0) {
    return [];
  }

  const parts = [
    summary.imported > 0 ? `${summary.imported} imported` : null,
    summary.observed > 0 ? `${summary.observed} observed` : null,
    summary.unknown > 0 ? `${summary.unknown} unknown-provenance` : null,
  ].filter((value): value is string => value !== null);

  return [
    `Trust summary: ${summary.total} non-governed step(s) were recorded${parts.length > 0 ? ` (${parts.join(", ")})` : ""}.`,
  ];
}

function parseDataLossRisk(value: string | null): TimelineStep["related"]["data_loss_risk"] {
  if (value === "low" || value === "moderate" || value === "high" || value === "unknown") {
    return value;
  }

  return null;
}

function actionExternalEffects(sourceEvent: JournalEventRecord | undefined): TimelineStep["external_effects"] {
  const riskHints = payloadRecord(sourceEvent ?? { sequence: 0, event_type: "", occurred_at: "", recorded_at: "" })
    .risk_hints;

  if (!riskHints || typeof riskHints !== "object") {
    return [];
  }

  const externalEffects = (riskHints as Record<string, unknown>).external_effects;
  if (
    externalEffects === "network" ||
    externalEffects === "communication" ||
    externalEffects === "financial" ||
    externalEffects === "unknown"
  ) {
    return [externalEffects];
  }

  return [];
}

function isActionEvent(eventType: string): boolean {
  return (
    eventType.startsWith("action.") ||
    eventType.startsWith("policy.") ||
    eventType.startsWith("snapshot.") ||
    eventType.startsWith("execution.")
  );
}

function isRecoveryEvent(eventType: string): boolean {
  return eventType.startsWith("recovery.");
}

function isApprovalEvent(eventType: string): boolean {
  return eventType.startsWith("approval.");
}

function buildActionStep(
  runId: string,
  group: ActionEventGroup,
  visibilityScope: VisibilityScope,
  tracker: ProjectionTracker,
): TimelineStep {
  const firstEvent = group.events[0]!;
  const normalizedEvent = group.events.find((event) => event.event_type === "action.normalized");
  const importedEvent = group.events.find((event) => event.event_type === "action.imported");
  const observedEvent = group.events.find((event) => event.event_type === "action.observed");
  const policyEvent = group.events.find((event) => event.event_type === "policy.evaluated");
  const snapshotEvent = group.events.find((event) => event.event_type === "snapshot.created");
  const executionCompletedEvent = group.events.find((event) => event.event_type === "execution.completed");
  const executionSimulatedEvent = group.events.find((event) => event.event_type === "execution.simulated");
  const executionFailedEvent = group.events.find((event) => event.event_type === "execution.failed");
  const executionUnknownEvent = group.events.find((event) => event.event_type === "execution.outcome_unknown");
  const displayName = actionDisplayName(group);
  const provenance = inferredProvenance(normalizedEvent ?? importedEvent ?? observedEvent ?? firstEvent);
  const decision = policyEvent ? decisionForEvent(policyEvent) : null;
  const externalEffects = actionExternalEffects(normalizedEvent ?? importedEvent ?? observedEvent ?? firstEvent);
  const normalizedPayload = payloadRecord(normalizedEvent ?? firstEvent);
  const executionPayload = payloadRecord(
    executionCompletedEvent ?? executionSimulatedEvent ?? executionFailedEvent ?? executionUnknownEvent ?? firstEvent,
  );
  const artifactTypes = Array.isArray(executionPayload.artifact_types)
    ? executionPayload.artifact_types.filter((value): value is string => typeof value === "string")
    : [];
  const artifactSummaries = payloadArtifactSummaries(executionCompletedEvent);
  const artifactSummaryByType = new Map<string, PayloadArtifactSummary[]>();
  for (const artifact of artifactSummaries) {
    const existing = artifactSummaryByType.get(artifact.type) ?? [];
    existing.push(artifact);
    artifactSummaryByType.set(artifact.type, existing);
  }
  const targetLocator =
    visiblePayloadStringField(normalizedEvent, "target_locator", visibilityScope, tracker) ??
    visiblePayloadStringField(executionCompletedEvent, "target_path", visibilityScope, tracker);
  const filesystemOperation = payloadStringField(normalizedEvent, "filesystem_operation") ?? payloadStringField(executionCompletedEvent, "operation");
  const inputPreview = visiblePayloadPreviewField(normalizedEvent, "input_preview", visibilityScope, tracker);
  const diffPreview = visiblePayloadPreviewField(executionCompletedEvent, "diff_preview", visibilityScope, tracker);
  const beforePreview = visiblePayloadPreviewField(executionCompletedEvent, "before_preview", visibilityScope, tracker);
  const afterPreview = visiblePayloadPreviewField(executionCompletedEvent, "after_preview", visibilityScope, tracker);
  const policyWarnings = visibleReasonMessages(policyEvent, visibilityScope, tracker);
  const policyReasons = policyEvent ? payloadRecord(policyEvent).reasons : null;
  const primaryReason = reasonDetailFromUnknown(Array.isArray(policyReasons) ? policyReasons[0] : null);
  const executionWarnings = visiblePayloadStringList(executionCompletedEvent, "warnings", visibilityScope, tracker);
  const warnings = [...policyWarnings, ...executionWarnings];
  const artifactCaptureFailedCount = payloadNumberField(executionCompletedEvent, "artifact_capture_failed_count");

  let status: TimelineStep["status"] = "completed";
  if (decision === "deny") {
    status = "blocked";
  } else if (executionFailedEvent) {
    status = "failed";
  } else if (executionUnknownEvent) {
    status = "partial";
  } else if (executionCompletedEvent || executionSimulatedEvent) {
    status = "completed";
  } else if (decision === "ask") {
    status = "awaiting_approval";
  }

  let summary = provenanceSummary(provenance, displayName);
  if (executionFailedEvent) {
    const exitCode = payloadNumberField(executionFailedEvent, "exit_code");
    const stderrExcerpt = visiblePayloadPreviewField(executionFailedEvent, "stderr_excerpt", visibilityScope, tracker);
    const errorMessage = visiblePayloadPreviewField(executionFailedEvent, "error", visibilityScope, tracker);
    const attemptedPrefix =
      decision === "ask"
        ? `Attempted ${displayName} after approval, but`
        : decision === "allow_with_snapshot" && snapshotEvent
          ? `Attempted ${displayName} after creating snapshot ${String(payloadRecord(snapshotEvent).snapshot_id ?? "unknown")}, but`
          : `Attempted ${displayName}, but`;

    if (typeof exitCode === "number") {
      summary = `${attemptedPrefix} it exited with code ${exitCode}.`;
    } else if (errorMessage) {
      summary = `${attemptedPrefix} execution failed. ${errorMessage}`;
    } else {
      summary = `${attemptedPrefix} execution failed.`;
    }

    if (stderrExcerpt) {
      summary = `${summary} stderr: ${stderrExcerpt}`;
    }
  } else if (executionUnknownEvent) {
    const message = visiblePayloadPreviewField(executionUnknownEvent, "message", visibilityScope, tracker);
    const prefix =
      decision === "ask"
        ? `${displayName} was approved and started, but`
        : decision === "allow_with_snapshot" && snapshotEvent
          ? `${displayName} started after creating snapshot ${String(payloadRecord(snapshotEvent).snapshot_id ?? "unknown")}, but`
          : `${displayName} started, but`;
    summary = message
      ? `${prefix} its final outcome is unknown. ${message}`
      : `${prefix} its final outcome is unknown.`;
  } else if (decision === "allow_with_snapshot" && snapshotEvent && executionCompletedEvent) {
    summary = `Executed ${displayName} after creating snapshot ${String(payloadRecord(snapshotEvent).snapshot_id ?? "unknown")}.`;
  } else if (decision === "allow_with_snapshot" && snapshotEvent && executionSimulatedEvent) {
    summary = `Simulated ${displayName} after creating snapshot ${String(payloadRecord(snapshotEvent).snapshot_id ?? "unknown")}.`;
  } else if (decision === "allow" && executionCompletedEvent) {
    summary = `Executed ${displayName}.`;
  } else if (decision === "allow" && executionSimulatedEvent) {
    summary = `Simulated ${displayName}.`;
  } else if (decision === "ask" && executionCompletedEvent) {
    summary = `Executed ${displayName} after approval.`;
  } else if (decision === "ask" && executionSimulatedEvent) {
    summary = `Simulated ${displayName} after approval.`;
  } else if (decision === "deny") {
    const reasons = reasonMessages(policyEvent);
    summary =
      reasons.length > 0
        ? `Blocked ${displayName}. ${reasons[0]}`
        : `Blocked ${displayName} because policy denied it.`;
  } else if (decision === "ask") {
    const reasons = reasonMessages(policyEvent);
    summary =
      reasons.length > 0
        ? `Paused ${displayName} pending approval. ${reasons[0]}`
        : `Paused ${displayName} pending approval.`;
  } else if (provenance !== "governed") {
    summary = provenanceSummary(provenance, displayName);
  }

  if (executionCompletedEvent && artifactCaptureFailedCount && artifactCaptureFailedCount > 0) {
    summary = `${summary} Supporting evidence capture was degraded for ${artifactCaptureFailedCount} artifact(s).`;
  }

  const primaryArtifacts: TimelineStep["primary_artifacts"] = [];
  const artifactPreviews: TimelineStep["artifact_previews"] = [];
  if (snapshotEvent) {
    primaryArtifacts.push({
      type: "snapshot",
      label: String(payloadRecord(snapshotEvent).snapshot_id ?? "snapshot"),
    });
  }
  if (executionCompletedEvent) {
    primaryArtifacts.push({
      type: "execution",
      label: String(payloadRecord(executionCompletedEvent).execution_id ?? "execution"),
    });
    const fileContentArtifact = artifactSummaryByType.get("file_content")?.[0];
    if (artifactTypes.includes("file_content")) {
      primaryArtifacts.push({
        artifact_id: visibleArtifactId(fileContentArtifact, visibilityScope),
        integrity: visibleArtifactIntegrity(fileContentArtifact, visibilityScope),
        type: "file_content",
        label: targetLocator ?? "file",
      });
    }
    const diffArtifact = artifactSummaryByType.get("diff")?.[0];
    if (artifactTypes.includes("diff")) {
      primaryArtifacts.push({
        artifact_id: visibleArtifactId(diffArtifact, visibilityScope),
        integrity: visibleArtifactIntegrity(diffArtifact, visibilityScope),
        type: "diff",
        label: targetLocator ?? "diff",
      });
    }
    const requestResponseArtifact = artifactSummaryByType.get("request_response")?.[0];
    if (artifactTypes.includes("request_response")) {
      primaryArtifacts.push({
        artifact_id: visibleArtifactId(requestResponseArtifact, visibilityScope),
        integrity: visibleArtifactIntegrity(requestResponseArtifact, visibilityScope),
        type: "request_response",
        label: "request/response",
      });
    }
    const stdoutArtifact = artifactSummaryByType.get("stdout")?.[0];
    const stdoutExcerpt = visiblePayloadPreviewField(executionCompletedEvent, "stdout_excerpt", visibilityScope, tracker);
    if (stdoutExcerpt) {
      primaryArtifacts.push({
        artifact_id: visibleArtifactId(stdoutArtifact, visibilityScope),
        integrity: visibleArtifactIntegrity(stdoutArtifact, visibilityScope),
        type: "stdout",
        label: "stdout",
      });
      artifactPreviews.push({
        type: "stdout",
        label: "stdout",
        preview: stdoutExcerpt,
      });
    }
    const stderrArtifact = artifactSummaryByType.get("stderr")?.[0];
    const stderrExcerpt = visiblePayloadPreviewField(executionCompletedEvent, "stderr_excerpt", visibilityScope, tracker);
    if (stderrExcerpt) {
      primaryArtifacts.push({
        artifact_id: visibleArtifactId(stderrArtifact, visibilityScope),
        integrity: visibleArtifactIntegrity(stderrArtifact, visibilityScope),
        type: "stderr",
        label: "stderr",
      });
      artifactPreviews.push({
        type: "stderr",
        label: "stderr",
        preview: stderrExcerpt,
      });
    }
  }
  if (executionSimulatedEvent) {
    primaryArtifacts.push({
      type: "execution",
      label: String(payloadRecord(executionSimulatedEvent).execution_id ?? "simulation"),
    });
  }
  if (executionFailedEvent) {
    const stdoutExcerpt = visiblePayloadPreviewField(executionFailedEvent, "stdout_excerpt", visibilityScope, tracker);
    if (stdoutExcerpt) {
      primaryArtifacts.push({
        type: "stdout",
        label: "stdout",
      });
      artifactPreviews.push({
        type: "stdout",
        label: "stdout",
        preview: stdoutExcerpt,
      });
    }
    const stderrExcerpt = visiblePayloadPreviewField(executionFailedEvent, "stderr_excerpt", visibilityScope, tracker);
    if (stderrExcerpt) {
      primaryArtifacts.push({
        type: "stderr",
        label: "stderr",
      });
      artifactPreviews.push({
        type: "stderr",
        label: "stderr",
        preview: stderrExcerpt,
      });
    }
  }
  if (executionUnknownEvent) {
    primaryArtifacts.push({
      type: "execution_outcome_unknown",
      label: "outcome unknown",
    });
  }

  if (artifactTypes.includes("file_content") && inputPreview) {
    artifactPreviews.push({
      type: "file_content",
      label: targetLocator ?? "file",
      preview: inputPreview,
    });
  } else if (filesystemOperation === "delete" && targetLocator) {
    artifactPreviews.push({
      type: "file_content",
      label: targetLocator,
      preview: `Removed ${targetLocator}.`,
    });
  }

  if (diffPreview) {
    artifactPreviews.push({
      type: "diff",
      label: targetLocator ?? "diff",
      preview: diffPreview,
    });
  } else if (beforePreview || afterPreview) {
    const summaryParts = [
      beforePreview ? `before: ${beforePreview}` : null,
      afterPreview ? `after: ${afterPreview}` : null,
    ].filter((value): value is string => value !== null);
    if (summaryParts.length > 0) {
      artifactPreviews.push({
        type: "diff",
        label: targetLocator ?? "diff",
        preview: summaryParts.join(" | "),
      });
    }
  }

  return {
    schema_version: "timeline-step.v1",
    step_id: `step_${runId}_action_${group.actionId}`,
    run_id: runId,
    sequence: firstEvent.sequence,
    step_type: provenance === "governed" ? "action_step" : "analysis_step",
    title: displayName,
    status,
    provenance,
    action_id: group.actionId,
    decision,
    primary_reason: primaryReason,
    reversibility_class:
      snapshotEvent
        ? "reversible"
        : executionCompletedEvent
          ? "compensatable"
          : provenance === "governed"
            ? null
            : "review_only",
    confidence: provenanceConfidence(normalizedEvent ?? importedEvent ?? observedEvent ?? firstEvent, provenance === "governed" ? 0.97 : 0.61),
    summary,
    warnings,
    primary_artifacts: primaryArtifacts,
    artifact_previews: artifactPreviews,
    external_effects: externalEffects,
    related: {
      snapshot_id:
        snapshotEvent && typeof payloadRecord(snapshotEvent).snapshot_id === "string"
          ? (payloadRecord(snapshotEvent).snapshot_id as string)
          : null,
      execution_id:
        executionCompletedEvent && typeof payloadRecord(executionCompletedEvent).execution_id === "string"
          ? (payloadRecord(executionCompletedEvent).execution_id as string)
          : executionSimulatedEvent && typeof payloadRecord(executionSimulatedEvent).execution_id === "string"
          ? (payloadRecord(executionSimulatedEvent).execution_id as string)
          : null,
      recovery_plan_ids: [],
      target_locator: targetLocator,
      recovery_target_type: null,
      recovery_target_label: null,
      recovery_scope_paths: [],
      recovery_strategy: null,
      later_actions_affected: null,
      overlapping_paths: [],
      data_loss_risk: null,
    },
    occurred_at: firstEvent.occurred_at,
  };
}

function buildRecoveryStep(
  runId: string,
  group: RecoveryEventGroup,
  visibilityScope: VisibilityScope,
  tracker: ProjectionTracker,
): TimelineStep {
  const firstEvent = group.events[0]!;
  const plannedEvent = group.events.find((event) => event.event_type === "recovery.planned");
  const executedEvent = group.events.find((event) => event.event_type === "recovery.executed");
  const recoveryPlanIds = group.events
    .map((event) => payloadRecord(event).recovery_plan_id)
    .filter((value): value is string => typeof value === "string");
  const warnings = visiblePayloadStringList(plannedEvent ?? executedEvent ?? firstEvent, "warnings", visibilityScope, tracker);
  const targetPath = visiblePayloadStringField(executedEvent, "target_path", visibilityScope, tracker);
  const targetLocator =
    visiblePayloadStringField(plannedEvent ?? executedEvent ?? firstEvent, "target_locator", visibilityScope, tracker) ?? targetPath;
  const existedBefore = payloadRecord(executedEvent ?? firstEvent).existed_before;
  const laterActionsAffected = payloadNumberField(plannedEvent ?? executedEvent ?? firstEvent, "later_actions_affected");
  const overlappingPaths = visiblePayloadStringList(
    plannedEvent ?? executedEvent ?? firstEvent,
    "overlapping_paths",
    visibilityScope,
    tracker,
  );
  const dataLossRisk = parseDataLossRisk(
    visiblePayloadStringField(plannedEvent ?? executedEvent ?? firstEvent, "data_loss_risk", visibilityScope, tracker),
  );
  const externalEffects = visiblePayloadStringList(
    plannedEvent ?? executedEvent ?? firstEvent,
    "external_effects",
    visibilityScope,
    tracker,
  ).filter(
    (value): value is TimelineStep["external_effects"][number] =>
      value === "network" || value === "communication" || value === "financial" || value === "unknown",
  );
  const boundaryLabel = group.actionId ?? group.snapshotId ?? group.recoveryKey;
  const targetType = parseRecoveryTargetType(payloadStringField(plannedEvent ?? executedEvent ?? firstEvent, "target_type"));
  const runCheckpoint = payloadStringField(plannedEvent ?? executedEvent ?? firstEvent, "run_checkpoint");
  const branchPointRunId = payloadStringField(plannedEvent ?? executedEvent ?? firstEvent, "branch_point_run_id");
  const branchPointSequence = payloadNumberField(plannedEvent ?? executedEvent ?? firstEvent, "branch_point_sequence");
  const externalObjectId = payloadStringField(plannedEvent ?? executedEvent ?? firstEvent, "external_object_id");
  const targetPaths = visiblePayloadStringList(
    plannedEvent ?? executedEvent ?? firstEvent,
    "target_paths",
    visibilityScope,
    tracker,
  );
  const recoveryDowngradeReasonCode = visiblePayloadStringField(
    plannedEvent ?? executedEvent ?? firstEvent,
    "downgrade_reason_code",
    visibilityScope,
    tracker,
  );
  const recoveryDowngradeReasonMessage = visiblePayloadStringField(
    plannedEvent ?? executedEvent ?? firstEvent,
    "downgrade_reason_message",
    visibilityScope,
    tracker,
  );
  const recoveryTargetLabel = formatRecoveryTargetLabel({
    targetType,
    snapshotId: group.snapshotId,
    actionId: group.actionId,
    runCheckpoint,
    branchPointRunId,
    branchPointSequence,
    externalObjectId,
    targetPaths,
    boundaryLabel,
  });
  const recoveryClass =
    parseRecoveryClass(payloadStringField(plannedEvent ?? executedEvent ?? firstEvent, "recovery_class")) ??
    "reversible";
  const strategy = visiblePayloadStringField(plannedEvent ?? executedEvent ?? firstEvent, "strategy", visibilityScope, tracker);
  const executionOutcome = visiblePayloadStringField(executedEvent ?? firstEvent, "outcome", visibilityScope, tracker);
  const restorePreview =
    targetType === "path_subset" && targetPaths.length > 0
      ? `Restored requested path subset from ${recoveryTargetLabel}.`
      : typeof targetPath === "string" && targetPath.length > 0
      ? existedBefore === false
        ? `Removed ${targetPath} to match the recovery target's original missing state.`
        : `Restored ${targetPath} from ${recoveryTargetLabel}.`
      : `Restored ${recoveryTargetLabel}.`;
  const compensationPreview = strategy
    ? `Executed ${strategy} for ${recoveryTargetLabel}.`
    : `Executed compensating recovery for ${recoveryTargetLabel}.`;
  const plannedSummary =
    recoveryClass === "review_only"
      ? `Planned manual review for ${recoveryTargetLabel}.`
      : strategy
        ? `Planned ${strategy} for ${recoveryTargetLabel}.`
        : `Planned recovery for ${recoveryTargetLabel}.`;
  const recoveryArtifactPreview = executedEvent
    ? budgetPreview(executionOutcome === "compensated" ? compensationPreview : restorePreview, tracker)
    : null;

  return {
    schema_version: "timeline-step.v1",
    step_id: `step_${runId}_recovery_${group.recoveryKey}`,
    run_id: runId,
    sequence: firstEvent.sequence,
    step_type: "recovery_step",
    title: executedEvent
      ? executionOutcome === "compensated"
        ? "Compensation executed"
        : "Recovery executed"
      : recoveryClass === "review_only"
        ? "Manual review planned"
        : "Recovery planned",
    status: executedEvent ? "completed" : "completed",
    provenance: "governed",
    action_id: group.actionId,
    decision: null,
    reversibility_class: recoveryClass,
    confidence: recoveryClass === "review_only" ? 0.55 : 0.97,
    summary: executedEvent
      ? executionOutcome === "compensated"
        ? compensationPreview
        : `Executed recovery for ${recoveryTargetLabel}.`
      : plannedSummary,
    warnings,
    primary_artifacts: [
      {
        type: group.snapshotId ? "snapshot" : "recovery_boundary",
        label: recoveryTargetLabel,
      },
    ],
    artifact_previews:
      executedEvent && recoveryArtifactPreview
        ? [
            {
              type: executionOutcome === "compensated" ? "compensation" : "restore",
              label: recoveryTargetLabel,
              preview: recoveryArtifactPreview,
            },
          ]
        : [],
    external_effects: externalEffects,
    related: {
      snapshot_id: group.snapshotId,
      execution_id: null,
      recovery_plan_ids: recoveryPlanIds,
      target_locator: targetLocator,
      recovery_target_type: targetType,
      recovery_target_label: recoveryTargetLabel,
      recovery_scope_paths: targetPaths,
      recovery_strategy: strategy,
      recovery_downgrade_reason:
        recoveryDowngradeReasonCode && recoveryDowngradeReasonMessage
          ? {
              code: recoveryDowngradeReasonCode,
              message: recoveryDowngradeReasonMessage,
            }
          : null,
      later_actions_affected: laterActionsAffected,
      overlapping_paths: overlappingPaths,
      data_loss_risk: dataLossRisk,
    },
    occurred_at: firstEvent.occurred_at,
  };
}

function buildApprovalStep(runId: string, group: ApprovalEventGroup): TimelineStep {
  const firstEvent = group.events[0]!;
  const requestedEvent = group.events.find((event) => event.event_type === "approval.requested");
  const resolvedEvent = group.events.find((event) => event.event_type === "approval.resolved");
  const resolution = resolvedEvent ? payloadRecord(resolvedEvent).resolution : null;
  const actionSummary = String(
    payloadRecord(requestedEvent ?? firstEvent).action_summary ?? payloadRecord(resolvedEvent ?? firstEvent).action_summary ?? "action",
  );
  const resolutionNote = payloadRecord(resolvedEvent ?? firstEvent).resolution_note;
  const actionId =
    typeof payloadRecord(firstEvent).action_id === "string" ? (payloadRecord(firstEvent).action_id as string) : null;
  const primaryReason = reasonDetailFromUnknown(payloadRecord(requestedEvent ?? firstEvent).primary_reason);

  let status: TimelineStep["status"] = "awaiting_approval";
  let summary = `${actionSummary} is waiting for approval.`;
  if (resolution === "approved") {
    status = "completed";
    summary =
      typeof resolutionNote === "string" && resolutionNote.length > 0
        ? `Approved ${actionSummary}. Note: ${resolutionNote}`
        : `Approved ${actionSummary}.`;
  } else if (resolution === "denied") {
    status = "blocked";
    summary =
      typeof resolutionNote === "string" && resolutionNote.length > 0
        ? `Denied ${actionSummary}. Note: ${resolutionNote}`
        : `Denied ${actionSummary}.`;
  }

  return {
    schema_version: "timeline-step.v1",
    step_id: `step_${runId}_approval_${group.approvalId}`,
    run_id: runId,
    sequence: firstEvent.sequence,
    step_type: "approval_step",
    title: resolvedEvent ? "Approval resolved" : "Approval requested",
    status,
    provenance: "governed",
    action_id: actionId,
    decision: null,
    primary_reason: primaryReason,
    reversibility_class: null,
    confidence: 0.96,
    summary,
    warnings: [],
    primary_artifacts: [],
    artifact_previews: [],
    external_effects: [],
    related: {
      snapshot_id: null,
      execution_id: null,
      recovery_plan_ids: [],
      target_locator: null,
      recovery_target_type: null,
      recovery_target_label: null,
      recovery_scope_paths: [],
      recovery_strategy: null,
      later_actions_affected: null,
      overlapping_paths: [],
      data_loss_risk: null,
    },
    occurred_at: requestedEvent?.occurred_at ?? firstEvent.occurred_at,
  };
}

export function projectTimelineView(
  runId: string,
  events: JournalEventRecord[],
  visibilityScope: VisibilityScope = "user",
): TimelineProjectionView {
  const actionGroups = new Map<string, ActionEventGroup>();
  const recoveryGroups = new Map<string, RecoveryEventGroup>();
  const approvalGroups = new Map<string, ApprovalEventGroup>();
  const standaloneEvents: JournalEventRecord[] = [];
  const tracker: ProjectionTracker = {
    redactions_applied: 0,
    preview_chars_used: 0,
    truncated_previews: 0,
    omitted_previews: 0,
  };

  for (const event of events) {
    const payload = payloadRecord(event);
    const actionId = typeof payload.action_id === "string" ? payload.action_id : null;
    const snapshotId = typeof payload.snapshot_id === "string" ? payload.snapshot_id : null;
    const approvalId = typeof payload.approval_id === "string" ? payload.approval_id : null;

    if (isActionEvent(event.event_type) && actionId) {
      const existing = actionGroups.get(actionId) ?? { actionId, events: [] };
      existing.events.push(event);
      actionGroups.set(actionId, existing);
      continue;
    }

    const recoveryKey = snapshotId ?? actionId;
    if (isRecoveryEvent(event.event_type) && recoveryKey) {
      const existing = recoveryGroups.get(recoveryKey) ?? { recoveryKey, snapshotId, actionId, events: [] };
      existing.events.push(event);
      recoveryGroups.set(recoveryKey, {
        recoveryKey,
        snapshotId: existing.snapshotId ?? snapshotId,
        actionId: existing.actionId ?? actionId,
        events: existing.events,
      });
      continue;
    }

    if (isApprovalEvent(event.event_type) && approvalId) {
      const existing = approvalGroups.get(approvalId) ?? { approvalId, events: [] };
      existing.events.push(event);
      approvalGroups.set(approvalId, existing);
      continue;
    }

    standaloneEvents.push(event);
  }

  const projectedSteps: TimelineStep[] = [
    ...standaloneEvents.map((event): TimelineStep => ({
      schema_version: "timeline-step.v1",
      step_id: `step_${runId}_${event.sequence}`,
      run_id: runId,
      sequence: event.sequence,
      step_type: eventStepType(event.event_type),
      title: eventTitle(event),
      status: eventStatus(event.event_type),
      provenance: "governed",
      action_id: null,
      decision: null,
      reversibility_class: reversibilityForEvent(event.event_type),
      confidence: 0.95,
      summary: eventSummary(event),
      warnings: [],
      primary_artifacts: [],
      artifact_previews: [],
      external_effects: [],
      related: {
        snapshot_id: null,
        execution_id: null,
        recovery_plan_ids: [],
        target_locator: null,
        recovery_target_type: null,
        recovery_target_label: null,
        recovery_scope_paths: [],
        recovery_strategy: null,
        later_actions_affected: null,
        overlapping_paths: [],
        data_loss_risk: null,
      },
      occurred_at: event.occurred_at,
    })),
    ...Array.from(actionGroups.values()).map((group) => buildActionStep(runId, group, visibilityScope, tracker)),
    ...Array.from(approvalGroups.values()).map((group) => buildApprovalStep(runId, group)),
    ...Array.from(recoveryGroups.values()).map((group) => buildRecoveryStep(runId, group, visibilityScope, tracker)),
  ];

  return {
    visibility_scope: visibilityScope,
    redactions_applied: tracker.redactions_applied,
    preview_budget: {
      max_inline_preview_chars: MAX_INLINE_PREVIEW_CHARS,
      max_total_inline_preview_chars: MAX_TOTAL_INLINE_PREVIEW_CHARS,
      preview_chars_used: tracker.preview_chars_used,
      truncated_previews: tracker.truncated_previews,
      omitted_previews: tracker.omitted_previews,
    },
    steps: projectedSteps.sort((left, right) => left.sequence - right.sequence),
  };
}

export function projectTimelineSteps(
  runId: string,
  events: JournalEventRecord[],
  visibilityScope: VisibilityScope = "user",
): TimelineStep[] {
  return projectTimelineView(runId, events, visibilityScope).steps;
}

export function answerHelperQuery(
  questionType: HelperQuestionType,
  steps: TimelineStep[],
  focusStepId?: string,
  compareStepId?: string,
): HelperAnswer {
  switch (questionType) {
    case "run_summary":
    case "what_happened": {
      const last = steps[steps.length - 1];
      const actionSteps = steps.filter((step) => step.step_type === "action_step").length;
      const analysisSteps = steps.filter((step) => step.step_type === "analysis_step").length;
      const approvalSteps = steps.filter((step) => step.step_type === "approval_step").length;
      const recoverySteps = steps.filter((step) => step.step_type === "recovery_step").length;
      const completedSteps = steps.filter((step) => step.status === "completed").length;
      const failedSteps = steps.filter((step) => step.status === "failed").length;
      const partialSteps = steps.filter((step) => step.status === "partial").length;
      const blockedSteps = steps.filter(
        (step) => step.status === "blocked" || step.status === "awaiting_approval",
      ).length;
      const trustClauses = nonGovernedProvenanceClauses(steps);
      const statusParts = [
        `${completedSteps} completed`,
        failedSteps > 0 ? `${failedSteps} failed` : null,
        partialSteps > 0 ? `${partialSteps} partial` : null,
        blockedSteps > 0 ? `${blockedSteps} blocked or awaiting approval` : null,
      ].filter((value): value is string => value !== null);

      return {
        answer: [
          `This run recorded ${steps.length} timeline steps across ${actionSteps} action step(s), ${analysisSteps} analysis step(s), ${approvalSteps} approval step(s), and ${recoverySteps} recovery step(s).`,
          `Status summary: ${statusParts.join(", ")}.`,
          ...trustClauses,
          `Latest step: ${last?.title ?? "none"}.`,
        ].join(" "),
        confidence: 0.95,
        evidence: steps.slice(-3).map((step) => ({
          step_id: step.step_id,
          sequence: step.sequence,
          title: step.title,
        })),
        uncertainty:
          trustClauses.length > 0
            ? ["Some recorded steps were not governed pre-execution, so trust and reversibility claims should be read more carefully."]
            : [],
      };
    }
    case "step_details": {
      if (!focusStepId) {
        return {
          answer: "A focus step id is required to explain one specific timeline step.",
          confidence: 0.35,
          evidence: [],
          uncertainty: ["No focus_step_id was provided."],
        };
      }

      const focusStep = steps.find((step) => step.step_id === focusStepId);
      if (!focusStep) {
        return {
          answer: `No timeline step matched ${focusStepId}.`,
          confidence: 0.25,
          evidence: [],
          uncertainty: ["The requested focus step id was not found in this run."],
        };
      }

      const detailParts = [
        `${focusStep.title} is a ${focusStep.step_type.replace("_", " ")} with status ${focusStep.status}.`,
      ];

      if (focusStep.decision) {
        detailParts.push(`Policy decision: ${focusStep.decision}.`);
      }

      if (focusStep.primary_reason) {
        detailParts.push(`Primary reason: ${focusStep.primary_reason.code} - ${focusStep.primary_reason.message}.`);
      }

      if (focusStep.reversibility_class) {
        detailParts.push(`Reversibility: ${focusStep.reversibility_class}.`);
      }

      if (focusStep.provenance !== "governed") {
        detailParts.push(`Trust level: ${focusStep.provenance}.`);
      }

      if (focusStep.related.target_locator) {
        detailParts.push(`Target: ${focusStep.related.target_locator}.`);
      }

      if (focusStep.related.recovery_target_type && focusStep.related.recovery_target_label) {
        detailParts.push(`Recovery target: ${focusStep.related.recovery_target_type} (${focusStep.related.recovery_target_label}).`);
      }

      if (focusStep.related.recovery_scope_paths && focusStep.related.recovery_scope_paths.length > 0) {
        detailParts.push(`Recovery scope: ${focusStep.related.recovery_scope_paths.join(", ")}.`);
      }

      if (focusStep.related.recovery_strategy) {
        detailParts.push(`Recovery strategy: ${focusStep.related.recovery_strategy}.`);
      }

      if (focusStep.primary_artifacts.length > 0) {
        const artifactSummary = focusStep.primary_artifacts
          .slice(0, 4)
          .map((artifact: TimelineStep["primary_artifacts"][number]) =>
            artifact.count !== undefined
              ? `${artifact.type} x${artifact.count}${artifact.label ? ` (${artifact.label})` : ""}${
                  artifact.artifact_id ? ` [${artifact.artifact_id}]` : ""
                }`
              : `${artifact.type}${artifact.label ? ` (${artifact.label})` : ""}${
                  artifact.artifact_id ? ` [${artifact.artifact_id}]` : ""
                }`,
          )
          .join(", ");
        detailParts.push(`Artifacts: ${artifactSummary}.`);
      }

      if (focusStep.artifact_previews.length > 0) {
        const previewSummary = focusStep.artifact_previews
          .slice(0, 3)
          .map((artifact: TimelineStep["artifact_previews"][number]) => `${artifact.label ?? artifact.type}: ${artifact.preview}`)
          .join(" | ");
        detailParts.push(`Artifact previews: ${previewSummary}.`);
      }

      if (focusStep.external_effects.length > 0) {
        detailParts.push(`External effect hints: ${focusStep.external_effects.join(", ")}.`);
      }

      if (focusStep.related.snapshot_id) {
        detailParts.push(`Snapshot: ${focusStep.related.snapshot_id}.`);
      }

      if (focusStep.step_type === "recovery_step" && focusStep.action_id) {
        detailParts.push(`Recovery boundary action: ${focusStep.action_id}.`);
      }

      if (focusStep.related.execution_id) {
        detailParts.push(`Execution: ${focusStep.related.execution_id}.`);
      }

      const recoveryPlanIds = focusStep.related.recovery_plan_ids ?? [];
      if (recoveryPlanIds.length > 0) {
        detailParts.push(`Recovery plans: ${recoveryPlanIds.join(", ")}.`);
      }

      if (focusStep.related.later_actions_affected && focusStep.related.later_actions_affected > 0) {
        detailParts.push(
          focusStep.related.overlapping_paths && focusStep.related.overlapping_paths.length > 0
            ? `Later-action overlap: ${focusStep.related.later_actions_affected} later action(s) touching ${focusStep.related.overlapping_paths.slice(0, 3).join(", ")}.`
            : `Later-action overlap: ${focusStep.related.later_actions_affected} later action(s).`,
        );
      }

      if (focusStep.related.data_loss_risk) {
        detailParts.push(`Data loss risk: ${focusStep.related.data_loss_risk}.`);
      }

      if (focusStep.related.recovery_downgrade_reason) {
        detailParts.push(
          `Recovery downgrade reason: ${focusStep.related.recovery_downgrade_reason.code} - ${focusStep.related.recovery_downgrade_reason.message}.`,
        );
      }

      if ((focusStep.warnings ?? []).length > 0) {
        detailParts.push(`Warnings: ${(focusStep.warnings ?? []).slice(0, 3).join(" | ")}.`);
      }

      detailParts.push(`Recorded summary: ${focusStep.summary}`);

      return {
        answer: detailParts.join(" "),
        confidence: Math.max(0.75, focusStep.confidence),
        primary_reason: focusStep.primary_reason ?? null,
        evidence: [
          {
            step_id: focusStep.step_id,
            sequence: focusStep.sequence,
            title: focusStep.title,
          },
        ],
        uncertainty: [],
      };
    }
    case "explain_policy_decision": {
      if (!focusStepId) {
        return {
          answer: "A focus step id is required to explain a policy decision.",
          confidence: 0.35,
          primary_reason: null,
          evidence: [],
          uncertainty: ["No focus_step_id was provided."],
        };
      }

      const focusStep = steps.find((step) => step.step_id === focusStepId);
      if (!focusStep) {
        return {
          answer: `No timeline step matched ${focusStepId}.`,
          confidence: 0.25,
          primary_reason: null,
          evidence: [],
          uncertainty: ["The requested focus step id was not found in this run."],
        };
      }

      if (!focusStep.decision) {
        return {
          answer: `${focusStep.title} does not carry a recorded policy decision in the current projection.`,
          confidence: 0.55,
          primary_reason: focusStep.primary_reason ?? null,
          evidence: [
            {
              step_id: focusStep.step_id,
              sequence: focusStep.sequence,
              title: focusStep.title,
            },
          ],
          uncertainty: ["This step may represent execution, recovery, or system activity rather than a policy-evaluated action."],
        };
      }

      const decisionParts = [`${focusStep.title} was evaluated as ${focusStep.decision}.`];

      if (focusStep.related.target_locator) {
        decisionParts.push(`Target: ${focusStep.related.target_locator}.`);
      }

      if ((focusStep.warnings ?? []).length > 0) {
        decisionParts.push(`Recorded reasons: ${(focusStep.warnings ?? []).slice(0, 3).join(" | ")}.`);
      } else {
        decisionParts.push("No explicit policy reason messages were recorded for this step.");
      }

      if (focusStep.primary_reason) {
        decisionParts.push(`Primary reason code: ${focusStep.primary_reason.code}.`);
      }

      if (focusStep.reversibility_class) {
        decisionParts.push(`Current reversibility signal: ${focusStep.reversibility_class}.`);
      }

      return {
        answer: decisionParts.join(" "),
        confidence: Math.max(0.74, focusStep.confidence),
        primary_reason: focusStep.primary_reason ?? null,
        evidence: [
          {
            step_id: focusStep.step_id,
            sequence: focusStep.sequence,
            title: focusStep.title,
          },
        ],
        uncertainty:
          (focusStep.warnings ?? []).length > 0
            ? []
            : ["The projection includes the decision, but not a richer policy explanation beyond the action summary."],
      };
    }
    case "reversible_steps": {
      const reversible = steps.filter((step) => step.reversibility_class === "reversible");
      return {
        answer:
          reversible.length > 0
            ? `Found ${reversible.length} reversible step(s) in this run.`
            : "No explicitly reversible steps were found in this run.",
        confidence: 0.92,
        evidence: reversible.map((step) => ({
          step_id: step.step_id,
          sequence: step.sequence,
          title: step.title,
        })),
        uncertainty: reversible.length > 0 ? [] : ["No recovery-capable timeline steps were present."],
      };
    }
    case "why_blocked": {
      const blocked = steps.filter((step) => step.status === "blocked" || step.status === "awaiting_approval");
      const latestBlocked = blocked[blocked.length - 1];
      return {
        answer:
          blocked.length > 0
            ? `${latestBlocked?.title ?? "A step"} is currently ${latestBlocked?.status === "awaiting_approval" ? "waiting for approval" : "blocked"}.`
            : "This run has no blocked or approval-waiting steps recorded in the timeline.",
        confidence: 0.9,
        primary_reason: latestBlocked?.primary_reason ?? null,
        evidence: blocked.map((step) => ({
          step_id: step.step_id,
          sequence: step.sequence,
          title: step.title,
        })),
        uncertainty: blocked.length > 0 ? [] : ["No blocked states were emitted by the current adapters."],
      };
    }
    case "likely_cause":
    case "suggest_likely_cause": {
      const latestFailed = [...steps].reverse().find((step) => step.status === "failed");
      if (latestFailed) {
        const evidence = steps
          .filter(
            (step) =>
              step.step_id === latestFailed.step_id ||
              (latestFailed.action_id !== null && step.action_id === latestFailed.action_id),
          )
          .slice(-3)
          .map((step) => ({
            step_id: step.step_id,
            sequence: step.sequence,
            title: step.title,
          }));

        return {
          answer: `The likeliest cause is ${latestFailed.title} at step ${latestFailed.sequence}. ${latestFailed.summary}`,
          confidence: 0.91,
          evidence,
          uncertainty: [],
        };
      }

      const latestPartial = [...steps].reverse().find((step) => step.status === "partial");
      if (latestPartial) {
        return {
          answer: `The likeliest cause is an unknown execution outcome around ${latestPartial.title} at step ${latestPartial.sequence}. ${latestPartial.summary}`,
          confidence: 0.78,
          evidence: [
            {
              step_id: latestPartial.step_id,
              sequence: latestPartial.sequence,
              title: latestPartial.title,
            },
          ],
          uncertainty: ["The daemon recorded an unknown execution outcome instead of a confirmed success or failure."],
        };
      }

      const latestBlocked = [...steps]
        .reverse()
        .find((step) => step.status === "blocked" || step.status === "awaiting_approval");
      if (latestBlocked) {
        return {
          answer: `The likeliest cause is ${latestBlocked.title} at step ${latestBlocked.sequence}. ${latestBlocked.summary}`,
          confidence: 0.84,
          evidence: [
            {
              step_id: latestBlocked.step_id,
              sequence: latestBlocked.sequence,
              title: latestBlocked.title,
            },
          ],
          uncertainty: latestBlocked.status === "awaiting_approval" ? [] : ["No execution failure was recorded; this is inferred from the latest blocked step."],
        };
      }

      const latestNonGoverned = [...steps]
        .reverse()
        .find((step) => step.provenance !== "governed" && step.step_type !== "approval_step");
      if (latestNonGoverned) {
        return {
          answer: `The likeliest cause is ${latestNonGoverned.title} at step ${latestNonGoverned.sequence} because it is ${latestNonGoverned.provenance} rather than governed. ${latestNonGoverned.summary}`,
          confidence: 0.68,
          evidence: [
            {
              step_id: latestNonGoverned.step_id,
              sequence: latestNonGoverned.sequence,
              title: latestNonGoverned.title,
            },
          ],
          uncertainty: ["This is inferred from weak trust provenance rather than a recorded failure or block."],
        };
      }

      const latestStep = steps[steps.length - 1];
      return {
        answer:
          latestStep !== undefined
            ? `No explicit failure or blocked step was recorded. The latest step is ${latestStep.title} at step ${latestStep.sequence}.`
            : "No timeline steps were recorded for this run.",
        confidence: latestStep ? 0.62 : 0.3,
        evidence:
          latestStep !== undefined
            ? [
                {
                  step_id: latestStep.step_id,
                  sequence: latestStep.sequence,
                  title: latestStep.title,
                },
              ]
            : [],
        uncertainty: ["No explicit failure or blocked state was available to identify a stronger cause."],
      };
    }
    case "summarize_after_boundary":
    case "what_changed_after_step": {
      if (!focusStepId) {
        return {
          answer: "A focus step id is required to answer what changed after a specific point in the run.",
          confidence: 0.35,
          evidence: [],
          uncertainty: ["No focus_step_id was provided."],
        };
      }

      const focusStep = steps.find((step) => step.step_id === focusStepId);
      if (!focusStep) {
        return {
          answer: `No timeline step matched ${focusStepId}.`,
          confidence: 0.25,
          evidence: [],
          uncertainty: ["The requested focus step id was not found in this run."],
        };
      }

      const laterSteps = steps.filter((step) => step.sequence > focusStep.sequence);
      if (laterSteps.length === 0) {
        return {
          answer: `No later steps were recorded after ${focusStep.title}.`,
          confidence: 0.96,
          evidence: [
            {
              step_id: focusStep.step_id,
              sequence: focusStep.sequence,
              title: focusStep.title,
            },
          ],
          uncertainty: [],
        };
      }

      const stepPreview = laterSteps
        .slice(0, 3)
        .map((step) => `${step.title} (${step.status})`)
        .join(", ");
      const trustClauses = nonGovernedProvenanceClauses(laterSteps);

      return {
        answer: [
          questionType === "summarize_after_boundary"
            ? `After boundary ${focusStep.title}, ${laterSteps.length} later step(s) were recorded: ${stepPreview}.`
            : `After ${focusStep.title}, ${laterSteps.length} later step(s) were recorded: ${stepPreview}.`,
          ...trustClauses,
        ].join(" "),
        confidence: 0.93,
        evidence: laterSteps.slice(0, 5).map((step) => ({
          step_id: step.step_id,
          sequence: step.sequence,
          title: step.title,
        })),
        uncertainty: [
          laterSteps.length > 5 ? "Only the first 5 later steps are included as evidence." : null,
          trustClauses.length > 0
            ? "Some later steps were not governed pre-execution, so the post-boundary narrative includes weaker trust signals."
            : null,
        ].filter((value): value is string => value !== null),
      };
    }
    case "revert_impact":
    case "preview_revert_loss": {
      if (!focusStepId) {
        return {
          answer:
            questionType === "preview_revert_loss"
              ? "A focus step id is required to preview revert loss for a specific boundary."
              : "A focus step id is required to estimate revert impact for a specific point in the run.",
          confidence: 0.35,
          evidence: [],
          uncertainty: ["No focus_step_id was provided."],
        };
      }

      const focusStep = steps.find((step) => step.step_id === focusStepId);
      if (!focusStep) {
        return {
          answer: `No timeline step matched ${focusStepId}.`,
          confidence: 0.25,
          evidence: [],
          uncertainty: ["The requested focus step id was not found in this run."],
        };
      }

      if (focusStep.related.later_actions_affected !== null && focusStep.related.later_actions_affected !== undefined) {
        const overlapSummary =
          (focusStep.related.overlapping_paths ?? []).length > 0
            ? `Overlapping paths: ${(focusStep.related.overlapping_paths ?? []).slice(0, 3).join(", ")}.`
            : "No overlapping paths were recorded.";
        const warningSummary =
          (focusStep.warnings ?? []).length > 0
            ? `Warnings: ${(focusStep.warnings ?? []).slice(0, 3).join(" | ")}.`
            : null;

        return {
          answer: [
            `Reverting at ${focusStep.title} would affect ${focusStep.related.later_actions_affected} later action(s).`,
            overlapSummary,
            focusStep.related.data_loss_risk
              ? `Recorded data loss risk: ${focusStep.related.data_loss_risk}.`
              : null,
            focusStep.reversibility_class === "review_only"
              ? "This boundary is review-only, so the restore preview is advisory rather than exact automation."
              : null,
            focusStep.related.recovery_downgrade_reason
              ? `Primary downgrade reason: ${focusStep.related.recovery_downgrade_reason.code} - ${focusStep.related.recovery_downgrade_reason.message}.`
              : null,
            warningSummary,
          ]
            .filter((value): value is string => Boolean(value))
            .join(" "),
          confidence: questionType === "preview_revert_loss" ? 0.94 : 0.92,
          evidence: [
            {
              step_id: focusStep.step_id,
              sequence: focusStep.sequence,
              title: focusStep.title,
            },
          ],
          uncertainty:
            focusStep.reversibility_class === "review_only"
              ? ["This boundary requires manual review or compensation rather than guaranteed exact restore."]
              : [],
        };
      }

      const laterSteps = steps.filter((step) => step.sequence > focusStep.sequence);
      if (laterSteps.length === 0) {
        return {
          answer: `Reverting to ${focusStep.title} would not discard any later recorded steps.`,
          confidence: 0.96,
          evidence: [
            {
              step_id: focusStep.step_id,
              sequence: focusStep.sequence,
              title: focusStep.title,
            },
          ],
          uncertainty: [],
        };
      }

      const failedLater = laterSteps.filter((step) => step.status === "failed");
      const reversibleLater = laterSteps.filter((step) => step.reversibility_class === "reversible");
      const blockedLater = laterSteps.filter(
        (step) => step.status === "blocked" || step.status === "awaiting_approval",
      );
      const nonGovernedLater = laterSteps.filter((step) => step.provenance !== "governed");
      const preview = laterSteps
        .slice(0, 3)
        .map((step) => `${step.title} (${step.status})`)
        .join(", ");

      const impactParts = [
        `Reverting to ${focusStep.title} would discard ${laterSteps.length} later step(s): ${preview}.`,
      ];

      if (failedLater.length > 0) {
        impactParts.push(
          `${failedLater.length} later step(s) are already failed, so reverting would mainly remove their recorded aftermath rather than a successful end state.`,
        );
      }

      if (reversibleLater.length > 0) {
        impactParts.push(
          `${reversibleLater.length} of those later step(s) are themselves marked reversible.`,
        );
      }

      if (blockedLater.length > 0) {
        impactParts.push(
          `${blockedLater.length} later step(s) are blocked or awaiting approval.`,
        );
      }

      if (nonGovernedLater.length > 0) {
        impactParts.push(
          `${nonGovernedLater.length} later step(s) were not governed pre-execution, so some revert-loss evidence comes from weaker trust provenance.`,
        );
      }

      return {
        answer: impactParts.join(" "),
        confidence: 0.9,
        evidence: laterSteps.slice(0, 5).map((step) => ({
          step_id: step.step_id,
          sequence: step.sequence,
          title: step.title,
        })),
        uncertainty: [
          laterSteps.length > 5 ? "Only the first 5 later steps are included as evidence." : null,
          nonGovernedLater.length > 0
            ? "Some later steps were imported, observed, or otherwise non-governed."
            : null,
        ].filter((value): value is string => value !== null),
      };
    }
    case "what_would_i_lose_if_i_revert_here": {
      if (!focusStepId) {
        return {
          answer: "A focus step id is required to estimate what would be lost by reverting at a specific point.",
          confidence: 0.35,
          evidence: [],
          uncertainty: ["No focus_step_id was provided."],
        };
      }

      const focusStep = steps.find((step) => step.step_id === focusStepId);
      if (!focusStep) {
        return {
          answer: `No timeline step matched ${focusStepId}.`,
          confidence: 0.25,
          evidence: [],
          uncertainty: ["The requested focus step id was not found in this run."],
        };
      }

      if (focusStep.related.later_actions_affected !== null && focusStep.related.later_actions_affected !== undefined) {
        const lossParts = [
          `Reverting at ${focusStep.title} would cross ${focusStep.related.later_actions_affected} later action(s).`,
          (focusStep.related.overlapping_paths ?? []).length > 0
            ? `Overlapping paths: ${(focusStep.related.overlapping_paths ?? []).slice(0, 3).join(", ")}.`
            : "No overlapping paths were recorded.",
        ];

        if (focusStep.related.data_loss_risk) {
          lossParts.push(`Recorded data loss risk: ${focusStep.related.data_loss_risk}.`);
        }

        if ((focusStep.warnings ?? []).length > 0) {
          lossParts.push(`Warnings: ${(focusStep.warnings ?? []).slice(0, 3).join(" | ")}.`);
        }

        if (focusStep.external_effects.length > 0) {
          lossParts.push(`External effects remain relevant: ${focusStep.external_effects.join(", ")}.`);
        }

        if (focusStep.reversibility_class === "review_only") {
          lossParts.push("This boundary is review-only, so any loss preview remains advisory.");
        }

        if (focusStep.related.recovery_downgrade_reason) {
          lossParts.push(
            `Primary downgrade reason: ${focusStep.related.recovery_downgrade_reason.code} - ${focusStep.related.recovery_downgrade_reason.message}.`,
          );
        }

        return {
          answer: lossParts.join(" "),
          confidence: 0.92,
          evidence: [
            {
              step_id: focusStep.step_id,
              sequence: focusStep.sequence,
              title: focusStep.title,
            },
          ],
          uncertainty:
            focusStep.reversibility_class === "review_only"
              ? ["The projected loss is grounded in the recovery plan, but execution still requires manual review or compensation."]
              : [],
        };
      }

      const laterSteps = steps.filter((step) => step.sequence > focusStep.sequence);
      if (laterSteps.length === 0) {
        return {
          answer: `You would not lose any later recorded work by reverting at ${focusStep.title}. No later steps were recorded after it.`,
          confidence: 0.96,
          evidence: [
            {
              step_id: focusStep.step_id,
              sequence: focusStep.sequence,
              title: focusStep.title,
            },
          ],
          uncertainty: [],
        };
      }

      const completedLater = laterSteps.filter((step) => step.status === "completed").length;
      const failedLater = laterSteps.filter((step) => step.status === "failed").length;
      const blockedLater = laterSteps.filter(
        (step) => step.status === "blocked" || step.status === "awaiting_approval",
      ).length;
      const approvalLater = laterSteps.filter((step) => step.step_type === "approval_step").length;
      const recoveryLater = laterSteps.filter((step) => step.step_type === "recovery_step").length;
      const externalLater = laterSteps.filter((step) => step.external_effects.length > 0).length;
      const nonGovernedLater = laterSteps.filter((step) => step.provenance !== "governed").length;
      const preview = laterSteps
        .slice(0, 4)
        .map((step) => `${step.title} (${step.status})`)
        .join(", ");

      const lossParts = [
        `Reverting at ${focusStep.title} would remove ${laterSteps.length} later recorded step(s): ${preview}.`,
      ];

      if (completedLater > 0) {
        lossParts.push(`${completedLater} later step(s) currently look completed.`);
      }

      if (failedLater > 0) {
        lossParts.push(`${failedLater} later step(s) are already failed, so some of what you would lose is failure history rather than successful state.`);
      }

      if (blockedLater > 0) {
        lossParts.push(`${blockedLater} later step(s) are blocked or awaiting approval.`);
      }

      if (approvalLater > 0) {
        lossParts.push(`${approvalLater} approval decision step(s) happened after this point.`);
      }

      if (recoveryLater > 0) {
        lossParts.push(`${recoveryLater} recovery step(s) also happened after this point.`);
      }

      if (externalLater > 0) {
        lossParts.push(`${externalLater} later step(s) carry external side-effect hints, so some lost history may involve outside systems.`);
      }

      if (nonGovernedLater > 0) {
        lossParts.push(`${nonGovernedLater} later step(s) are non-governed, so part of the projected loss rests on weaker trust provenance.`);
      }

      return {
        answer: lossParts.join(" "),
        confidence: 0.91,
        evidence: laterSteps.slice(0, 5).map((step) => ({
          step_id: step.step_id,
          sequence: step.sequence,
          title: step.title,
        })),
        uncertainty: [
          laterSteps.length > 5 ? "Only the first 5 later steps are included as evidence." : null,
          nonGovernedLater > 0
            ? "Some projected losses come from imported, observed, or otherwise non-governed steps."
            : null,
        ].filter((value): value is string => value !== null),
      };
    }
    case "identify_external_effects":
    case "external_side_effects": {
      const external = steps.filter((step) => step.external_effects.length > 0);
      if (external.length === 0) {
        return {
          answer: "No externally side-effecting steps were identified from the recorded timeline facts.",
          confidence: 0.88,
          evidence: [],
          uncertainty: ["Only steps with recorded external-effect hints are reported here."],
        };
      }

      const summary = external
        .slice(0, 3)
        .map((step) => `${step.title} (${step.external_effects.join(", ")})`)
        .join(", ");
      const nonGovernedExternal = external.filter((step) => step.provenance !== "governed");

      return {
        answer: [
          `Found ${external.length} step(s) with external side effects: ${summary}.`,
          nonGovernedExternal.length > 0
            ? `${nonGovernedExternal.length} of those step(s) are non-governed, so the external-effect record is partly based on weaker provenance.`
            : null,
        ]
          .filter((value): value is string => value !== null)
          .join(" "),
        confidence: 0.92,
        evidence: external.slice(0, 5).map((step) => ({
          step_id: step.step_id,
          sequence: step.sequence,
          title: step.title,
        })),
        uncertainty: [
          external.length > 5 ? "Only the first 5 externally side-effecting steps are included as evidence." : null,
          nonGovernedExternal.length > 0
            ? "Some external-effect hints come from imported, observed, or otherwise non-governed steps."
            : null,
        ].filter((value): value is string => value !== null),
      };
    }
    case "list_actions_touching_scope": {
      if (!focusStepId) {
        return {
          answer: "A focus step id is required to list actions touching the same scope.",
          confidence: 0.35,
          evidence: [],
          uncertainty: ["No focus_step_id was provided."],
        };
      }

      const focusStep = steps.find((step) => step.step_id === focusStepId);
      if (!focusStep) {
        return {
          answer: `No timeline step matched ${focusStepId}.`,
          confidence: 0.25,
          evidence: [],
          uncertainty: ["The requested focus step id was not found in this run."],
        };
      }

      const scopeLocator = focusStep.related.target_locator;
      if (!scopeLocator) {
        return {
          answer: `${focusStep.title} does not carry a recorded target scope, so matching sibling actions is not possible from the current projection.`,
          confidence: 0.42,
          evidence: [
            {
              step_id: focusStep.step_id,
              sequence: focusStep.sequence,
              title: focusStep.title,
            },
          ],
          uncertainty: ["The timeline projection currently relies on recorded target locators to compute scope matches."],
        };
      }

      const touchingSteps = steps.filter((step) => {
        if (step.step_id === focusStep.step_id) {
          return false;
        }

        if (step.related.target_locator === scopeLocator) {
          return true;
        }

        return (step.related.overlapping_paths ?? []).includes(scopeLocator);
      });

      if (touchingSteps.length === 0) {
        return {
          answer: `No other recorded steps touched ${scopeLocator}.`,
          confidence: 0.9,
          evidence: [
            {
              step_id: focusStep.step_id,
              sequence: focusStep.sequence,
              title: focusStep.title,
            },
          ],
          uncertainty: [],
        };
      }

      const nonGovernedTouching = touchingSteps.filter((step) => step.provenance !== "governed");

      return {
        answer: [
          `Found ${touchingSteps.length} other step(s) touching ${scopeLocator}: ${touchingSteps
            .slice(0, 3)
            .map((step) => `${step.title} (${step.status})`)
            .join(", ")}.`,
          nonGovernedTouching.length > 0
            ? `${nonGovernedTouching.length} matching step(s) are non-governed.`
            : null,
        ]
          .filter((value): value is string => value !== null)
          .join(" "),
        confidence: 0.91,
        evidence: touchingSteps.slice(0, 5).map((step) => ({
          step_id: step.step_id,
          sequence: step.sequence,
          title: step.title,
        })),
        uncertainty: [
          touchingSteps.length > 5 ? "Only the first 5 matching steps are included as evidence." : null,
          nonGovernedTouching.length > 0
            ? "Some matching scope activity was imported, observed, or otherwise non-governed."
            : null,
        ].filter((value): value is string => value !== null),
      };
    }
    case "compare_steps": {
      if (!focusStepId || !compareStepId) {
        return {
          answer: "Both a focus step id and a compare step id are required to compare two points in the run.",
          confidence: 0.35,
          evidence: [],
          uncertainty: ["One or both step ids were not provided."],
        };
      }

      const focusStep = steps.find((step) => step.step_id === focusStepId);
      const compareStep = steps.find((step) => step.step_id === compareStepId);

      if (!focusStep || !compareStep) {
        return {
          answer: `Could not compare ${focusStepId} and ${compareStepId} because one or both steps were not found.`,
          confidence: 0.25,
          evidence: [],
          uncertainty: ["One or both requested step ids were not found in this run."],
        };
      }

      const start = Math.min(focusStep.sequence, compareStep.sequence);
      const end = Math.max(focusStep.sequence, compareStep.sequence);
      const betweenSteps = steps.filter((step) => step.sequence > start && step.sequence <= end);
      const failedBetween = betweenSteps.filter((step) => step.status === "failed").length;
      const approvalBetween = betweenSteps.filter((step) => step.step_type === "approval_step").length;
      const recoveryBetween = betweenSteps.filter((step) => step.step_type === "recovery_step").length;
      const externalBetween = betweenSteps.filter((step) => step.external_effects.length > 0).length;
      const preview = betweenSteps
        .slice(0, 4)
        .map((step) => `${step.title} (${step.status})`)
        .join(", ");

      const answerParts = [
        `Between ${focusStep.title} (step ${focusStep.sequence}) and ${compareStep.title} (step ${compareStep.sequence}), ${betweenSteps.length} step(s) were recorded.`,
      ];

      if (preview.length > 0) {
        answerParts.push(`Recorded steps: ${preview}.`);
      }

      if (failedBetween > 0) {
        answerParts.push(`${failedBetween} failed step(s) occurred in that span.`);
      }

      if (approvalBetween > 0) {
        answerParts.push(`${approvalBetween} approval step(s) occurred in that span.`);
      }

      if (recoveryBetween > 0) {
        answerParts.push(`${recoveryBetween} recovery step(s) occurred in that span.`);
      }

      if (externalBetween > 0) {
        answerParts.push(`${externalBetween} step(s) in that span carried external side-effect hints.`);
      }

      return {
        answer: answerParts.join(" "),
        confidence: 0.91,
        evidence: Array.from(
          new Map(
            [focusStep, ...betweenSteps.slice(0, 4), compareStep].map((step) => [
              step.step_id,
              {
                step_id: step.step_id,
                sequence: step.sequence,
                title: step.title,
              },
            ]),
          ).values(),
        ),
        uncertainty:
          betweenSteps.length > 4
            ? ["Only the first 4 intermediate steps are included as evidence."]
            : [],
      };
    }
  }

  const exhaustiveQuestionType: never = questionType;
  return {
    answer: `Unsupported helper question type: ${String(exhaustiveQuestionType)}`,
    confidence: 0,
    primary_reason: null,
    evidence: [],
    uncertainty: ["The helper received an unknown question type."],
  };
}
