import "server-only";

import type {
  BillingPlanTier,
  BillingUpdate,
  WorkspaceBilling,
  WorkspaceSession,
} from "@/schemas/cloud";

import { getStoredWorkspaceBilling, getWorkspaceConnectionState, saveStoredWorkspaceBilling } from "@/lib/backend/workspace/cloud-state";
import { collectWorkspaceRepositoryRuntimeRecords } from "@/lib/backend/workspace/repository-inventory";

const DEFAULT_PAYMENT_METHOD_LABEL = "Visa ending in 4242";
const DEFAULT_PAYMENT_METHOD_STATUS = "active" as const;
const DEFAULT_INVOICES = [
  {
    id: "inv_2026_03",
    periodLabel: "Mar 2026",
    amountUsd: 1490,
    status: "paid" as const,
    issuedAt: "2026-03-01T12:00:00Z",
  },
  {
    id: "inv_2026_04",
    periodLabel: "Apr 2026",
    amountUsd: 1490,
    status: "open" as const,
    issuedAt: "2026-04-01T12:00:00Z",
    dueAt: "2026-04-15T12:00:00Z",
  },
  {
    id: "inv_2026_02",
    periodLabel: "Feb 2026",
    amountUsd: 1490,
    status: "paid" as const,
    issuedAt: "2026-02-01T12:00:00Z",
  },
];

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

function getNextInvoiceDate(): string {
  return "2026-05-01T12:00:00Z";
}

function deriveApprovalsUsed(workspaceId: string): number {
  return collectWorkspaceRepositoryRuntimeRecords(workspaceId).reduce(
    (total, record) => total + record.pendingApprovalCount,
    0,
  );
}

function deriveSeatsUsed(workspaceId: string): number {
  const workspaceState = getWorkspaceConnectionState(workspaceId);
  return 1 + (workspaceState?.invites.length ?? 0);
}

function deriveUsageSnapshot(workspaceId: string) {
  const repositoriesConnected = collectWorkspaceRepositoryRuntimeRecords(workspaceId).length;
  const seatsUsed = deriveSeatsUsed(workspaceId);
  const approvalsUsed = deriveApprovalsUsed(workspaceId);

  return {
    repositoriesConnected,
    seatsUsed,
    approvalsUsed,
  };
}

function mergeDerivedUsage(workspaceId: string, billing: WorkspaceBilling): WorkspaceBilling {
  const usage = deriveUsageSnapshot(workspaceId);

  return {
    ...billing,
    repositoriesConnected: usage.repositoriesConnected,
    seatsUsed: usage.seatsUsed,
    approvalsUsed: usage.approvalsUsed,
  };
}

export function resolveWorkspaceBilling(workspaceSession: WorkspaceSession): WorkspaceBilling {
  const storedBilling = getStoredWorkspaceBilling(workspaceSession.activeWorkspace.id);
  if (storedBilling) {
    return mergeDerivedUsage(workspaceSession.activeWorkspace.id, {
      ...storedBilling,
      workspaceName: workspaceSession.activeWorkspace.name,
    });
  }

  const planLimits = getPlanLimits("team");
  return mergeDerivedUsage(workspaceSession.activeWorkspace.id, {
    workspaceId: workspaceSession.activeWorkspace.id,
    workspaceName: workspaceSession.activeWorkspace.name,
    planTier: "team",
    billingCycle: "yearly",
    billingEmail: "finance@acme.dev",
    invoiceEmail: "ap@acme.dev",
    taxId: "US-ACME-42",
    seatsIncluded: planLimits.seatsIncluded,
    seatsUsed: 1,
    repositoriesIncluded: planLimits.repositoriesIncluded,
    repositoriesConnected: 0,
    approvalsIncluded: planLimits.approvalsIncluded,
    approvalsUsed: 0,
    monthlyEstimateUsd: Math.round(planLimits.monthlyEstimateUsd * 0.85),
    nextInvoiceDate: getNextInvoiceDate(),
    paymentMethodLabel: DEFAULT_PAYMENT_METHOD_LABEL,
    paymentMethodStatus: DEFAULT_PAYMENT_METHOD_STATUS,
    invoices: DEFAULT_INVOICES,
  });
}

export function saveWorkspaceBilling(workspaceSession: WorkspaceSession, update: BillingUpdate) {
  const currentBilling = resolveWorkspaceBilling(workspaceSession);
  const planLimits = getPlanLimits(update.planTier);

  const savedBilling = saveStoredWorkspaceBilling(workspaceSession.activeWorkspace.id, {
    ...currentBilling,
    workspaceId: workspaceSession.activeWorkspace.id,
    workspaceName: workspaceSession.activeWorkspace.name,
    ...update,
    taxId: update.taxId || undefined,
    ...planLimits,
    monthlyEstimateUsd:
      update.billingCycle === "yearly"
        ? Math.round(planLimits.monthlyEstimateUsd * 0.85)
        : planLimits.monthlyEstimateUsd,
    nextInvoiceDate: currentBilling.nextInvoiceDate,
    paymentMethodLabel: currentBilling.paymentMethodLabel || DEFAULT_PAYMENT_METHOD_LABEL,
    paymentMethodStatus: currentBilling.paymentMethodStatus || DEFAULT_PAYMENT_METHOD_STATUS,
    invoices: currentBilling.invoices.length > 0 ? currentBilling.invoices : DEFAULT_INVOICES,
  });

  return {
    billing: mergeDerivedUsage(workspaceSession.activeWorkspace.id, savedBilling),
    savedAt: new Date().toISOString(),
    message: "Billing settings saved.",
  };
}
