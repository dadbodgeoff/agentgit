import {
  BillingSaveResponseSchema,
  WorkspaceBillingSchema,
  type BillingPlanTier,
  type BillingUpdate,
  type BillingSaveResponse,
  type WorkspaceBilling,
} from "@/schemas/cloud";

const baseInvoices = [
  {
    id: "inv_2026_03",
    periodLabel: "Mar 2026",
    amountUsd: 1490,
    status: "paid",
    issuedAt: "2026-03-01T12:00:00Z",
  },
  {
    id: "inv_2026_04",
    periodLabel: "Apr 2026",
    amountUsd: 1490,
    status: "open",
    issuedAt: "2026-04-01T12:00:00Z",
    dueAt: "2026-04-15T12:00:00Z",
  },
  {
    id: "inv_2026_02",
    periodLabel: "Feb 2026",
    amountUsd: 1490,
    status: "paid",
    issuedAt: "2026-02-01T12:00:00Z",
  },
] as const;

const billingFixture = WorkspaceBillingSchema.parse({
  workspaceId: "ws_acme_01",
  workspaceName: "Acme platform",
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
  paymentMethodLabel: "Visa ending in 4242",
  paymentMethodStatus: "active",
  invoices: baseInvoices,
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
    message: "Billing settings saved. External processor sync is still mocked.",
  });
}
