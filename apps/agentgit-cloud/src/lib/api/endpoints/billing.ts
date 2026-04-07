import { fetchJson } from "@/lib/api/client";
import {
  BillingSaveResponseSchema,
  BillingUpdateSchema,
  WorkspaceBillingSchema,
  type BillingSaveResponse,
  type BillingUpdate,
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
