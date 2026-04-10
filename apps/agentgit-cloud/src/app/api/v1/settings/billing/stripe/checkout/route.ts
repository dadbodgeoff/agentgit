import { requireApiRole } from "@/lib/auth/api-session";
import { createWorkspaceStripeCheckout, WorkspaceBillingLimitError } from "@/lib/backend/workspace/workspace-billing";
import { resolveCanonicalAppOrigin } from "@/lib/http/origin";
import { WorkspaceStripeError } from "@/lib/backend/workspace/stripe-billing";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";

export async function POST(request: Request) {
  const requestId = createRequestId(request);
  const access = await requireApiRole("owner", request);

  if (access.denied) {
    return access.denied;
  }

  try {
    return jsonWithRequestId(
      await createWorkspaceStripeCheckout(access.workspaceSession, resolveCanonicalAppOrigin()),
      undefined,
      requestId,
    );
  } catch (error) {
    if (error instanceof WorkspaceStripeError) {
      return jsonWithRequestId({ message: error.message }, { status: error.statusCode }, requestId);
    }

    if (error instanceof WorkspaceBillingLimitError) {
      return jsonWithRequestId({ message: error.message, breaches: error.breaches }, { status: 409 }, requestId);
    }

    throw error;
  }
}
