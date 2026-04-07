import type { RequestEnvelope } from "@agentgit/schemas";

export function canUseIdempotency(
  request: RequestEnvelope<unknown>,
  idempotentMutationMethods: ReadonlySet<string>,
): boolean {
  return (
    idempotentMutationMethods.has(request.method) &&
    typeof request.idempotency_key === "string" &&
    request.idempotency_key.length > 0
  );
}
