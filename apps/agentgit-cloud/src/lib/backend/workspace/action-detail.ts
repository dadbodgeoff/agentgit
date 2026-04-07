import "server-only";

import {
  ActionRecordSchema,
  type ActionRecord,
  type QueryHelperResponsePayload,
  type QueryTimelineResponsePayload,
} from "@agentgit/schemas";

import { withWorkspaceAuthorityClient } from "@/lib/backend/authority/client";
import { findRepositoryRuntimeRecord } from "@/lib/backend/workspace/repository-inventory";
import { getRepositoryJournalPath } from "@/lib/backend/workspace/workspace-runtime";
import { ActionDetailSchema } from "@/schemas/cloud";
import { RunJournal } from "@agentgit/run-journal";

function repoLabel(owner: string, name: string) {
  return `${owner}/${name}`;
}

function eventActionId(payload: Record<string, unknown> | undefined): string | null {
  return typeof payload?.action_id === "string" ? payload.action_id : null;
}

function extractActionRecord(payload: Record<string, unknown>, runId: string, actionId: string): ActionRecord | null {
  const direct = ActionRecordSchema.safeParse(payload.action);
  if (direct.success) {
    return direct.data;
  }

  return ActionRecordSchema.safeParse({
    schema_version: "action.v1",
    action_id: actionId,
    run_id: runId,
    session_id: typeof payload.session_id === "string" ? payload.session_id : `sess_${runId}`,
    status: "normalized",
    timestamps: {
      requested_at: typeof payload.occurred_at === "string" ? payload.occurred_at : new Date().toISOString(),
      normalized_at: typeof payload.occurred_at === "string" ? payload.occurred_at : new Date().toISOString(),
    },
    provenance: {
      mode: payload.provenance_mode ?? "pre_execution",
      source: payload.provenance_source ?? "governed_runtime",
      confidence: payload.provenance_confidence ?? 1,
    },
    actor: {
      type: "agent",
      agent_name: "AgentGit",
      agent_framework: "authority",
      tool_name: "agentgit",
      tool_kind: "governed_runtime",
    },
    operation: {
      domain: typeof payload.operation === "object" && payload.operation !== null && "domain" in payload.operation ? (payload.operation as { domain: string }).domain : "filesystem",
      kind: typeof payload.operation === "object" && payload.operation !== null && "kind" in payload.operation ? (payload.operation as { kind: string }).kind : "unknown",
      name: typeof payload.operation === "object" && payload.operation !== null && "name" in payload.operation ? (payload.operation as { name: string }).name : "unknown",
      display_name:
        typeof payload.operation === "object" && payload.operation !== null && "display_name" in payload.operation
          ? (payload.operation as { display_name?: string }).display_name
          : undefined,
    },
    execution_path: {
      surface: "governed_shell",
      mode: "pre_execution",
      credential_mode: "brokered",
    },
    target: {
      primary: {
        type: "unknown",
        locator: typeof payload.target_locator === "string" ? payload.target_locator : "unknown",
        label: typeof payload.target_label === "string" ? payload.target_label : undefined,
      },
      scope: {
        breadth: "single",
        unknowns: [],
      },
    },
    input: {
      raw: {},
      redacted: {},
      schema_ref: null,
      contains_sensitive_data: false,
    },
    risk_hints: payload.risk_hints ?? {
      side_effect_level: "unknown",
      external_effects: [],
      reversibility_hint: "reversible",
      sensitivity_hint: "normal",
      batch: false,
    },
    facets: {},
    normalization: payload.normalization ?? {
      mapper: "fallback",
      inferred_fields: [],
      warnings: [],
      normalization_confidence: 0.5,
    },
    confidence_assessment: payload.confidence_assessment ?? {
      engine_version: "fallback",
      score: typeof payload.confidence_score === "number" ? payload.confidence_score : 0.5,
      band: "guarded",
      requires_human_review: false,
      factors: [],
    },
  }).success
    ? ActionRecordSchema.parse({
        schema_version: "action.v1",
        action_id: actionId,
        run_id: runId,
        session_id: typeof payload.session_id === "string" ? payload.session_id : `sess_${runId}`,
        status: "normalized",
        timestamps: {
          requested_at: typeof payload.occurred_at === "string" ? payload.occurred_at : new Date().toISOString(),
          normalized_at: typeof payload.occurred_at === "string" ? payload.occurred_at : new Date().toISOString(),
        },
        provenance: {
          mode: payload.provenance_mode ?? "pre_execution",
          source: payload.provenance_source ?? "governed_runtime",
          confidence: payload.provenance_confidence ?? 1,
        },
        actor: {
          type: "agent",
          agent_name: "AgentGit",
          agent_framework: "authority",
          tool_name: "agentgit",
          tool_kind: "governed_runtime",
        },
        operation: {
          domain:
            typeof payload.operation === "object" && payload.operation !== null && "domain" in payload.operation
              ? (payload.operation as { domain: string }).domain
              : "filesystem",
          kind:
            typeof payload.operation === "object" && payload.operation !== null && "kind" in payload.operation
              ? (payload.operation as { kind: string }).kind
              : "unknown",
          name:
            typeof payload.operation === "object" && payload.operation !== null && "name" in payload.operation
              ? (payload.operation as { name: string }).name
              : "unknown",
          display_name:
            typeof payload.operation === "object" && payload.operation !== null && "display_name" in payload.operation
              ? (payload.operation as { display_name?: string }).display_name
              : undefined,
        },
        execution_path: {
          surface: "governed_shell",
          mode: "pre_execution",
          credential_mode: "brokered",
        },
        target: {
          primary: {
            type: "unknown",
            locator: typeof payload.target_locator === "string" ? payload.target_locator : "unknown",
            label: typeof payload.target_label === "string" ? payload.target_label : undefined,
          },
          scope: {
            breadth: "single",
            unknowns: [],
          },
        },
        input: {
          raw: {},
          redacted: {},
          schema_ref: null,
          contains_sensitive_data: false,
        },
        risk_hints: payload.risk_hints ?? {
          side_effect_level: "unknown",
          external_effects: [],
          reversibility_hint: "reversible",
          sensitivity_hint: "normal",
          batch: false,
        },
        facets: {},
        normalization: payload.normalization ?? {
          mapper: "fallback",
          inferred_fields: [],
          warnings: [],
          normalization_confidence: 0.5,
        },
        confidence_assessment: payload.confidence_assessment ?? {
          engine_version: "fallback",
          score: typeof payload.confidence_score === "number" ? payload.confidence_score : 0.5,
          band: "guarded",
          requires_human_review: false,
          factors: [],
        },
      })
    : null;
}

export async function getActionDetail(
  owner: string,
  name: string,
  runId: string,
  actionId: string,
  workspaceId?: string,
) {
  const repository = findRepositoryRuntimeRecord(owner, name, workspaceId);
  if (!repository) {
    return null;
  }

  const journal = new RunJournal({ dbPath: getRepositoryJournalPath(repository.metadata.root) });
  try {
    const run = journal.getRunSummary(runId);
    if (!run) {
      return null;
    }

    const events = journal.listRunEvents(runId);
    const normalizedEvent =
      events.find((event) => event.event_type === "action.normalized" && eventActionId(event.payload) === actionId) ?? null;
    if (!normalizedEvent) {
      return null;
    }

    const policyEvent =
      events.find((event) => event.event_type === "policy.evaluated" && eventActionId(event.payload) === actionId) ?? null;
    const executionEvent =
      [...events]
        .reverse()
        .find(
          (event) =>
            (event.event_type === "execution.completed" ||
              event.event_type === "execution.failed" ||
              event.event_type === "execution.outcome_unknown") &&
            eventActionId(event.payload) === actionId,
        ) ?? null;
    const snapshotEvent =
      events.find((event) => event.event_type === "snapshot.created" && eventActionId(event.payload) === actionId) ?? null;

    const action = extractActionRecord(normalizedEvent.payload ?? {}, runId, actionId);
    if (!action) {
      return null;
    }

    let timeline: QueryTimelineResponsePayload | null = null;
    let stepDetails: QueryHelperResponsePayload | null = null;
    let policyExplanation: QueryHelperResponsePayload | null = null;
    try {
      if (workspaceId) {
        timeline = await withWorkspaceAuthorityClient(workspaceId, (client) => client.queryTimeline(runId, "internal"));
        const step = timeline.steps.find((candidate) => candidate.action_id === actionId);
        if (step) {
          stepDetails = await withWorkspaceAuthorityClient(workspaceId, (client) =>
            client.queryHelper(runId, "step_details", step.step_id, undefined, "internal"),
          );
          policyExplanation = await withWorkspaceAuthorityClient(workspaceId, (client) =>
            client.queryHelper(runId, "explain_policy_decision", step.step_id, undefined, "internal"),
          );
        }
      }
    } catch {
      // Fallback to journal-only detail when the authority daemon is unavailable.
    }

    const timelineStep = timeline?.steps.find((step) => step.action_id === actionId) ?? null;
    const policyPayload = policyEvent?.payload ?? {};

    return ActionDetailSchema.parse({
      id: `${runId}:${actionId}`,
      runId,
      actionId,
      repo: repoLabel(owner, name),
      workflowName: run.workflow_name,
      occurredAt: normalizedEvent.occurred_at,
      normalizedAction: {
        domain: action.operation.domain,
        kind: action.operation.kind,
        name: action.operation.name,
        displayName: action.operation.display_name ?? action.operation.name,
        targetLocator: action.target.primary.locator,
        targetLabel: action.target.primary.label ?? null,
        executionSurface: action.execution_path.surface,
        executionMode: action.execution_path.mode,
        confidenceScore: action.confidence_assessment.score,
        confidenceBand: action.confidence_assessment.band,
        sideEffectLevel: action.risk_hints.side_effect_level,
        reversibilityHint: action.risk_hints.reversibility_hint,
        externalEffects: action.risk_hints.external_effects,
        warnings: action.normalization.warnings,
        rawInput: action.input.raw,
        redactedInput: action.input.redacted,
      },
      policyOutcome: {
        decision: typeof policyPayload.decision === "string" ? policyPayload.decision : timelineStep?.decision ?? null,
        reasons: Array.isArray(policyPayload.reasons) ? policyPayload.reasons : [],
        snapshotRequired: policyPayload.snapshot_required === true,
        approvalRequired: policyPayload.approval_required === true,
        budgetCheck:
          typeof policyPayload.budget_check === "string"
            ? policyPayload.budget_check
            : typeof policyPayload.budget_effects === "object" &&
                policyPayload.budget_effects !== null &&
                "budget_check" in policyPayload.budget_effects &&
                typeof (policyPayload.budget_effects as { budget_check?: unknown }).budget_check === "string"
              ? ((policyPayload.budget_effects as { budget_check: string }).budget_check)
              : "unknown",
        matchedRules: Array.isArray(policyPayload.matched_rules)
          ? policyPayload.matched_rules.filter((value): value is string => typeof value === "string")
          : [],
      },
      execution: {
        stepId: timelineStep?.step_id ?? null,
        status:
          timelineStep?.status ??
          (executionEvent?.event_type === "execution.completed"
            ? "completed"
            : executionEvent?.event_type === "execution.failed"
              ? "failed"
              : "partial"),
        stepType: timelineStep?.step_type ?? "action_step",
        summary: timelineStep?.summary ?? `Governed action ${action.operation.name} was recorded in the run journal.`,
        snapshotId:
          timelineStep?.related.snapshot_id ??
          (typeof snapshotEvent?.payload?.snapshot_id === "string" ? snapshotEvent.payload.snapshot_id : null),
        artifactLabels: timelineStep?.primary_artifacts.map((artifact) => artifact.label ?? artifact.type) ?? [],
        helperSummary: stepDetails?.answer ?? null,
        policyExplanation: policyExplanation?.answer ?? null,
        laterActionsAffected: timelineStep?.related.later_actions_affected ?? 0,
        overlappingPaths: timelineStep?.related.overlapping_paths ?? [],
      },
    });
  } finally {
    journal.close();
  }
}
