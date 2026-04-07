import type { RequestContext } from "@agentgit/core-ports";
import type { RunJournal } from "@agentgit/run-journal";
import {
  CreateRunCheckpointRequestPayloadSchema,
  type CreateRunCheckpointResponsePayload,
  GetRunSummaryRequestPayloadSchema,
  type GetRunSummaryResponsePayload,
  PreconditionError,
  type RequestEnvelope,
  type ResponseEnvelope,
  validate,
} from "@agentgit/schemas";
import { selectSnapshotClass } from "@agentgit/snapshot-engine";
import type { LocalSnapshotEngine } from "@agentgit/snapshot-engine";

import { requireAuthorizedRunSummary, requireValidSession } from "../authorization.js";
import { buildCachedCapabilityState } from "../capabilities.js";
import { buildSyntheticCheckpointAction } from "../request-helpers.js";
import { makeSuccessResponse } from "../response-helpers.js";
import type { ServiceOptions } from "../types.js";
import {
  deriveSnapshotCapabilityState as deriveSnapshotCapabilityStateService,
  deriveSnapshotRunRiskContext as deriveSnapshotRunRiskContextService,
} from "../../services/snapshot-risk.js";
import type { AuthorityState } from "../../state.js";

export function handleGetRunSummary(
  state: AuthorityState,
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): ResponseEnvelope<GetRunSummaryResponsePayload> {
  const sessionId = requireValidSession(state, "get_run_summary", request.session_id);
  const payload = validate(GetRunSummaryRequestPayloadSchema, request.payload);
  const runSummary = requireAuthorizedRunSummary(state, journal, sessionId, payload.run_id);

  return makeSuccessResponse(request.request_id, request.session_id, {
    run: runSummary,
  });
}

export async function handleCreateRunCheckpoint(
  state: AuthorityState,
  journal: RunJournal,
  snapshotEngine: LocalSnapshotEngine,
  runtimeOptions: Pick<ServiceOptions, "capabilityRefreshStaleMs">,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): Promise<ResponseEnvelope<CreateRunCheckpointResponsePayload>> {
  const payload = validate(CreateRunCheckpointRequestPayloadSchema, request.payload);
  const sessionId = requireValidSession(state, "create_run_checkpoint", request.session_id);
  const runSummary = requireAuthorizedRunSummary(state, journal, sessionId, payload.run_id);

  const workspaceRoot = payload.workspace_root ?? runSummary.workspace_roots[0];
  if (!workspaceRoot || !runSummary.workspace_roots.includes(workspaceRoot)) {
    throw new PreconditionError("Checkpoint workspace root is not registered on this run.", {
      run_id: payload.run_id,
      workspace_root: payload.workspace_root ?? null,
      registered_workspace_roots: runSummary.workspace_roots,
    });
  }

  const checkpointKind = payload.checkpoint_kind ?? "branch_point";
  const action = buildSyntheticCheckpointAction({
    run_id: payload.run_id,
    session_id: sessionId,
    workspace_root: workspaceRoot,
    checkpoint_kind: checkpointKind,
    reason: payload.reason,
  });
  const cachedCapabilityState = buildCachedCapabilityState(journal, runtimeOptions);
  const runRiskContext = deriveSnapshotRunRiskContextService(journal, payload.run_id);
  const snapshotSelection = selectSnapshotClass({
    action,
    policy_decision: "allow_with_snapshot",
    capability_state: deriveSnapshotCapabilityStateService(cachedCapabilityState),
    low_disk_pressure_observed: runSummary.maintenance_status.low_disk_pressure_signals > 0,
    journal_chain_depth: runSummary.event_count,
    ...runRiskContext,
    explicit_branch_point: checkpointKind === "branch_point",
    explicit_hard_checkpoint: checkpointKind === "hard_checkpoint",
  });
  const snapshotRecord = await snapshotEngine.createSnapshot({
    action,
    requested_class: snapshotSelection.snapshot_class,
    workspace_root: workspaceRoot,
  });
  const snapshotSequence = journal.appendRunEvent(payload.run_id, {
    event_type: "snapshot.created",
    occurred_at: snapshotRecord.created_at,
    recorded_at: snapshotRecord.created_at,
    payload: {
      action_id: action.action_id,
      snapshot_id: snapshotRecord.snapshot_id,
      snapshot_class: snapshotRecord.snapshot_class,
      fidelity: snapshotRecord.fidelity,
      selection_reason_codes: snapshotSelection.reason_codes,
      selection_basis: snapshotSelection.basis,
      checkpoint_kind: checkpointKind,
      checkpoint_reason: payload.reason ?? null,
      synthetic_checkpoint: true,
    },
  });
  const runCheckpoint = `${payload.run_id}#${snapshotSequence}`;
  journal.appendRunEvent(payload.run_id, {
    event_type: "checkpoint.created",
    occurred_at: snapshotRecord.created_at,
    recorded_at: snapshotRecord.created_at,
    payload: {
      action_id: action.action_id,
      run_checkpoint: runCheckpoint,
      snapshot_id: snapshotRecord.snapshot_id,
      checkpoint_kind: checkpointKind,
      checkpoint_reason: payload.reason ?? null,
    },
  });

  return makeSuccessResponse(request.request_id, request.session_id, {
    run_checkpoint: runCheckpoint,
    branch_point: {
      run_id: payload.run_id,
      sequence: snapshotSequence,
    },
    checkpoint_kind: checkpointKind,
    snapshot_record: snapshotRecord,
    snapshot_selection: snapshotSelection,
  });
}
