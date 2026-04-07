import {
  API_VERSION,
  AgentGitError,
  type ErrorEnvelope,
  InternalError,
  type ResponseEnvelope,
  ValidationError,
} from "@agentgit/schemas";

export function makeSuccessResponse<TResult>(
  requestId: string,
  sessionId: string | undefined,
  result: TResult,
): ResponseEnvelope<TResult> {
  return {
    api_version: API_VERSION,
    request_id: requestId,
    session_id: sessionId,
    ok: true,
    result,
    error: null,
  };
}

export function toErrorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof AgentGitError) {
    return {
      ...error.toErrorEnvelope(),
      error_class: error instanceof ValidationError ? "validation_error" : error.name,
    };
  }

  const internalError = new InternalError("Unhandled daemon error.", {
    cause: error instanceof Error ? error.message : String(error),
  });

  return internalError.toErrorEnvelope();
}

export function makeErrorResponse(
  requestId: string,
  sessionId: string | undefined,
  error: unknown,
): ResponseEnvelope<never> {
  return {
    api_version: API_VERSION,
    request_id: requestId,
    session_id: sessionId,
    ok: false,
    result: null,
    error: toErrorEnvelope(error),
  };
}

export function replayStoredSuccessResponse(
  requestId: string,
  sessionId: string | undefined,
  response: ResponseEnvelope<unknown>,
): ResponseEnvelope<unknown> {
  return {
    ...response,
    request_id: requestId,
    session_id: sessionId ?? response.session_id,
  };
}
