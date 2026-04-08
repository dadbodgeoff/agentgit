import { fetchJson } from "@/lib/api/client";
import {
  BillingSaveResponseSchema,
  BillingUpdateSchema,
  StripeBillingSessionResponseSchema,
  StripeBillingStatusSchema,
  WorkspaceBillingApiSchema,
  type BillingSaveResponse,
  type BillingUpdate,
  type StripeBillingSessionResponse,
  type StripeBillingStatus,
  type WorkspaceBillingApi,
} from "@/schemas/cloud";

export async function getWorkspaceBilling(): Promise<WorkspaceBillingApi> {
  const response = await fetchJson<unknown>("/api/v1/settings/billing");
  return WorkspaceBillingApiSchema.parse(response);
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
