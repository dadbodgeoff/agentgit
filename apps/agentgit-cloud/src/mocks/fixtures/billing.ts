import {
  BillingSaveResponseSchema,
  WorkspaceBillingSchema,
  type BillingPlanTier,
  type BillingUpdate,
  type BillingSaveResponse,
  type WorkspaceBilling,
} from "@/schemas/cloud";

const billingFixture = WorkspaceBillingSchema.parse({
  workspaceId: "ws_acme_01",
  workspaceName: "Acme platform",
  billingProvider: "beta_gate",
  billingAccessStatus: "active",
  limitBreaches: [],
  planTier: "team",
  billingCycle: "yearly",
  billingEmail: "finance@acme.dev",
  invoiceEmail: "ap@acme.dev",
  taxId: "US-ACME-42",
  seatsIncluded: 15,
  seatsUsed: 11,
  repositoriesIncluded: 40,
  repositoriesConnected: 12,
  approvalsIncluded: 5000,
  approvalsUsed: 1822,
  monthlyEstimateUsd: 1490,
  nextInvoiceDate: "2026-05-01T12:00:00Z",
  paymentMethodLabel: "Beta access granted",
  paymentMethodStatus: "active",
  invoices: [],
});

function getPlanLimits(planTier: BillingPlanTier) {
  if (planTier === "starter") {
    return {
      seatsIncluded: 5,
      repositoriesIncluded: 10,
      approvalsIncluded: 1000,
      monthlyEstimateUsd: 199,
    };
  }

  if (planTier === "enterprise") {
    return {
      seatsIncluded: 50,
      repositoriesIncluded: 150,
      approvalsIncluded: 20000,
      monthlyEstimateUsd: 4990,
    };
  }

  return {
    seatsIncluded: 15,
    repositoriesIncluded: 40,
    approvalsIncluded: 5000,
    monthlyEstimateUsd: 1490,
  };
}

export function getWorkspaceBillingFixture(): WorkspaceBilling {
  return billingFixture;
}

export function saveWorkspaceBillingFixture(update: BillingUpdate): BillingSaveResponse {
  const planLimits = getPlanLimits(update.planTier);
  const billing = WorkspaceBillingSchema.parse({
    ...billingFixture,
    ...update,
    taxId: update.taxId || undefined,
    ...planLimits,
    monthlyEstimateUsd: update.billingCycle === "yearly" ? Math.round(planLimits.monthlyEstimateUsd * 0.85) : planLimits.monthlyEstimateUsd,
  });

  return BillingSaveResponseSchema.parse({
    billing,
    savedAt: "2026-04-07T16:22:00Z",
    message: "Billing settings saved. Hosted beta access now enforces the selected plan limits.",
  });
}
