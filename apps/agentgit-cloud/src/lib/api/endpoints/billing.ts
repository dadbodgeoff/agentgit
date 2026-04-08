import { fetchJson } from "@/lib/api/client";
import {
  BillingSaveResponseSchema,
  BillingUpdateSchema,
  StripeBillingSessionResponseSchema,
  StripeBillingStatusSchema,
  WorkspaceBillingSchema,
  type BillingSaveResponse,
  type BillingUpdate,
  type StripeBillingSessionResponse,
  type StripeBillingStatus,
  type WorkspaceBilling,
} from "@/schemas/cloud";

export async function getWorkspaceBilling(): Promise<WorkspaceBilling> {
  const response = await fetchJson<unknown>("/api/v1/settings/billing");
  return WorkspaceBillingSchema.parse(response);
}

export async function updateWorkspaceBilling(values: BillingUpdate): Promise<BillingSaveResponse> {
  const response = await fetchJson<unknown>("/api/v1/settings/billing", {
    method: "PUT",
    body: JSON.stringify(BillingUpdateSchema.parse(values)),
  });

  return BillingSaveResponseSchema.parse(response);
}

export async function getWorkspaceStripeBillingStatus(): Promise<StripeBillingStatus> {
  const response = await fetchJson<unknown>("/api/v1/settings/billing/stripe");
  return StripeBillingStatusSchema.parse(response);
}

export async function createWorkspaceStripeCheckoutSession(): Promise<StripeBillingSessionResponse> {
  const response = await fetchJson<unknown>("/api/v1/settings/billing/stripe/checkout", {
    method: "POST",
    body: JSON.stringify({}),
  });

  return StripeBillingSessionResponseSchema.parse(response);
}

export async function createWorkspaceStripePortalSession(): Promise<StripeBillingSessionResponse> {
  const response = await fetchJson<unknown>("/api/v1/settings/billing/stripe/portal", {
    method: "POST",
    body: JSON.stringify({}),
  });

  return StripeBillingSessionResponseSchema.parse(response);
}
