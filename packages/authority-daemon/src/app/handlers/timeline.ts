import type { RequestContext } from "@agentgit/core-ports";
import type { RunJournal } from "@agentgit/run-journal";
import { answerHelperQuery, projectTimelineView } from "@agentgit/timeline-helper";
import {
  type ApprovalInboxItem,
  type HelperQuestionType,
  NotFoundError,
  QueryArtifactRequestPayloadSchema,
  type QueryArtifactResponsePayload,
  QueryHelperRequestPayloadSchema,
  type QueryHelperResponsePayload,
  QueryTimelineRequestPayloadSchema,
  type QueryTimelineResponsePayload,
  type RequestEnvelope,
  type ResponseEnvelope,
  type TimelineStep,
  type VisibilityScope,
  validate,
} from "@agentgit/schemas";

import { requireAuthorizedRunSummary, requireValidSession, sessionCanAccessRun } from "../authorization.js";
import { makeSuccessResponse } from "../response-helpers.js";
import type { AuthorityState } from "../../state.js";

const MAX_ARTIFACT_RESPONSE_CHARS = 8_192;

interface HelperProjectionContext {
  visibility_scope: VisibilityScope;
  redactions_applied: number;
  preview_budget: QueryHelperResponsePayload["preview_budget"];
  steps: TimelineStep[];
  unavailable_artifacts_present: boolean;
  artifact_state_digest: string;
}

function enrichTimelineArtifactHealth(journal: RunJournal, steps: TimelineStep[]): TimelineStep[] {
  return steps.map((step) => {
    const primaryArtifacts = step.primary_artifacts.map((artifact) => {
      if (!artifact.artifact_id) {
        return artifact;
      }

      try {
        const storedArtifact = journal.getArtifact(artifact.artifact_id);
        return {
          ...artifact,
          artifact_status: storedArtifact.artifact_status,
          integrity: storedArtifact.integrity,
        };
      } catch (error) {
        if (error instanceof NotFoundError) {
          return {
            ...artifact,
            artifact_status: "missing" as const,
          };
        }

        throw error;
      }
    });

    const availabilityWarnings = primaryArtifacts
      .filter(
        (artifact) => artifact.artifact_id && artifact.artifact_status && artifact.artifact_status !== "available",
      )
      .map((artifact) =>
        artifact.artifact_status === "expired"
          ? `Artifact ${artifact.artifact_id} expired under the configured retention policy and is no longer available.`
          : artifact.artifact_status === "tampered"
            ? `Artifact ${artifact.artifact_id} failed content integrity verification and may have been tampered with.`
            : artifact.artifact_status === "corrupted"
              ? `Artifact ${artifact.artifact_id} is corrupted in durable storage and can no longer be read safely.`
              : `Artifact ${artifact.artifact_id} is missing from durable storage.`,
      );

    return {
      ...step,
      primary_artifacts: primaryArtifacts,
      warnings: [...(step.warnings ?? []), ...availabilityWarnings],
    };
  });
}

function latestRunSequence(runSummary: ReturnType<RunJournal["getRunSummary"]>): number {
  return runSummary?.latest_event?.sequence ?? 0;
}

function buildHelperProjectionContext(
  journal: RunJournal,
  runId: string,
  visibilityScope: VisibilityScope,
  artifactStateDigest?: string,
): HelperProjectionContext {
  const events = journal.listRunEvents(runId);
  const projection = projectTimelineView(runId, events, visibilityScope);
  const steps = enrichTimelineArtifactHealth(journal, projection.steps);

  return {
    visibility_scope: projection.visibility_scope,
    redactions_applied: projection.redactions_applied,
    preview_budget: projection.preview_budget,
    steps,
    unavailable_artifacts_present: steps.some((step) =>
      step.primary_artifacts.some((artifact) => artifact.artifact_status && artifact.artifact_status !== "available"),
    ),
    artifact_state_digest: artifactStateDigest ?? journal.getRunArtifactStateDigest(runId),
  };
}

function buildHelperResponseFromContext(
  questionType: HelperQuestionType,
  context: HelperProjectionContext,
  focusStepId?: string,
  compareStepId?: string,
): QueryHelperResponsePayload {
  const answer = answerHelperQuery(questionType, context.steps, focusStepId, compareStepId);

  return {
    ...answer,
    visibility_scope: context.visibility_scope,
    redactions_applied: context.redactions_applied,
    preview_budget: context.preview_budget,
    uncertainty: [
      ...answer.uncertainty,
      ...(context.redactions_applied > 0
        ? [`Some details were redacted for ${context.visibility_scope} visibility.`]
        : []),
      ...(context.preview_budget.truncated_previews > 0 || context.preview_budget.omitted_previews > 0
        ? [
            `Some inline previews were truncated or omitted to stay within the response preview budget (${context.preview_budget.preview_chars_used}/${context.preview_budget.max_total_inline_preview_chars} chars used).`,
          ]
        : []),
      ...(context.unavailable_artifacts_present
        ? [
            "Some referenced artifacts are no longer available in durable storage because they expired, failed integrity verification, became corrupted, or went missing, so parts of the supporting evidence may be unavailable.",
          ]
        : []),
    ],
  };
}

function clipArtifactContent(value: string): {
  content: string;
  content_truncated: boolean;
  returned_chars: number;
  max_inline_chars: number;
} {
  if (value.length <= MAX_ARTIFACT_RESPONSE_CHARS) {
    return {
      content: value,
      content_truncated: false,
      returned_chars: value.length,
      max_inline_chars: MAX_ARTIFACT_RESPONSE_CHARS,
    };
  }

  const content = `${value.slice(0, MAX_ARTIFACT_RESPONSE_CHARS - 1)}…`;
  return {
    content,
    content_truncated: true,
    returned_chars: content.length,
    max_inline_chars: MAX_ARTIFACT_RESPONSE_CHARS,
  };
}

export function handleQueryTimeline(
  state: AuthorityState,
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): ResponseEnvelope<QueryTimelineResponsePayload> {
  const sessionId = requireValidSession(state, "query_timeline", request.session_id);
  const payload = validate(QueryTimelineRequestPayloadSchema, request.payload);
  const runSummary = requireAuthorizedRunSummary(state, journal, sessionId, payload.run_id);

  journal.enforceArtifactRetention();
  const events = journal.listRunEvents(payload.run_id);
  const projection = projectTimelineView(payload.run_id, events, payload.visibility_scope ?? "user");
  const steps = enrichTimelineArtifactHealth(journal, projection.steps);

  return makeSuccessResponse(request.request_id, request.session_id, {
    run_summary: runSummary,
    steps,
    projection_status: "fresh",
    visibility_scope: projection.visibility_scope,
    redactions_applied: projection.redactions_applied,
    preview_budget: projection.preview_budget,
  });
}

export function handleQueryHelper(
  state: AuthorityState,
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): ResponseEnvelope<QueryHelperResponsePayload> {
  const sessionId = requireValidSession(state, "query_helper", request.session_id);
  const payload = validate(QueryHelperRequestPayloadSchema, request.payload);
  const runSummary = requireAuthorizedRunSummary(state, journal, sessionId, payload.run_id);

  journal.enforceArtifactRetention();
  const visibilityScope = payload.visibility_scope ?? "user";
  const artifactStateDigest = journal.getRunArtifactStateDigest(payload.run_id);
  const cached = journal.getHelperFactCache({
    run_id: payload.run_id,
    question_type: payload.question_type,
    focus_step_id: payload.focus_step_id,
    compare_step_id: payload.compare_step_id,
    visibility_scope: visibilityScope,
  });
  const currentEventCount = runSummary.event_count;
  const currentLatestSequence = latestRunSequence(runSummary);

  if (
    cached &&
    cached.event_count === currentEventCount &&
    cached.latest_sequence === currentLatestSequence &&
    cached.artifact_state_digest === artifactStateDigest
  ) {
    return makeSuccessResponse(request.request_id, request.session_id, cached.response);
  }

  const context = buildHelperProjectionContext(journal, payload.run_id, visibilityScope, artifactStateDigest);
  const response = buildHelperResponseFromContext(
    payload.question_type,
    context,
    payload.focus_step_id,
    payload.compare_step_id,
  );
  journal.storeHelperFactCache({
    run_id: payload.run_id,
    question_type: payload.question_type,
    focus_step_id: payload.focus_step_id ?? null,
    compare_step_id: payload.compare_step_id ?? null,
    visibility_scope: visibilityScope,
    event_count: currentEventCount,
    latest_sequence: currentLatestSequence,
    artifact_state_digest: artifactStateDigest,
    response,
    warmed_at: new Date().toISOString(),
  });

  return makeSuccessResponse(request.request_id, request.session_id, response);
}

export function handleQueryArtifact(
  state: AuthorityState,
  journal: RunJournal,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): ResponseEnvelope<QueryArtifactResponsePayload> {
  const sessionId = requireValidSession(state, "query_artifact", request.session_id);
  const payload = validate(QueryArtifactRequestPayloadSchema, request.payload);
  const visibilityScope = payload.visibility_scope ?? "user";
  journal.enforceArtifactRetention();
  const artifact = journal.getArtifact(payload.artifact_id);
  requireAuthorizedRunSummary(state, journal, sessionId, artifact.run_id);

  const visibilityRank = (scope: QueryArtifactResponsePayload["visibility_scope"]): number => {
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
  };

  if (visibilityRank(visibilityScope) < visibilityRank(artifact.visibility)) {
    throw new NotFoundError(`No artifact found for ${payload.artifact_id}.`, {
      artifact_id: payload.artifact_id,
    });
  }

  const content =
    artifact.content === null
      ? {
          content: "",
          content_truncated: false,
          returned_chars: 0,
          max_inline_chars: MAX_ARTIFACT_RESPONSE_CHARS,
        }
      : payload.full_content
        ? {
            content: artifact.content,
            content_truncated: false,
            returned_chars: artifact.content.length,
            max_inline_chars: MAX_ARTIFACT_RESPONSE_CHARS,
          }
        : clipArtifactContent(artifact.content);
  return makeSuccessResponse(request.request_id, request.session_id, {
    artifact: {
      artifact_id: artifact.artifact_id,
      run_id: artifact.run_id,
      action_id: artifact.action_id,
      execution_id: artifact.execution_id,
      type: artifact.type,
      content_ref: artifact.content_ref,
      byte_size: artifact.byte_size,
      integrity: artifact.integrity,
      visibility: artifact.visibility,
      expires_at: artifact.expires_at,
      expired_at: artifact.expired_at,
      created_at: artifact.created_at,
    },
    artifact_status: artifact.artifact_status,
    visibility_scope: visibilityScope,
    content_available: artifact.content !== null,
    content: content.content,
    content_truncated: content.content_truncated,
    returned_chars: content.returned_chars,
    max_inline_chars: content.max_inline_chars,
  });
}
