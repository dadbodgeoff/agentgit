import type { RequestContext } from "@agentgit/core-ports";
import type { AdapterRegistry, OwnedDraftStore, OwnedNoteStore, OwnedTicketStore } from "@agentgit/execution-adapters";
import type { McpServerRegistry } from "@agentgit/mcp-registry";
import type { RunJournal } from "@agentgit/run-journal";
import type { LocalSnapshotEngine } from "@agentgit/snapshot-engine";
import { selectSnapshotClass } from "@agentgit/snapshot-engine";
import {
  type ApprovalInboxItem,
  ListApprovalsRequestPayloadSchema,
  type ListApprovalsResponsePayload,
  NotFoundError,
  type PolicyOutcomeRecord,
  QueryApprovalInboxRequestPayloadSchema,
  type QueryApprovalInboxResponsePayload,
  type RequestEnvelope,
  ResolveApprovalRequestPayloadSchema,
  type ResolveApprovalResponsePayload,
  type ResponseEnvelope,
  type SubmitActionAttemptResponsePayload,
  validate,
} from "@agentgit/schemas";

import { requireAuthorizedRunSummary, requireValidSession, sessionCanAccessRun } from "../authorization.js";
import { buildCachedCapabilityState } from "../capabilities.js";
import { makeSuccessResponse } from "../response-helpers.js";
import type { ServiceOptions } from "../types.js";
import { executeGovernedAction as executeGovernedActionFlow } from "../../services/action-execution.js";
import type { LatencyMetricsStore } from "../../latency-metrics.js";
import {
  deriveSnapshotCapabilityState as deriveSnapshotCapabilityStateService,
  deriveSnapshotRunRiskContext as deriveSnapshotRunRiskContextService,
} from "../../services/snapshot-risk.js";
import type { AuthorityState } from "../../state.js";
import type { HostedExecutionQueue } from "../../hosted-execution-queue.js";

export function handleListApprovals(
  state: AuthorityState,
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): ResponseEnvelope<ListApprovalsResponsePayload> {
  const sessionId = requireValidSession(state, "list_approvals", request.session_id);
  const payload = validate(ListApprovalsRequestPayloadSchema, request.payload);
  if (payload.run_id) {
    requireAuthorizedRunSummary(state, journal, sessionId, payload.run_id);
  }
  const approvals = journal
    .listApprovals({
      run_id: payload.run_id,
      status: payload.status,
    })
    .filter((approval) => {
      const runSummary = journal.getRunSummary(approval.run_id);
      return runSummary !== null && sessionCanAccessRun(state, sessionId, runSummary);
    });

  return makeSuccessResponse(request.request_id, request.session_id, {
    approvals,
  });
}

export function handleQueryApprovalInbox(
  state: AuthorityState,
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): ResponseEnvelope<QueryApprovalInboxResponsePayload> {
  const sessionId = requireValidSession(state, "query_approval_inbox", request.session_id);
  const payload = validate(QueryApprovalInboxRequestPayloadSchema, request.payload);
  if (payload.run_id) {
    requireAuthorizedRunSummary(state, journal, sessionId, payload.run_id);
  }
  const approvals = journal
    .listApprovals({
      run_id: payload.run_id,
      status: payload.status,
    })
    .filter((approval) => {
      const runSummary = journal.getRunSummary(approval.run_id);
      return runSummary !== null && sessionCanAccessRun(state, sessionId, runSummary);
    });

  const items: ApprovalInboxItem[] = [];
  for (const approval of approvals) {
    const stored = journal.getStoredApproval(approval.approval_id);
    const run = journal.getRunSummary(approval.run_id);

    if (!stored || !run) {
      continue;
    }

    const firstReason = stored.policy_outcome.reasons[0];
    const reasonSummary = firstReason?.message ?? null;
    const target = stored.action.target.primary;

    items.push({
      approval_id: approval.approval_id,
      run_id: approval.run_id,
      workflow_name: run.workflow_name,
      action_id: approval.action_id,
      action_summary: approval.action_summary,
      action_domain: stored.action.operation.domain,
      side_effect_level: stored.action.risk_hints.side_effect_level,
      status: approval.status,
      requested_at: approval.requested_at,
      resolved_at: approval.resolved_at,
      resolution_note: approval.resolution_note,
      decision_requested: approval.decision_requested,
      snapshot_required: stored.policy_outcome.preconditions.snapshot_required,
      reason_summary: reasonSummary,
      primary_reason: firstReason
        ? {
            code: firstReason.code,
            message: firstReason.message,
          }
        : null,
      target_locator: target.locator,
      target_label: target.label ?? null,
    });
  }

  items.sort((left, right) => {
    if (left.status !== right.status) {
      if (left.status === "pending") return -1;
      if (right.status === "pending") return 1;
    }

    return right.requested_at.localeCompare(left.requested_at);
  });

  const counts = items.reduce(
    (accumulator, item) => {
      accumulator[item.status] += 1;
      return accumulator;
    },
    {
      pending: 0,
      approved: 0,
      denied: 0,
    },
  );

  return makeSuccessResponse(request.request_id, request.session_id, {
    items,
    counts,
  });
}

export async function handleResolveApproval(
  state: AuthorityState,
  journal: RunJournal,
  adapterRegistry: AdapterRegistry,
  snapshotEngine: LocalSnapshotEngine,
  draftStore: OwnedDraftStore,
  noteStore: OwnedNoteStore,
  ticketStore: OwnedTicketStore,
  mcpRegistry: McpServerRegistry,
  hostedExecutionQueue: HostedExecutionQueue,
  latencyMetrics: LatencyMetricsStore,
  runtimeOptions: Pick<ServiceOptions, "capabilityRefreshStaleMs">,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
  executeHostedDelegatedAction: (params: {
    action: import("@agentgit/schemas").ActionRecord;
    mcpRegistry: McpServerRegistry;
    journal: RunJournal;
    hostedExecutionQueue: HostedExecutionQueue;
  }) => Promise<SubmitActionAttemptResponsePayload["execution_result"]>,
): Promise<ResponseEnvelope<ResolveApprovalResponsePayload>> {
  const sessionId = requireValidSession(state, "resolve_approval", request.session_id);
  const payload = validate(ResolveApprovalRequestPayloadSchema, request.payload);
  const storedApproval = journal.getStoredApproval(payload.approval_id);

  if (!storedApproval) {
    throw new NotFoundError(`No approval found for ${payload.approval_id}.`, {
      approval_id: payload.approval_id,
    });
  }
  requireAuthorizedRunSummary(state, journal, sessionId, storedApproval.run_id);

  const approvalRequest = journal.resolveApproval(payload.approval_id, payload.resolution, payload.note);
  const resolvedAt = approvalRequest.resolved_at ?? new Date().toISOString();

  journal.appendRunEvent(storedApproval.run_id, {
    event_type: "approval.resolved",
    occurred_at: resolvedAt,
    recorded_at: resolvedAt,
    payload: {
      approval_id: approvalRequest.approval_id,
      action_id: approvalRequest.action_id,
      action_summary: approvalRequest.action_summary,
      resolution: approvalRequest.status,
      resolution_note: approvalRequest.resolution_note,
    },
  });

  if (approvalRequest.status !== "approved") {
    return makeSuccessResponse(request.request_id, request.session_id, {
      approval_request: approvalRequest,
      execution_result: null,
      snapshot_record: storedApproval.snapshot_record,
    });
  }

  const runSummary = journal.getRunSummary(storedApproval.run_id);
  if (!runSummary) {
    throw new NotFoundError(`No run found for ${storedApproval.run_id}.`, {
      run_id: storedApproval.run_id,
    });
  }

  const approvedPolicyOutcome: PolicyOutcomeRecord = {
    ...storedApproval.policy_outcome,
    decision: storedApproval.policy_outcome.preconditions.snapshot_required ? "allow_with_snapshot" : "allow",
    preconditions: {
      ...storedApproval.policy_outcome.preconditions,
      approval_required: false,
    },
  };
  const cachedCapabilityState = buildCachedCapabilityState(journal, runtimeOptions);
  const approvalSnapshotSelection = approvedPolicyOutcome.preconditions.snapshot_required
    ? selectSnapshotClass({
        action: storedApproval.action,
        policy_decision: approvedPolicyOutcome.decision,
        capability_state: deriveSnapshotCapabilityStateService(cachedCapabilityState),
        low_disk_pressure_observed: runSummary.maintenance_status.low_disk_pressure_signals > 0,
        journal_chain_depth: runSummary.event_count,
        ...deriveSnapshotRunRiskContextService(journal, storedApproval.run_id, {
          exclude_action_id: storedApproval.action.action_id,
        }),
      })
    : null;

  const execution = await executeGovernedActionFlow({
    action: storedApproval.action,
    policyOutcome: approvedPolicyOutcome,
    snapshotSelection: approvalSnapshotSelection,
    runSummary,
    journal,
    adapterRegistry,
    snapshotEngine,
    draftStore,
    noteStore,
    ticketStore,
    latencyMetrics,
    executeHostedDelegatedAction: (action) =>
      executeHostedDelegatedAction({
        action,
        mcpRegistry,
        journal,
        hostedExecutionQueue,
      }),
  });

  return makeSuccessResponse(request.request_id, request.session_id, {
    approval_request: approvalRequest,
    execution_result: execution.executionResult,
    snapshot_record: execution.snapshotRecord,
  });
}
