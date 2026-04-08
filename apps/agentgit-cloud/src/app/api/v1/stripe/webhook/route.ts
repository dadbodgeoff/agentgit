import { handleWorkspaceStripeWebhook } from "@/lib/backend/workspace/workspace-billing";
import { WorkspaceStripeError } from "@/lib/backend/workspace/stripe-billing";
import { createRequestId, jsonWithRequestId } from "@/lib/observability/route-response";

export async function POST(request: Request) {
  const requestId = createRequestId(request);
  const signature = request.headers.get("stripe-signature");

  if (!signature) {
    return jsonWithRequestId({ message: "Stripe signature header is required." }, { status: 400 }, requestId);
  }

  const body = await request.text();

  try {
    await handleWorkspaceStripeWebhook(body, signature);
    return jsonWithRequestId({ received: true }, undefined, requestId);
  } catch (error) {
    if (error instanceof WorkspaceStripeError) {
      return jsonWithRequestId({ message: error.message }, { status: error.statusCode }, requestId);
    }

    throw error;
  }
}
