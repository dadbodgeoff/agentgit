import { randomUUID } from "node:crypto";

import {
  type CapabilityRecord,
  type RecoveryDowngradeReason,
  type ExecuteRecoveryResponsePayload,
  type RecoveryPlan,
  type RecoveryTarget,
  InternalError,
  NotFoundError,
  PreconditionError,
} from "@agentgit/schemas";
import { type LocalSnapshotEngine, type SnapshotManifest } from "@agentgit/snapshot-engine";

function createRecoveryPlanId(): string {
  return `rec_${Date.now()}_${randomUUID().replaceAll("-", "")}`;
}

function createRecoveryStepId(): string {
  return `step_${Date.now()}_${randomUUID().replaceAll("-", "")}`;
}

export interface CompensationPlanCandidate {
  strategy: string;
  confidence: number;
  steps: RecoveryPlan["steps"];
  impact_preview: Pick<RecoveryPlan["impact_preview"], "external_effects" | "data_loss_risk">;
  warnings?: RecoveryPlan["warnings"];
  review_guidance?: RecoveryPlan["review_guidance"];
}

export interface CompensationStrategy {
  canCompensate(manifest: SnapshotManifest): boolean;
  buildCandidate(params: {
    manifest: SnapshotManifest;
    preview: Awaited<ReturnType<LocalSnapshotEngine["previewRestore"]>>;
    integrity_ok: boolean;
  }): CompensationPlanCandidate;
  execute(params: {
    manifest: SnapshotManifest;
    preview: Awaited<ReturnType<LocalSnapshotEngine["previewRestore"]>>;
    integrity_ok: boolean;
  }): Promise<boolean>;
}

export interface CompensationRegistry {
  resolve(manifest: SnapshotManifest): CompensationStrategy | null;
}

export class StaticCompensationRegistry implements CompensationRegistry {
  constructor(private readonly strategies: CompensationStrategy[] = []) {}

  resolve(manifest: SnapshotManifest): CompensationStrategy | null {
    return this.strategies.find((strategy) => strategy.canCompensate(manifest)) ?? null;
  }
}

export interface ActionBoundaryEvidence {
  action_id: string;
  target_locator: string;
  operation_domain: string;
  display_name?: string | null;
  side_effect_level?: string | null;
  external_effects?: string | null;
  reversibility_hint?: string | null;
  later_actions_affected: number;
  overlapping_paths: string[];
}

export interface CachedCapabilityState {
  capabilities: CapabilityRecord[];
  degraded_mode_warnings: string[];
  refreshed_at: string;
  stale_after_ms: number;
  is_stale: boolean;
}

function impactRisk(manifest: SnapshotManifest): RecoveryPlan["impact_preview"]["data_loss_risk"] {
  if (!manifest.existed_before) {
    return "low";
  }

  return manifest.entry_kind === "directory" ? "moderate" : "low";
}

function buildWarnings(
  preview: Awaited<ReturnType<LocalSnapshotEngine["previewRestore"]>>,
  integrityOk: boolean,
): RecoveryPlan["warnings"] {
  const warnings: RecoveryPlan["warnings"] = [];

  if (preview.later_actions_affected > 0) {
    warnings.push({
      code: "LATER_ACTIONS_OVERLAP_BOUNDARY",
      message:
        preview.overlapping_paths.length > 0
          ? `Recovery would overwrite ${preview.later_actions_affected} later action(s) touching ${preview.overlapping_paths.slice(0, 3).join(", ")}.`
          : `Recovery would overwrite ${preview.later_actions_affected} later action(s) recorded after this boundary.`,
    });
  }

  if (!integrityOk) {
    warnings.push({
      code: "SNAPSHOT_INTEGRITY_UNCERTAIN",
      message: "Snapshot integrity could not be fully verified. Recovery confidence is reduced.",
    });
  }

  return warnings;
}

function manifestExternalEffects(manifest: SnapshotManifest): string[] {
  return manifest.external_effects && manifest.external_effects !== "none" ? [manifest.external_effects] : [];
}

function buildReviewGuidance(
  manifest: SnapshotManifest,
  extraUncertainty: string[] = [],
): RecoveryPlan["review_guidance"] {
  const systemsTouched = [manifest.operation_domain ?? "unknown_system"];
  const objectsTouched = [manifest.target_path];
  const manualSteps: string[] = [];
  const uncertainty: string[] = [...extraUncertainty];

  if (manifest.operation_domain === "shell") {
    manualSteps.push("Inspect workspace changes produced by the shell command before deciding on cleanup.");
  } else {
    manualSteps.push("Review the recorded boundary before applying any manual remediation.");
  }

  if (manifest.external_effects && manifest.external_effects !== "none") {
    systemsTouched.push(manifest.external_effects);
    manualSteps.push("Check external systems touched by this action and perform any provider-specific undo manually.");
    uncertainty.push(
      "External side effects were recorded, but no trusted compensator is registered for this boundary.",
    );
  }

  if (manifest.snapshot_class === "metadata_only" || manifest.fidelity === "metadata_only") {
    uncertainty.push("Only metadata was captured for this boundary, so exact restore is unavailable.");
  }

  return {
    systems_touched: Array.from(new Set(systemsTouched)),
    objects_touched: Array.from(new Set(objectsTouched)),
    manual_steps: manualSteps,
    uncertainty,
  };
}

function buildManualReviewWarnings(
  manifest: SnapshotManifest,
  integrityOk: boolean,
  options?: {
    omitMetadataWarning?: boolean;
  },
): RecoveryPlan["warnings"] {
  const warnings: RecoveryPlan["warnings"] = [];

  if (
    !options?.omitMetadataWarning &&
    (manifest.snapshot_class === "metadata_only" || manifest.fidelity === "metadata_only")
  ) {
    warnings.push({
      code: "METADATA_ONLY_BOUNDARY",
      message: "This boundary captured metadata only, so exact automated restore is unavailable.",
    });
  }

  warnings.push({
    code: "NO_TRUSTED_COMPENSATOR",
    message: "No trusted adapter-specific compensation strategy is registered for this recovery boundary.",
  });

  if (!integrityOk) {
    warnings.push({
      code: "SNAPSHOT_INTEGRITY_UNCERTAIN",
      message: "Snapshot integrity could not be fully verified. Manual review confidence is reduced.",
    });
  }

  return warnings;
}

function metadataReviewConfidence(manifest: SnapshotManifest, integrityOk: boolean): number {
  const baseConfidence = manifest.external_effects && manifest.external_effects !== "none" ? 0.38 : 0.46;

  return integrityOk ? baseConfidence : Math.max(0.25, baseConfidence - 0.1);
}

function actionBoundaryReviewConfidence(evidence: ActionBoundaryEvidence): number {
  if (evidence.external_effects && evidence.external_effects !== "none") {
    return 0.38;
  }

  if (evidence.side_effect_level === "read_only") {
    return 0.55;
  }

  return 0.44;
}

function createReviewOnlyPlan(params: {
  snapshotId: string;
  manifest: SnapshotManifest;
  integrityOk: boolean;
  preview: Awaited<ReturnType<LocalSnapshotEngine["previewRestore"]>>;
  downgradeReason?: RecoveryDowngradeReason;
  extraUncertainty?: string[];
  omitMetadataWarning?: boolean;
}): RecoveryPlan {
  const downgradeReason =
    params.downgradeReason ??
    ({
      code: "METADATA_ONLY_BOUNDARY",
      message: "This boundary captured metadata only, so exact automated restore is unavailable.",
    } satisfies RecoveryDowngradeReason);
  return {
    schema_version: "recovery-plan.v1",
    recovery_plan_id: createRecoveryPlanId(),
    target: {
      type: "snapshot_id",
      snapshot_id: params.snapshotId,
    },
    recovery_class: "review_only",
    strategy: "manual_review_only",
    confidence: metadataReviewConfidence(params.manifest, params.integrityOk),
    steps: [],
    impact_preview: {
      later_actions_affected: params.preview.later_actions_affected,
      overlapping_paths: params.preview.overlapping_paths,
      external_effects: manifestExternalEffects(params.manifest),
      data_loss_risk: "unknown",
    },
    warnings: [
      downgradeReason,
      ...buildManualReviewWarnings(params.manifest, params.integrityOk, {
        omitMetadataWarning: params.omitMetadataWarning,
      }),
    ],
    downgrade_reason: downgradeReason,
    review_guidance: buildReviewGuidance(params.manifest, params.extraUncertainty),
    created_at: new Date().toISOString(),
  };
}

function requiresSnapshotManualReview(manifest: SnapshotManifest): RecoveryDowngradeReason | null {
  if (manifest.operation_domain === "shell") {
    return {
      code: "OPAQUE_SHELL_BOUNDARY",
      message: "Shell execution boundaries remain manual-review only even when a richer snapshot exists.",
    };
  }

  return null;
}

function createPathSubsetReviewOnlyPlan(params: {
  target: Extract<RecoveryTarget, { type: "path_subset" }>;
  manifest: SnapshotManifest;
  integrityOk: boolean;
}): RecoveryPlan {
  const downgradeReason: RecoveryDowngradeReason = {
    code: "PATH_SUBSET_UNSUPPORTED_FOR_BOUNDARY",
    message: "This boundary does not support exact surgical restore for a requested path subset.",
  };
  return {
    schema_version: "recovery-plan.v1",
    recovery_plan_id: createRecoveryPlanId(),
    target: params.target,
    recovery_class: "review_only",
    strategy: "manual_review_only",
    confidence: metadataReviewConfidence(params.manifest, params.integrityOk),
    steps: [],
    impact_preview: {
      paths_to_change: 0,
      later_actions_affected: 0,
      overlapping_paths: [],
      external_effects: manifestExternalEffects(params.manifest),
      data_loss_risk: "unknown",
    },
    warnings: [downgradeReason, ...buildManualReviewWarnings(params.manifest, params.integrityOk)],
    downgrade_reason: downgradeReason,
    review_guidance: {
      systems_touched: Array.from(new Set([params.manifest.operation_domain ?? "filesystem"])),
      objects_touched: [...params.target.paths],
      manual_steps: [
        "Review the requested paths and apply a manual restore from a trusted boundary or external source.",
      ],
      uncertainty: ["This boundary cannot provide a trusted exact subset restore for the requested paths."],
    },
    created_at: new Date().toISOString(),
  };
}

export function createActionBoundaryReviewPlan(evidence: ActionBoundaryEvidence): RecoveryPlan {
  const downgradeReason: RecoveryDowngradeReason = {
    code: "NO_BOUNDARY_SNAPSHOT",
    message: "This action boundary has no persisted snapshot, so automated restore is unavailable.",
  };
  const warnings: RecoveryPlan["warnings"] = [downgradeReason];

  if (evidence.later_actions_affected > 0) {
    warnings.push({
      code: "LATER_ACTIONS_OVERLAP_BOUNDARY",
      message:
        evidence.overlapping_paths.length > 0
          ? `Recovery would cross ${evidence.later_actions_affected} later action(s) touching ${evidence.overlapping_paths.slice(0, 3).join(", ")}.`
          : `Recovery would cross ${evidence.later_actions_affected} later action(s) recorded after this action boundary.`,
    });
  }

  if (evidence.external_effects && evidence.external_effects !== "none") {
    warnings.push({
      code: "EXTERNAL_EFFECTS_NOT_RESTORABLE",
      message: "External side effects were recorded for this action, but no trusted compensator is registered.",
    });
  }

  const reviewGuidance: RecoveryPlan["review_guidance"] = {
    systems_touched: Array.from(
      new Set(
        [evidence.operation_domain, evidence.external_effects].filter((value): value is string =>
          Boolean(value && value !== "none"),
        ),
      ),
    ),
    objects_touched: [evidence.target_locator],
    manual_steps: [
      evidence.display_name
        ? `Inspect the effects of ${evidence.display_name} before applying manual cleanup.`
        : "Inspect the effects of this action before applying manual cleanup.",
    ],
    uncertainty: ["No persisted snapshot was captured for this action boundary, so recovery is review-only."],
  };

  if (evidence.reversibility_hint === "compensatable") {
    reviewGuidance.uncertainty.push("A future adapter-specific compensator may be able to improve this recovery path.");
  }

  return {
    schema_version: "recovery-plan.v1",
    recovery_plan_id: createRecoveryPlanId(),
    target: {
      type: "action_boundary",
      action_id: evidence.action_id,
    },
    recovery_class: "review_only",
    strategy: "manual_review_only",
    confidence: actionBoundaryReviewConfidence(evidence),
    steps: [],
    impact_preview: {
      later_actions_affected: evidence.later_actions_affected,
      overlapping_paths: evidence.overlapping_paths,
      external_effects:
        evidence.external_effects && evidence.external_effects !== "none" ? [evidence.external_effects] : [],
      data_loss_risk: evidence.later_actions_affected > 0 ? "moderate" : "unknown",
    },
    warnings,
    downgrade_reason: downgradeReason,
    review_guidance: reviewGuidance,
    created_at: new Date().toISOString(),
  };
}

function createCompensatablePlan(params: {
  snapshotId: string;
  preview: Awaited<ReturnType<LocalSnapshotEngine["previewRestore"]>>;
  candidate: CompensationPlanCandidate;
}): RecoveryPlan {
  return {
    schema_version: "recovery-plan.v1",
    recovery_plan_id: createRecoveryPlanId(),
    target: {
      type: "snapshot_id",
      snapshot_id: params.snapshotId,
    },
    recovery_class: "compensatable",
    strategy: params.candidate.strategy,
    confidence: params.candidate.confidence,
    steps: params.candidate.steps,
    impact_preview: {
      later_actions_affected: params.preview.later_actions_affected,
      overlapping_paths: params.preview.overlapping_paths,
      external_effects: params.candidate.impact_preview.external_effects,
      data_loss_risk: params.candidate.impact_preview.data_loss_risk,
    },
    warnings: params.candidate.warnings ?? [],
    review_guidance: params.candidate.review_guidance,
    created_at: new Date().toISOString(),
  };
}

function capabilityWorkspaceRoot(capability: CapabilityRecord): string | null {
  const workspaceRoot = capability.details.workspace_root;
  return typeof workspaceRoot === "string" && workspaceRoot.length > 0 ? workspaceRoot : null;
}

function findCapability(capabilities: CapabilityRecord[], capabilityName: string): CapabilityRecord | null {
  return capabilities.find((capability) => capability.capability_name === capabilityName) ?? null;
}

function findWorkspaceCapabilityForManifest(
  manifest: SnapshotManifest,
  capabilities: CapabilityRecord[],
): CapabilityRecord | null {
  return (
    capabilities.find((capability) => {
      if (capability.capability_name !== "workspace.root_access") {
        return false;
      }

      return capabilityWorkspaceRoot(capability) === manifest.workspace_root;
    }) ?? null
  );
}

function createCapabilityReviewOnlyPlan(params: {
  target: RecoveryTarget;
  manifest: SnapshotManifest;
  preview: Pick<
    RecoveryPlan["impact_preview"],
    "paths_to_change" | "later_actions_affected" | "overlapping_paths" | "data_loss_risk"
  >;
  warning: RecoveryPlan["warnings"][number];
}): RecoveryPlan {
  const reviewGuidance = buildReviewGuidance(params.manifest) ?? {
    systems_touched: [],
    objects_touched: [],
    manual_steps: [],
    uncertainty: [],
  };
  const preview = {
    paths_to_change: params.preview.paths_to_change ?? 0,
    later_actions_affected: params.preview.later_actions_affected,
    overlapping_paths: params.preview.overlapping_paths,
    data_loss_risk: params.preview.data_loss_risk,
  };
  reviewGuidance.manual_steps = [
    "Rerun capability_refresh after verifying workspace access and runtime snapshot storage before retrying automatic recovery.",
    ...reviewGuidance.manual_steps,
  ];
  reviewGuidance.uncertainty = [
    "Latest cached capability state does not support a trustworthy automatic restore for this boundary.",
    ...reviewGuidance.uncertainty,
  ];

  return {
    schema_version: "recovery-plan.v1",
    recovery_plan_id: createRecoveryPlanId(),
    target: params.target,
    recovery_class: "review_only",
    strategy: "manual_review_only",
    confidence: 0.34,
    steps: [],
    impact_preview: {
      paths_to_change: preview.paths_to_change,
      later_actions_affected: preview.later_actions_affected,
      overlapping_paths: preview.overlapping_paths,
      external_effects: manifestExternalEffects(params.manifest),
      data_loss_risk: preview.data_loss_risk,
    },
    warnings: [
      params.warning,
      ...buildWarnings(
        {
          ...preview,
          confidence: 0.34,
        },
        true,
      ),
    ],
    downgrade_reason: params.warning,
    review_guidance: reviewGuidance,
    created_at: new Date().toISOString(),
  };
}

function evaluateRestoreCapabilityState(
  manifest: SnapshotManifest,
  cachedCapabilityState: CachedCapabilityState | null | undefined,
): RecoveryPlan["warnings"][number] | null {
  if (!cachedCapabilityState) {
    return null;
  }

  if (cachedCapabilityState.is_stale) {
    return {
      code: "CAPABILITY_STATE_STALE",
      message:
        "Cached workspace/runtime capability state is stale; rerun capability_refresh before trusting automatic restore.",
    };
  }

  const workspaceCapability = findWorkspaceCapabilityForManifest(manifest, cachedCapabilityState.capabilities);
  if (!workspaceCapability) {
    return {
      code: "CAPABILITY_STATE_INCOMPLETE",
      message: "Cached capability state does not include governed workspace access for this recovery boundary.",
    };
  }

  if (workspaceCapability.status !== "available") {
    return {
      code: "WORKSPACE_CAPABILITY_UNAVAILABLE",
      message: `Cached workspace access capability is ${workspaceCapability.status}; automatic restore is not trusted for this boundary.`,
    };
  }

  const runtimeStorageCapability = findCapability(cachedCapabilityState.capabilities, "host.runtime_storage");
  if (!runtimeStorageCapability) {
    return {
      code: "CAPABILITY_STATE_INCOMPLETE",
      message:
        "Cached capability state does not include runtime snapshot storage readiness for this recovery boundary.",
    };
  }

  if (runtimeStorageCapability.status !== "available") {
    return {
      code: "RUNTIME_STORAGE_CAPABILITY_DEGRADED",
      message: `Cached runtime snapshot storage capability is ${runtimeStorageCapability.status}; automatic restore is not trusted for this boundary.`,
    };
  }

  return null;
}

export async function planSnapshotRecovery(
  snapshotEngine: LocalSnapshotEngine,
  snapshotId: string,
  options?: {
    compensation_registry?: CompensationRegistry;
    cached_capability_state?: CachedCapabilityState | null;
  },
): Promise<RecoveryPlan> {
  const manifest = await snapshotEngine.getSnapshotManifest(snapshotId);

  if (!manifest) {
    throw new NotFoundError(`No snapshot found for ${snapshotId}.`, {
      snapshot_id: snapshotId,
    });
  }

  const preview = await snapshotEngine.previewRestore(snapshotId);
  const integrityOk = await snapshotEngine.verifyIntegrity(snapshotId);

  if (manifest.snapshot_class === "metadata_only" || manifest.fidelity === "metadata_only") {
    const compensationStrategy = options?.compensation_registry?.resolve(manifest) ?? null;

    if (compensationStrategy) {
      const candidate = compensationStrategy.buildCandidate({
        manifest,
        preview,
        integrity_ok: integrityOk,
      });
      return createCompensatablePlan({
        snapshotId,
        preview,
        candidate,
      });
    }

    return createReviewOnlyPlan({
      snapshotId,
      manifest,
      integrityOk,
      preview,
    });
  }

  const manualReviewReason = requiresSnapshotManualReview(manifest);
  if (manualReviewReason) {
    return createReviewOnlyPlan({
      snapshotId,
      manifest,
      integrityOk,
      preview,
      downgradeReason: manualReviewReason,
      extraUncertainty: [
        "The original shell command may have produced broad or partially opaque side effects, so automated restore is not trusted.",
      ],
      omitMetadataWarning: true,
    });
  }

  const capabilityWarning = evaluateRestoreCapabilityState(manifest, options?.cached_capability_state);
  if (capabilityWarning) {
    return createCapabilityReviewOnlyPlan({
      target: {
        type: "snapshot_id",
        snapshot_id: snapshotId,
      },
      manifest,
      preview: {
        paths_to_change: preview.paths_to_change,
        later_actions_affected: preview.later_actions_affected,
        overlapping_paths: preview.overlapping_paths,
        data_loss_risk: integrityOk ? preview.data_loss_risk : impactRisk(manifest),
      },
      warning: capabilityWarning,
    });
  }

  const warnings = buildWarnings(preview, integrityOk);
  const overlapPenalty = preview.later_actions_affected > 0 ? 0.1 : 0;
  const confidence = integrityOk ? preview.confidence : Math.min(preview.confidence, 0.7);

  return {
    schema_version: "recovery-plan.v1",
    recovery_plan_id: createRecoveryPlanId(),
    target: {
      type: "snapshot_id",
      snapshot_id: snapshotId,
    },
    recovery_class: "reversible",
    strategy: "restore_snapshot",
    confidence: Math.max(0.4, confidence - overlapPenalty),
    steps: [
      {
        step_id: createRecoveryStepId(),
        type: "restore_snapshot",
        idempotent: true,
        depends_on: [],
      },
    ],
    impact_preview: {
      paths_to_change: preview.paths_to_change,
      later_actions_affected: preview.later_actions_affected,
      overlapping_paths: preview.overlapping_paths,
      external_effects: [],
      data_loss_risk: integrityOk ? preview.data_loss_risk : impactRisk(manifest),
    },
    warnings,
    created_at: new Date().toISOString(),
  };
}

export async function executeSnapshotRecovery(
  snapshotEngine: LocalSnapshotEngine,
  snapshotId: string,
  options?: {
    compensation_registry?: CompensationRegistry;
    cached_capability_state?: CachedCapabilityState | null;
  },
): Promise<ExecuteRecoveryResponsePayload> {
  const recoveryPlan = await planSnapshotRecovery(snapshotEngine, snapshotId, options);
  const manifest = await loadRecoverySnapshotManifest(snapshotEngine, snapshotId);
  const preview = await snapshotEngine.previewRestore(snapshotId);
  const integrityOk = await snapshotEngine.verifyIntegrity(snapshotId);

  if (recoveryPlan.recovery_class === "compensatable") {
    const compensationStrategy = options?.compensation_registry?.resolve(manifest) ?? null;

    if (!compensationStrategy) {
      throw new PreconditionError("No trusted compensator is registered for this recovery plan.", {
        snapshot_id: snapshotId,
        recovery_class: recoveryPlan.recovery_class,
        strategy: recoveryPlan.strategy,
      });
    }

    const compensated = await compensationStrategy.execute({
      manifest,
      preview,
      integrity_ok: integrityOk,
    });

    if (!compensated) {
      throw new InternalError("Compensating recovery execution failed.", {
        snapshot_id: snapshotId,
        strategy: recoveryPlan.strategy,
      });
    }

    return {
      recovery_plan: recoveryPlan,
      restored: false,
      outcome: "compensated",
      executed_at: new Date().toISOString(),
    };
  }

  if (recoveryPlan.recovery_class !== "reversible") {
    throw new PreconditionError("This recovery plan requires manual review or adapter-specific compensation.", {
      snapshot_id: snapshotId,
      recovery_class: recoveryPlan.recovery_class,
      strategy: recoveryPlan.strategy,
    });
  }

  const restored = await snapshotEngine.restore(snapshotId);

  if (!restored) {
    throw new InternalError("Snapshot recovery execution failed.", {
      snapshot_id: snapshotId,
    });
  }

  return {
    recovery_plan: recoveryPlan,
    restored,
    outcome: "restored",
    executed_at: new Date().toISOString(),
  };
}

export async function planPathSubsetRecovery(
  snapshotEngine: LocalSnapshotEngine,
  target: Extract<RecoveryTarget, { type: "path_subset" }>,
  options?: {
    cached_capability_state?: CachedCapabilityState | null;
  },
): Promise<RecoveryPlan> {
  const manifest = await snapshotEngine.getSnapshotManifest(target.snapshot_id);
  if (!manifest) {
    throw new NotFoundError(`No snapshot found for ${target.snapshot_id}.`, {
      snapshot_id: target.snapshot_id,
    });
  }

  const integrityOk = await snapshotEngine.verifyIntegrity(target.snapshot_id);
  if (manifest.snapshot_class === "metadata_only" || manifest.fidelity === "metadata_only") {
    return createPathSubsetReviewOnlyPlan({
      target,
      manifest,
      integrityOk,
    });
  }

  if (requiresSnapshotManualReview(manifest)) {
    return createPathSubsetReviewOnlyPlan({
      target,
      manifest,
      integrityOk,
    });
  }

  const preview = await snapshotEngine.previewRestoreSubset(target.snapshot_id, target.paths);
  const capabilityWarning = evaluateRestoreCapabilityState(manifest, options?.cached_capability_state);
  if (capabilityWarning) {
    return createCapabilityReviewOnlyPlan({
      target,
      manifest,
      preview: {
        paths_to_change: preview.paths_to_change,
        later_actions_affected: preview.later_actions_affected,
        overlapping_paths: preview.overlapping_paths,
        data_loss_risk: integrityOk ? preview.data_loss_risk : impactRisk(manifest),
      },
      warning: capabilityWarning,
    });
  }
  const warnings = buildWarnings(preview, integrityOk);
  const overlapPenalty = preview.later_actions_affected > 0 ? 0.1 : 0;
  const confidence = integrityOk ? preview.confidence : Math.min(preview.confidence, 0.7);

  return {
    schema_version: "recovery-plan.v1",
    recovery_plan_id: createRecoveryPlanId(),
    target,
    recovery_class: "reversible",
    strategy: "restore_path_subset",
    confidence: Math.max(0.4, confidence - overlapPenalty),
    steps: [
      {
        step_id: createRecoveryStepId(),
        type: "restore_path_subset",
        idempotent: true,
        depends_on: [],
      },
    ],
    impact_preview: {
      paths_to_change: preview.paths_to_change,
      later_actions_affected: preview.later_actions_affected,
      overlapping_paths: preview.overlapping_paths,
      external_effects: [],
      data_loss_risk: integrityOk ? preview.data_loss_risk : impactRisk(manifest),
    },
    warnings,
    review_guidance: {
      systems_touched: ["filesystem"],
      objects_touched: [...target.paths],
      manual_steps: [],
      uncertainty: [],
    },
    created_at: new Date().toISOString(),
  };
}

export async function executePathSubsetRecovery(
  snapshotEngine: LocalSnapshotEngine,
  target: Extract<RecoveryTarget, { type: "path_subset" }>,
  options?: {
    cached_capability_state?: CachedCapabilityState | null;
  },
): Promise<ExecuteRecoveryResponsePayload> {
  const recoveryPlan = await planPathSubsetRecovery(snapshotEngine, target, options);
  if (recoveryPlan.recovery_class !== "reversible") {
    throw new PreconditionError("This path-subset recovery target is manual-review only.", {
      snapshot_id: target.snapshot_id,
      paths: target.paths,
      recovery_class: recoveryPlan.recovery_class,
      strategy: recoveryPlan.strategy,
    });
  }

  const restoredResult = await snapshotEngine.restoreSubset(target.snapshot_id, target.paths);
  if (!restoredResult.restored) {
    throw new InternalError("Path-subset recovery execution failed.", {
      snapshot_id: target.snapshot_id,
      paths: target.paths,
      strategy: recoveryPlan.strategy,
    });
  }

  return {
    recovery_plan: recoveryPlan,
    restored: true,
    outcome: "restored",
    executed_at: new Date().toISOString(),
  };
}

export async function loadRecoverySnapshotManifest(
  snapshotEngine: LocalSnapshotEngine,
  snapshotId: string,
): Promise<SnapshotManifest> {
  const manifest = await snapshotEngine.getSnapshotManifest(snapshotId);

  if (!manifest) {
    throw new NotFoundError(`No snapshot found for ${snapshotId}.`, {
      snapshot_id: snapshotId,
    });
  }

  return manifest;
}
