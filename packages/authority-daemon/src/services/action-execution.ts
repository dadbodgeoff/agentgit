import path from "node:path";

import {
  type AdapterRegistry,
  type OwnedDraftStore,
  type OwnedNoteStore,
  type OwnedTicketStore,
  parseDraftLocator,
  parseNoteLocator,
  parseTicketLocator,
} from "@agentgit/execution-adapters";
import { type RunJournal } from "@agentgit/run-journal";
import {
  AgentGitError,
  type ErrorEnvelope,
  type ExecutionArtifact,
  InternalError,
  PreconditionError,
  type ActionRecord,
  type PolicyOutcomeRecord,
  type SubmitActionAttemptResponsePayload,
} from "@agentgit/schemas";
import { type SnapshotSelectionResult, type LocalSnapshotEngine } from "@agentgit/snapshot-engine";
import type { LatencyMetricsStore } from "../latency-metrics.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function stringPreview(value: unknown, maxLength = 240): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }

  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function artifactContentFromExecutionResult(
  artifact: ExecutionArtifact,
  action: ActionRecord,
  executionResult: {
    output: Record<string, unknown>;
  },
): string | null {
  switch (artifact.type) {
    case "stdout":
      return typeof executionResult.output.stdout === "string" ? executionResult.output.stdout : null;
    case "stderr":
      return typeof executionResult.output.stderr === "string" ? executionResult.output.stderr : null;
    case "diff":
      return typeof executionResult.output.diff_preview === "string" ? executionResult.output.diff_preview : null;
    case "request_response":
      return typeof executionResult.output.preview === "string" ? executionResult.output.preview : null;
    case "file_content": {
      const rawInput = isObject(action.input.raw) ? action.input.raw : null;
      return typeof rawInput?.content === "string" ? rawInput.content : null;
    }
    case "screenshot":
      return null;
  }
}

function artifactVisibilityForAction(
  artifact: ExecutionArtifact,
  action: ActionRecord,
): ExecutionArtifact["visibility"] {
  if ((artifact.type === "stdout" || artifact.type === "stderr") && action.operation.domain === "shell") {
    return "internal";
  }

  if (
    action.input.contains_sensitive_data &&
    (artifact.type === "file_content" || artifact.type === "diff" || artifact.type === "request_response")
  ) {
    return "sensitive_internal";
  }

  return artifact.visibility;
}

function getWorkspaceRoot(locator: string, fallbackRoots: string[]): string {
  const resolvedLocator = path.resolve(locator);
  const matchedRoot = fallbackRoots
    .map((root) => path.resolve(root))
    .find(
      (resolvedRoot) => resolvedLocator === resolvedRoot || resolvedLocator.startsWith(`${resolvedRoot}${path.sep}`),
    );
  return matchedRoot ?? path.resolve(fallbackRoots[0] ?? process.cwd());
}

async function captureOwnedPreimage(
  action: ActionRecord,
  draftStore: OwnedDraftStore,
  noteStore: OwnedNoteStore,
  ticketStore: OwnedTicketStore,
): Promise<Record<string, unknown> | null> {
  if (action.operation.domain !== "function") {
    return null;
  }

  if (action.operation.kind === "update_draft") {
    const draftId = parseDraftLocator(action.target.primary.locator);
    if (!draftId) {
      return null;
    }

    const existing = await draftStore.getDraft(draftId);
    return existing ? { ...existing } : null;
  }

  if (action.operation.kind === "restore_draft" || action.operation.kind === "delete_draft") {
    const draftId = parseDraftLocator(action.target.primary.locator);
    if (!draftId) {
      return null;
    }

    const existing = await draftStore.getDraft(draftId);
    return existing ? { ...existing } : null;
  }

  if (
    action.operation.kind === "update_note" ||
    action.operation.kind === "restore_note" ||
    action.operation.kind === "delete_note"
  ) {
    const noteId = parseNoteLocator(action.target.primary.locator);
    if (!noteId) {
      return null;
    }

    const existing = await noteStore.getNote(noteId);
    return existing ? { ...existing } : null;
  }

  if (
    action.operation.kind === "update_ticket" ||
    action.operation.kind === "delete_ticket" ||
    action.operation.kind === "restore_ticket"
  ) {
    const ticketId = parseTicketLocator(action.target.primary.locator);
    if (!ticketId) {
      return null;
    }

    const existing = await ticketStore.getTicket(ticketId);
    return existing ? { ...existing } : null;
  }

  return null;
}

export interface ExecuteGovernedActionParams {
  action: ActionRecord;
  policyOutcome: PolicyOutcomeRecord;
  snapshotSelection: SnapshotSelectionResult | null;
  runSummary: {
    workspace_roots: string[];
  };
  journal: RunJournal;
  adapterRegistry: AdapterRegistry;
  snapshotEngine: LocalSnapshotEngine;
  draftStore: OwnedDraftStore;
  noteStore: OwnedNoteStore;
  ticketStore: OwnedTicketStore;
  latencyMetrics: LatencyMetricsStore;
  executeHostedDelegatedAction: (
    action: ActionRecord,
  ) => Promise<SubmitActionAttemptResponsePayload["execution_result"]>;
}

export async function executeGovernedAction(params: ExecuteGovernedActionParams): Promise<{
  executionResult: SubmitActionAttemptResponsePayload["execution_result"];
  snapshotRecord: SubmitActionAttemptResponsePayload["snapshot_record"];
}> {
  const workspaceRoot = getWorkspaceRoot(params.action.target.primary.locator, params.runSummary.workspace_roots);
  let snapshotRecord: SubmitActionAttemptResponsePayload["snapshot_record"] = null;

  if (params.policyOutcome.preconditions.snapshot_required) {
    const requestedClass = params.snapshotSelection?.snapshot_class ?? "metadata_only";
    const capturedPreimage =
      requestedClass === "metadata_only"
        ? await captureOwnedPreimage(params.action, params.draftStore, params.noteStore, params.ticketStore)
        : null;
    snapshotRecord = await params.snapshotEngine.createSnapshot({
      action: params.action,
      requested_class: requestedClass,
      workspace_root: workspaceRoot,
      captured_preimage: capturedPreimage,
    });
    const createdSnapshot = snapshotRecord;
    params.journal.appendRunEvent(params.action.run_id, {
      event_type: "snapshot.created",
      occurred_at: createdSnapshot.created_at,
      recorded_at: createdSnapshot.created_at,
      payload: {
        action_id: params.action.action_id,
        snapshot_id: createdSnapshot.snapshot_id,
        snapshot_class: createdSnapshot.snapshot_class,
        fidelity: createdSnapshot.fidelity,
        selection_reason_codes: params.snapshotSelection?.reason_codes ?? [],
        selection_basis: params.snapshotSelection?.basis ?? null,
      },
    });
  }

  let executionResult: SubmitActionAttemptResponsePayload["execution_result"] = null;
  if (params.policyOutcome.decision === "allow" || params.policyOutcome.decision === "allow_with_snapshot") {
    const mcpFacet = isObject(params.action.facets.mcp) ? params.action.facets.mcp : null;
    const executionModeRequested =
      mcpFacet?.execution_mode_requested === "hosted_delegated" ? "hosted_delegated" : "local_proxy";
    const adapter = params.adapterRegistry.findAdapter(params.action);
    if (executionModeRequested !== "hosted_delegated" && !adapter) {
      throw new AgentGitError(
        "No governed execution adapter is available for this action domain.",
        "CAPABILITY_UNAVAILABLE",
        {
          requested_domain: params.action.operation.domain,
          requested_operation: params.action.operation.name,
          supported_domains: params.adapterRegistry.supportedDomains(),
        },
      );
    }

    const localAdapter = executionModeRequested === "hosted_delegated" ? null : adapter;
    let fastActionStartedAt: number | null = null;

    if (
      snapshotRecord &&
      params.action.operation.domain === "filesystem" &&
      !(await params.snapshotEngine.verifyTargetUnchanged(
        snapshotRecord.snapshot_id,
        params.action.target.primary.locator,
      ))
    ) {
      throw new PreconditionError("File modified between snapshot and execution. Another agent may have changed it.", {
        path: params.action.target.primary.locator,
        snapshot_id: snapshotRecord.snapshot_id,
      });
    }

    if (executionModeRequested !== "hosted_delegated") {
      if (!localAdapter) {
        throw new AgentGitError(
          "No governed execution adapter is available for this action domain.",
          "CAPABILITY_UNAVAILABLE",
          {
            requested_domain: params.action.operation.domain,
            requested_operation: params.action.operation.name,
            supported_domains: params.adapterRegistry.supportedDomains(),
          },
        );
      }

      fastActionStartedAt = performance.now();
      try {
        await localAdapter.verifyPreconditions({
          action: params.action,
          policy_outcome: params.policyOutcome,
          snapshot_record: snapshotRecord,
          workspace_root: workspaceRoot,
        });
      } catch (error) {
        params.latencyMetrics.recordFastAction(performance.now() - fastActionStartedAt);
        throw error;
      }
    }

    const executionStartedAt = new Date().toISOString();
    params.journal.appendRunEvent(params.action.run_id, {
      event_type: "execution.started",
      occurred_at: executionStartedAt,
      recorded_at: executionStartedAt,
      payload: {
        action_id: params.action.action_id,
        adapter_domains:
          executionModeRequested === "hosted_delegated"
            ? ["mcp", "provider_hosted"]
            : (adapter?.supported_domains ?? []),
      },
    });

    try {
      if (executionModeRequested === "hosted_delegated") {
        executionResult = await params.executeHostedDelegatedAction(params.action);
      } else {
        const nonHostedAdapter = localAdapter;
        if (!nonHostedAdapter) {
          throw new InternalError("Execution adapter disappeared after precondition verification.", {
            action_id: params.action.action_id,
            requested_domain: params.action.operation.domain,
          });
        }
        const localActionStartedAt = fastActionStartedAt ?? performance.now();
        try {
          executionResult = await nonHostedAdapter.execute({
            action: params.action,
            policy_outcome: params.policyOutcome,
            snapshot_record: snapshotRecord,
            workspace_root: workspaceRoot,
          });
        } finally {
          params.latencyMetrics.recordFastAction(performance.now() - localActionStartedAt);
        }
      }
      if (!executionResult) {
        throw new InternalError("Execution adapter returned no execution result after an allow decision.", {
          action_id: params.action.action_id,
          requested_mode: executionModeRequested,
        });
      }
      const completedExecutionResult = executionResult;
      const artifactCaptureFailures: Array<{
        artifact_id: string;
        type: string;
        code: ErrorEnvelope["code"];
        retryable: boolean;
        low_disk_pressure: boolean;
      }> = [];

      const storedArtifacts = completedExecutionResult.artifacts.flatMap((artifact) => {
        const content = artifactContentFromExecutionResult(artifact, params.action, completedExecutionResult);
        const visibility = artifactVisibilityForAction(artifact, params.action);
        if (content === null) {
          return [];
        }

        try {
          const integrity = params.journal.storeArtifact({
            artifact_id: artifact.artifact_id,
            run_id: params.action.run_id,
            action_id: params.action.action_id,
            execution_id: completedExecutionResult.execution_id,
            type: artifact.type,
            content_ref: artifact.content_ref,
            byte_size: artifact.byte_size,
            visibility,
            expires_at: null,
            expired_at: null,
            created_at: completedExecutionResult.completed_at,
            content,
          });
          return [
            {
              artifact_id: artifact.artifact_id,
              type: artifact.type,
              byte_size: artifact.byte_size,
              visibility,
              integrity,
            },
          ];
        } catch (error) {
          const normalizedError =
            error instanceof AgentGitError
              ? error
              : new InternalError("Artifact capture failed during execution completion.", {
                  artifact_id: artifact.artifact_id,
                  cause: error instanceof Error ? error.message : String(error),
                });
          artifactCaptureFailures.push({
            artifact_id: artifact.artifact_id,
            type: artifact.type,
            code: normalizedError.code,
            retryable: normalizedError.retryable,
            low_disk_pressure: normalizedError.details?.low_disk_pressure === true,
          });
          return [];
        }
      });
      const artifactCaptureWarnings =
        artifactCaptureFailures.length > 0
          ? [
              artifactCaptureFailures.some((failure) => failure.low_disk_pressure)
                ? `Supporting evidence capture degraded: ${artifactCaptureFailures.length} artifact(s) could not be stored because local storage was unavailable.`
                : `Supporting evidence capture degraded: ${artifactCaptureFailures.length} artifact(s) could not be stored durably.`,
            ]
          : [];
      executionResult = {
        ...completedExecutionResult,
        artifact_capture: {
          requested_count: completedExecutionResult.artifacts.length,
          stored_count: storedArtifacts.length,
          degraded: artifactCaptureFailures.length > 0,
          failures: artifactCaptureFailures,
        },
      };

      params.journal.appendRunEvent(params.action.run_id, {
        event_type: "execution.completed",
        occurred_at: completedExecutionResult.completed_at,
        recorded_at: completedExecutionResult.completed_at,
        payload: {
          action_id: params.action.action_id,
          execution_id: completedExecutionResult.execution_id,
          mode: completedExecutionResult.mode,
          success: completedExecutionResult.success,
          side_effect_level: params.action.risk_hints.side_effect_level,
          artifact_types: completedExecutionResult.artifacts.map((artifact) => artifact.type),
          artifact_count: completedExecutionResult.artifacts.length,
          stored_artifact_count: storedArtifacts.length,
          artifact_capture_failed_count: artifactCaptureFailures.length,
          artifact_capture_failures: artifactCaptureFailures,
          warnings: artifactCaptureWarnings,
          artifacts: storedArtifacts,
          target_path:
            typeof completedExecutionResult.output.target === "string" ? completedExecutionResult.output.target : null,
          target_path_visibility: "user",
          operation:
            typeof completedExecutionResult.output.operation === "string"
              ? completedExecutionResult.output.operation
              : null,
          bytes_written:
            typeof completedExecutionResult.output.bytes_written === "number"
              ? completedExecutionResult.output.bytes_written
              : null,
          before_preview: stringPreview(completedExecutionResult.output.before_preview),
          before_preview_visibility: params.action.input.contains_sensitive_data ? "sensitive_internal" : "user",
          after_preview: stringPreview(completedExecutionResult.output.after_preview),
          after_preview_visibility: params.action.input.contains_sensitive_data ? "sensitive_internal" : "user",
          diff_preview: stringPreview(completedExecutionResult.output.diff_preview),
          diff_preview_visibility: params.action.input.contains_sensitive_data ? "sensitive_internal" : "user",
          deleted:
            typeof completedExecutionResult.output.deleted === "boolean"
              ? completedExecutionResult.output.deleted
              : null,
          exit_code:
            typeof completedExecutionResult.output.exit_code === "number"
              ? completedExecutionResult.output.exit_code
              : null,
          stdout_excerpt: stringPreview(completedExecutionResult.output.stdout),
          stdout_excerpt_visibility: params.action.operation.domain === "shell" ? "internal" : "user",
          stderr_excerpt: stringPreview(completedExecutionResult.output.stderr),
          stderr_excerpt_visibility: params.action.operation.domain === "shell" ? "internal" : "user",
        },
      });
    } catch (error) {
      const now = new Date().toISOString();
      const details = error instanceof AgentGitError && error.details ? error.details : undefined;
      params.journal.appendRunEvent(params.action.run_id, {
        event_type: "execution.failed",
        occurred_at: now,
        recorded_at: now,
        payload: {
          action_id: params.action.action_id,
          error_code: error instanceof AgentGitError ? error.code : "INTERNAL_ERROR",
          error: error instanceof Error ? error.message : String(error),
          error_visibility: "user",
          exit_code: typeof details?.exit_code === "number" ? details.exit_code : null,
          signal: typeof details?.signal === "string" ? details.signal : null,
          stdout_excerpt: stringPreview(details?.stdout),
          stdout_excerpt_visibility: params.action.operation.domain === "shell" ? "internal" : "user",
          stderr_excerpt: stringPreview(details?.stderr),
          stderr_excerpt_visibility: params.action.operation.domain === "shell" ? "internal" : "user",
        },
      });
      throw error;
    }
  }

  return {
    executionResult,
    snapshotRecord,
  };
}
