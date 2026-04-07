import type { RequestContext } from "@agentgit/core-ports";
import type { StaticCompensationRegistry } from "@agentgit/recovery-engine";
import {
  createActionBoundaryReviewPlan,
  executePathSubsetRecovery,
  executeSnapshotRecovery,
  loadRecoverySnapshotManifest,
  planPathSubsetRecovery,
  planSnapshotRecovery,
} from "@agentgit/recovery-engine";
import type { RunJournal } from "@agentgit/run-journal";
import type { LocalSnapshotEngine } from "@agentgit/snapshot-engine";
import {
  ExecuteRecoveryRequestPayloadSchema,
  type ExecuteRecoveryResponsePayload,
  PlanRecoveryRequestPayloadSchema,
  type PlanRecoveryResponsePayload,
  PreconditionError,
  type RecoveryPlan,
  type RecoveryTarget,
  type RequestEnvelope,
  type ResponseEnvelope,
  validate,
} from "@agentgit/schemas";

import { requireAuthorizedRunSummary, requireValidSession } from "../authorization.js";
import { buildCachedCapabilityState } from "../capabilities.js";
import {
  createActionBoundaryPlan,
  findActionBoundaryContext,
  findBranchPointContext,
  findExternalObjectBoundaryContext,
  findRunCheckpointContext,
  normalizeRecoveryTarget,
  retargetRecoveryPlan,
} from "../request-helpers.js";
import { makeSuccessResponse } from "../response-helpers.js";
import type { ServiceOptions } from "../types.js";
import type { AuthorityState } from "../../state.js";

export async function handlePlanRecovery(
  state: AuthorityState,
  journal: RunJournal,
  snapshotEngine: LocalSnapshotEngine,
  compensationRegistry: StaticCompensationRegistry,
  runtimeOptions: Pick<ServiceOptions, "capabilityRefreshStaleMs">,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): Promise<ResponseEnvelope<PlanRecoveryResponsePayload>> {
  const sessionId = requireValidSession(state, "plan_recovery", request.session_id);
  const payload = validate(PlanRecoveryRequestPayloadSchema, request.payload);
  const target = normalizeRecoveryTarget(payload);
  const cachedCapabilityState = buildCachedCapabilityState(journal, runtimeOptions);
  let recoveryPlan: RecoveryPlan;
  let runId: string;
  let snapshotIdForJournal: string | null = null;
  let actionIdForJournal: string | null = null;
  let runCheckpointForJournal: string | null = null;
  let branchPointRunIdForJournal: string | null = null;
  let branchPointSequenceForJournal: number | null = null;
  let subsetPathsForJournal: string[] | null = null;

  if (target.type === "snapshot_id") {
    const manifest = await loadRecoverySnapshotManifest(snapshotEngine, target.snapshot_id);
    requireAuthorizedRunSummary(state, journal, sessionId, manifest.run_id);
    recoveryPlan = await planSnapshotRecovery(snapshotEngine, target.snapshot_id, {
      compensation_registry: compensationRegistry,
      cached_capability_state: cachedCapabilityState,
    });
    runId = manifest.run_id;
    snapshotIdForJournal = target.snapshot_id;
  } else if (target.type === "path_subset") {
    const manifest = await loadRecoverySnapshotManifest(snapshotEngine, target.snapshot_id);
    requireAuthorizedRunSummary(state, journal, sessionId, manifest.run_id);
    recoveryPlan = await planPathSubsetRecovery(snapshotEngine, target, {
      cached_capability_state: cachedCapabilityState,
    });
    runId = manifest.run_id;
    snapshotIdForJournal = target.snapshot_id;
    actionIdForJournal = manifest.action_id;
    subsetPathsForJournal = [...target.paths];
  } else if (target.type === "branch_point") {
    const branchPointContext = findBranchPointContext(journal, target);
    requireAuthorizedRunSummary(state, journal, sessionId, branchPointContext.runId);
    recoveryPlan = retargetRecoveryPlan(
      await planSnapshotRecovery(snapshotEngine, branchPointContext.snapshotId, {
        compensation_registry: compensationRegistry,
        cached_capability_state: cachedCapabilityState,
      }),
      target,
    );
    runId = branchPointContext.runId;
    snapshotIdForJournal = branchPointContext.snapshotId;
    actionIdForJournal = branchPointContext.actionId;
    branchPointRunIdForJournal = target.run_id;
    branchPointSequenceForJournal = target.sequence;
  } else if (target.type === "run_checkpoint") {
    const checkpointContext = findRunCheckpointContext(journal, target.run_checkpoint);
    requireAuthorizedRunSummary(state, journal, sessionId, checkpointContext.runId);
    recoveryPlan = retargetRecoveryPlan(
      await planSnapshotRecovery(snapshotEngine, checkpointContext.snapshotId, {
        compensation_registry: compensationRegistry,
        cached_capability_state: cachedCapabilityState,
      }),
      target,
    );
    runId = checkpointContext.runId;
    snapshotIdForJournal = checkpointContext.snapshotId;
    actionIdForJournal = checkpointContext.actionId;
    runCheckpointForJournal = target.run_checkpoint;
  } else {
    const actionContext =
      target.type === "action_boundary"
        ? findActionBoundaryContext(journal, target.action_id)
        : findExternalObjectBoundaryContext(journal, target.external_object_id);
    requireAuthorizedRunSummary(state, journal, sessionId, actionContext.runId);
    actionIdForJournal = actionContext.actionId;

    if (actionContext.snapshotId) {
      recoveryPlan = retargetRecoveryPlan(
        await planSnapshotRecovery(snapshotEngine, actionContext.snapshotId, {
          compensation_registry: compensationRegistry,
          cached_capability_state: cachedCapabilityState,
        }),
        target,
      );
      snapshotIdForJournal = actionContext.snapshotId;
    } else {
      recoveryPlan = retargetRecoveryPlan(createActionBoundaryPlan(journal, actionContext.actionId), target);
    }

    runId = actionContext.runId;
  }

  journal.appendRunEvent(runId, {
    event_type: "recovery.planned",
    occurred_at: recoveryPlan.created_at,
    recorded_at: recoveryPlan.created_at,
    payload: {
      recovery_plan_id: recoveryPlan.recovery_plan_id,
      target_type: target.type,
      snapshot_id: snapshotIdForJournal,
      action_id: actionIdForJournal,
      external_object_id: target.type === "external_object" ? target.external_object_id : null,
      run_checkpoint: runCheckpointForJournal,
      branch_point_run_id: branchPointRunIdForJournal,
      branch_point_sequence: branchPointSequenceForJournal,
      target_paths: subsetPathsForJournal,
      recovery_class: recoveryPlan.recovery_class,
      strategy: recoveryPlan.strategy,
      downgrade_reason_code: recoveryPlan.downgrade_reason?.code ?? null,
      downgrade_reason_message: recoveryPlan.downgrade_reason?.message ?? null,
      target_locator: recoveryPlan.review_guidance?.objects_touched[0] ?? null,
      later_actions_affected: recoveryPlan.impact_preview.later_actions_affected,
      overlapping_paths: recoveryPlan.impact_preview.overlapping_paths,
      data_loss_risk: recoveryPlan.impact_preview.data_loss_risk,
      external_effects: recoveryPlan.impact_preview.external_effects,
      warnings: recoveryPlan.warnings.map((warning) => warning.message),
    },
  });

  return makeSuccessResponse(request.request_id, request.session_id, {
    recovery_plan: recoveryPlan,
  });
}

export async function handleExecuteRecovery(
  state: AuthorityState,
  journal: RunJournal,
  snapshotEngine: LocalSnapshotEngine,
  compensationRegistry: StaticCompensationRegistry,
  runtimeOptions: Pick<ServiceOptions, "capabilityRefreshStaleMs">,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): Promise<ResponseEnvelope<ExecuteRecoveryResponsePayload>> {
  const sessionId = requireValidSession(state, "execute_recovery", request.session_id);
  const payload = validate(ExecuteRecoveryRequestPayloadSchema, request.payload);
  const target = normalizeRecoveryTarget(payload);
  const cachedCapabilityState = buildCachedCapabilityState(journal, runtimeOptions);
  let result: ExecuteRecoveryResponsePayload;
  let runId: string;
  let targetPath: string | null = null;
  let existedBefore: boolean | null = null;
  let entryKind: string | null = null;
  let snapshotIdForJournal: string | null = null;
  let actionIdForJournal: string | null = null;
  let runCheckpointForJournal: string | null = null;
  let branchPointRunIdForJournal: string | null = null;
  let branchPointSequenceForJournal: number | null = null;
  let subsetPathsForJournal: string[] | null = null;

  if (target.type === "snapshot_id") {
    const manifest = await loadRecoverySnapshotManifest(snapshotEngine, target.snapshot_id);
    requireAuthorizedRunSummary(state, journal, sessionId, manifest.run_id);
    result = await executeSnapshotRecovery(snapshotEngine, target.snapshot_id, {
      compensation_registry: compensationRegistry,
      cached_capability_state: cachedCapabilityState,
    });
    runId = manifest.run_id;
    targetPath = manifest.target_path;
    existedBefore = manifest.existed_before;
    entryKind = manifest.entry_kind;
    snapshotIdForJournal = target.snapshot_id;
  } else if (target.type === "path_subset") {
    const manifest = await loadRecoverySnapshotManifest(snapshotEngine, target.snapshot_id);
    requireAuthorizedRunSummary(state, journal, sessionId, manifest.run_id);
    result = await executePathSubsetRecovery(snapshotEngine, target, {
      cached_capability_state: cachedCapabilityState,
    });
    runId = manifest.run_id;
    targetPath = manifest.target_path;
    existedBefore = manifest.existed_before;
    entryKind = manifest.entry_kind;
    snapshotIdForJournal = target.snapshot_id;
    actionIdForJournal = manifest.action_id;
    subsetPathsForJournal = [...target.paths];
  } else if (target.type === "branch_point") {
    const branchPointContext = findBranchPointContext(journal, target);
    requireAuthorizedRunSummary(state, journal, sessionId, branchPointContext.runId);
    const manifest = await loadRecoverySnapshotManifest(snapshotEngine, branchPointContext.snapshotId);
    const branchPointResult = await executeSnapshotRecovery(snapshotEngine, branchPointContext.snapshotId, {
      compensation_registry: compensationRegistry,
      cached_capability_state: cachedCapabilityState,
    });
    result = {
      ...branchPointResult,
      recovery_plan: retargetRecoveryPlan(branchPointResult.recovery_plan, target),
    };
    runId = branchPointContext.runId;
    targetPath = manifest.target_path;
    existedBefore = manifest.existed_before;
    entryKind = manifest.entry_kind;
    snapshotIdForJournal = branchPointContext.snapshotId;
    actionIdForJournal = branchPointContext.actionId;
    branchPointRunIdForJournal = target.run_id;
    branchPointSequenceForJournal = target.sequence;
  } else if (target.type === "run_checkpoint") {
    const checkpointContext = findRunCheckpointContext(journal, target.run_checkpoint);
    requireAuthorizedRunSummary(state, journal, sessionId, checkpointContext.runId);
    const manifest = await loadRecoverySnapshotManifest(snapshotEngine, checkpointContext.snapshotId);
    const checkpointResult = await executeSnapshotRecovery(snapshotEngine, checkpointContext.snapshotId, {
      compensation_registry: compensationRegistry,
      cached_capability_state: cachedCapabilityState,
    });
    result = {
      ...checkpointResult,
      recovery_plan: retargetRecoveryPlan(checkpointResult.recovery_plan, target),
    };
    runId = checkpointContext.runId;
    targetPath = manifest.target_path;
    existedBefore = manifest.existed_before;
    entryKind = manifest.entry_kind;
    snapshotIdForJournal = checkpointContext.snapshotId;
    actionIdForJournal = checkpointContext.actionId;
    runCheckpointForJournal = target.run_checkpoint;
  } else {
    const actionContext =
      target.type === "action_boundary"
        ? findActionBoundaryContext(journal, target.action_id)
        : findExternalObjectBoundaryContext(journal, target.external_object_id);
    requireAuthorizedRunSummary(state, journal, sessionId, actionContext.runId);
    runId = actionContext.runId;
    actionIdForJournal = actionContext.actionId;

    if (!actionContext.snapshotId) {
      throw new PreconditionError(
        "This action boundary has no persisted snapshot, so execution is manual-review only.",
        {
          action_id: actionContext.actionId,
        },
      );
    }

    const manifest = await loadRecoverySnapshotManifest(snapshotEngine, actionContext.snapshotId);
    const snapshotResult = await executeSnapshotRecovery(snapshotEngine, actionContext.snapshotId, {
      compensation_registry: compensationRegistry,
      cached_capability_state: cachedCapabilityState,
    });
    result = {
      ...snapshotResult,
      recovery_plan: retargetRecoveryPlan(snapshotResult.recovery_plan, target),
    };
    targetPath = manifest.target_path;
    existedBefore = manifest.existed_before;
    entryKind = manifest.entry_kind;
    snapshotIdForJournal = actionContext.snapshotId;
  }

  journal.appendRunEvent(runId, {
    event_type: "recovery.executed",
    occurred_at: result.executed_at,
    recorded_at: result.executed_at,
    payload: {
      recovery_plan_id: result.recovery_plan.recovery_plan_id,
      target_type: target.type,
      snapshot_id: snapshotIdForJournal,
      action_id: actionIdForJournal,
      external_object_id: target.type === "external_object" ? target.external_object_id : null,
      run_checkpoint: runCheckpointForJournal,
      branch_point_run_id: branchPointRunIdForJournal,
      branch_point_sequence: branchPointSequenceForJournal,
      target_paths: subsetPathsForJournal,
      recovery_class: result.recovery_plan.recovery_class,
      strategy: result.recovery_plan.strategy,
      downgrade_reason_code: result.recovery_plan.downgrade_reason?.code ?? null,
      downgrade_reason_message: result.recovery_plan.downgrade_reason?.message ?? null,
      restored: result.restored,
      outcome: result.outcome,
      target_path: targetPath,
      target_locator: result.recovery_plan.review_guidance?.objects_touched[0] ?? targetPath,
      existed_before: existedBefore,
      entry_kind: entryKind,
      later_actions_affected: result.recovery_plan.impact_preview.later_actions_affected,
      overlapping_paths: result.recovery_plan.impact_preview.overlapping_paths,
      data_loss_risk: result.recovery_plan.impact_preview.data_loss_risk,
      external_effects: result.recovery_plan.impact_preview.external_effects,
      warnings: result.recovery_plan.warnings.map((warning) => warning.message),
    },
  });

  return makeSuccessResponse(request.request_id, request.session_id, result);
}
