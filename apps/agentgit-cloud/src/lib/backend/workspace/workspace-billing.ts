import "server-only";

import type {
  BillingLimitBreach,
  BillingPlanTier,
  BillingUpdate,
  WorkspaceBilling,
  WorkspaceSession,
} from "@/schemas/cloud";

import { withControlPlaneState } from "@/lib/backend/control-plane/state";
import {
  getStoredWorkspaceBilling,
  getWorkspaceConnectionState,
  listStoredWorkspaceBillings,
  saveStoredWorkspaceBilling,
} from "@/lib/backend/workspace/cloud-state";
import {
  constructStripeWebhookEvent,
  createWorkspaceStripeCheckoutSession,
  createWorkspaceStripePortalSession,
  getWorkspaceStripeStatus,
  syncWorkspaceBillingFromStripe,
} from "@/lib/backend/workspace/stripe-billing";

const DEFAULT_PAYMENT_METHOD_LABEL = "Beta access granted";
const DEFAULT_PAYMENT_METHOD_STATUS = "active" as const;
const DEFAULT_INVOICES: WorkspaceBilling["invoices"] = [];
const APPROVAL_USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

type WorkspaceUsageSnapshot = {
  repositoriesConnected: number;
  seatsUsed: number;
  approvalsUsed: number;
};

type BillingLimitSnapshot = Pick<WorkspaceBilling, "seatsIncluded" | "repositoriesIncluded" | "approvalsIncluded">;

export class WorkspaceBillingLimitError extends Error {
  constructor(
    public readonly breaches: BillingLimitBreach[],
    message: string,
  ) {
    super(message);
    this.name = "WorkspaceBillingLimitError";
  }
}

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
  return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
}

function deriveApprovalsUsed(workspaceId: string): number {
  const windowStartMs = Date.now() - APPROVAL_USAGE_WINDOW_MS;
  return withControlPlaneState(
    (store) =>
      store
        .listEvents()
        .filter(
          (record) =>
            record.event.workspaceId === workspaceId &&
            record.event.type === "approval.requested" &&
            new Date(record.event.occurredAt).getTime() >= windowStartMs,
        ).length,
  );
}

async function deriveSeatsUsed(workspaceId: string): Promise<number> {
  const workspaceState = await getWorkspaceConnectionState(workspaceId);
  if (!workspaceState) {
    return 1;
  }

  return Math.max(workspaceState.members.length, 1) + workspaceState.invites.length;
}

async function deriveUsageSnapshot(workspaceId: string) {
  const workspaceState = await getWorkspaceConnectionState(workspaceId);
  const repositoriesConnected = workspaceState?.repositoryIds.length ?? 0;
  const seatsUsed = await deriveSeatsUsed(workspaceId);
  const approvalsUsed = deriveApprovalsUsed(workspaceId);

  return {
    repositoriesConnected,
    seatsUsed,
    approvalsUsed,
  };
}

function getBillingLimitBreaches(limits: BillingLimitSnapshot, usage: WorkspaceUsageSnapshot): BillingLimitBreach[] {
  const breaches: BillingLimitBreach[] = [];

  if (usage.seatsUsed > limits.seatsIncluded) {
    breaches.push("seats");
  }

  if (usage.repositoriesConnected > limits.repositoriesIncluded) {
    breaches.push("repositories");
  }

  if (usage.approvalsUsed > limits.approvalsIncluded) {
    breaches.push("approvals");
  }

  return breaches;
}

function describeLimitBreaches(
  breaches: BillingLimitBreach[],
  limits: BillingLimitSnapshot,
  usage: WorkspaceUsageSnapshot,
): string {
  const parts = breaches.map((breach) => {
    if (breach === "seats") {
      return `${usage.seatsUsed}/${limits.seatsIncluded} seats`;
    }

    if (breach === "repositories") {
      return `${usage.repositoriesConnected}/${limits.repositoriesIncluded} repositories`;
    }

    return `${usage.approvalsUsed}/${limits.approvalsIncluded} approvals`;
  });

  return `Workspace usage exceeds the selected beta plan limits for ${parts.join(", ")}. Upgrade the plan or reduce usage.`;
}

async function mergeDerivedUsage(
  workspaceId: string,
  billing: WorkspaceBilling,
  overrides?: Partial<WorkspaceUsageSnapshot>,
): Promise<WorkspaceBilling> {
  const usage = {
    ...(await deriveUsageSnapshot(workspaceId)),
    ...overrides,
  };
  const limitBreaches = getBillingLimitBreaches(billing, usage);

  return {
    ...billing,
    billingProvider: billing.billingProvider ?? "beta_gate",
    billingAccessStatus: limitBreaches.length > 0 ? "over_limit" : "active",
    limitBreaches,
    repositoriesConnected: usage.repositoriesConnected,
    seatsUsed: usage.seatsUsed,
    approvalsUsed: usage.approvalsUsed,
    paymentMethodLabel:
      billing.billingProvider === "stripe" ? billing.paymentMethodLabel : DEFAULT_PAYMENT_METHOD_LABEL,
    paymentMethodStatus:
      billing.billingProvider === "stripe"
        ? billing.paymentMethodStatus
        : limitBreaches.length > 0
          ? "update_required"
          : DEFAULT_PAYMENT_METHOD_STATUS,
    invoices: billing.billingProvider === "stripe" ? billing.invoices : DEFAULT_INVOICES,
  };
}

async function getWorkspaceUsageSnapshotWithOverrides(
  workspaceId: string,
  overrides?: Partial<WorkspaceUsageSnapshot>,
): Promise<WorkspaceUsageSnapshot> {
  return {
    ...(await deriveUsageSnapshot(workspaceId)),
    ...overrides,
  };
}

async function assertUsageFitsPlan(params: {
  workspaceId: string;
  planTier: BillingPlanTier;
  usageOverrides?: Partial<WorkspaceUsageSnapshot>;
  dimensions?: BillingLimitBreach[];
}) {
  const usage = await getWorkspaceUsageSnapshotWithOverrides(params.workspaceId, params.usageOverrides);
  const limits = getPlanLimits(params.planTier);
  const breaches = getBillingLimitBreaches(limits, usage).filter((breach) =>
    params.dimensions ? params.dimensions.includes(breach) : true,
  );

  if (breaches.length > 0) {
    throw new WorkspaceBillingLimitError(breaches, describeLimitBreaches(breaches, limits, usage));
  }
}

export async function assertWorkspaceUsageWithinBillingLimits(
  workspaceSession: WorkspaceSession,
  params?: {
    usageOverrides?: Partial<WorkspaceUsageSnapshot>;
    dimensions?: BillingLimitBreach[];
  },
): Promise<void> {
  const billing = await resolveWorkspaceBilling(workspaceSession);
  await assertUsageFitsPlan({
    workspaceId: workspaceSession.activeWorkspace.id,
    planTier: billing.planTier,
    usageOverrides: params?.usageOverrides,
    dimensions: params?.dimensions,
  });
}

export async function resolveWorkspaceBilling(workspaceSession: WorkspaceSession): Promise<WorkspaceBilling> {
  const storedBilling = await getStoredWorkspaceBilling(workspaceSession.activeWorkspace.id);
  if (storedBilling) {
    const hydratedBilling = {
      ...storedBilling,
      workspaceName: workspaceSession.activeWorkspace.name,
      billingProvider: storedBilling.billingProvider ?? "beta_gate",
      billingAccessStatus: storedBilling.billingAccessStatus ?? "active",
      limitBreaches: storedBilling.limitBreaches ?? [],
      nextInvoiceDate: storedBilling.nextInvoiceDate || getNextInvoiceDate(),
      paymentMethodLabel:
        storedBilling.billingProvider === "stripe" ? storedBilling.paymentMethodLabel : DEFAULT_PAYMENT_METHOD_LABEL,
      paymentMethodStatus:
        storedBilling.billingProvider === "stripe" ? storedBilling.paymentMethodStatus : DEFAULT_PAYMENT_METHOD_STATUS,
      invoices: storedBilling.billingProvider === "stripe" ? storedBilling.invoices : DEFAULT_INVOICES,
    } satisfies WorkspaceBilling;

    if (hydratedBilling.billingProvider === "stripe" && hydratedBilling.stripeCustomerId) {
      try {
        const syncedBilling = await syncWorkspaceBillingFromStripe({
          billing: hydratedBilling,
          workspaceName: workspaceSession.activeWorkspace.name,
        });
        const mergedBilling = await mergeDerivedUsage(workspaceSession.activeWorkspace.id, syncedBilling);
        await saveStoredWorkspaceBilling(workspaceSession.activeWorkspace.id, mergedBilling);
        return mergedBilling;
      } catch {
        // Fall through to the stored billing snapshot when live Stripe sync is unavailable.
      }
    }

    return await mergeDerivedUsage(workspaceSession.activeWorkspace.id, hydratedBilling);
  }

  const planLimits = getPlanLimits("team");
  return await mergeDerivedUsage(workspaceSession.activeWorkspace.id, {
    workspaceId: workspaceSession.activeWorkspace.id,
    workspaceName: workspaceSession.activeWorkspace.name,
    billingProvider: "beta_gate",
    billingAccessStatus: "active",
    limitBreaches: [],
    planTier: "team",
    billingCycle: "yearly",
    billingEmail: workspaceSession.user.email,
    invoiceEmail: workspaceSession.user.email,
    taxId: undefined,
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

export async function saveWorkspaceBilling(workspaceSession: WorkspaceSession, update: BillingUpdate) {
  const workspaceId = workspaceSession.activeWorkspace.id;
  const currentBilling = await resolveWorkspaceBilling(workspaceSession);
  const planLimits = getPlanLimits(update.planTier);
  if (currentBilling.billingProvider !== "stripe") {
    await assertUsageFitsPlan({
      workspaceId,
      planTier: update.planTier,
    });
  }

  const savedBilling = await saveStoredWorkspaceBilling(workspaceId, {
    ...currentBilling,
    workspaceId,
    workspaceName: workspaceSession.activeWorkspace.name,
    billingProvider: currentBilling.billingProvider,
    billingAccessStatus: currentBilling.billingProvider === "stripe" ? currentBilling.billingAccessStatus : "active",
    limitBreaches: [],
    ...update,
    taxId: update.taxId || undefined,
    ...planLimits,
    monthlyEstimateUsd:
      update.billingCycle === "yearly"
        ? Math.round(planLimits.monthlyEstimateUsd * 0.85)
        : planLimits.monthlyEstimateUsd,
    nextInvoiceDate: currentBilling.billingProvider === "stripe" ? currentBilling.nextInvoiceDate : getNextInvoiceDate(),
    paymentMethodLabel:
      currentBilling.billingProvider === "stripe" ? currentBilling.paymentMethodLabel : DEFAULT_PAYMENT_METHOD_LABEL,
    paymentMethodStatus:
      currentBilling.billingProvider === "stripe" ? currentBilling.paymentMethodStatus : DEFAULT_PAYMENT_METHOD_STATUS,
    invoices: currentBilling.billingProvider === "stripe" ? currentBilling.invoices : DEFAULT_INVOICES,
    stripeCustomerId: currentBilling.stripeCustomerId,
    stripeSubscriptionId: currentBilling.stripeSubscriptionId,
  });

  return {
    billing: await mergeDerivedUsage(workspaceId, savedBilling),
    savedAt: new Date().toISOString(),
    message:
      currentBilling.billingProvider === "stripe"
        ? "Billing settings saved. Live Stripe billing remains active for this workspace."
        : "Billing settings saved. Hosted beta access now enforces the selected plan limits.",
  };
}

export async function resolveWorkspaceStripeBillingStatus(workspaceSession: WorkspaceSession) {
  return getWorkspaceStripeStatus(await resolveWorkspaceBilling(workspaceSession));
}

function resolveBillingReturnUrl(origin: string): string {
  return `${origin}/app/settings/billing`;
}

export async function createWorkspaceStripeCheckout(
  workspaceSession: WorkspaceSession,
  origin: string,
): Promise<{ url: string }> {
  const workspaceId = workspaceSession.activeWorkspace.id;
  const billing = await resolveWorkspaceBilling(workspaceSession);
  const session = await createWorkspaceStripeCheckoutSession({
    workspaceId,
    workspaceName: workspaceSession.activeWorkspace.name,
    billing,
    successUrl: resolveBillingReturnUrl(origin),
    cancelUrl: resolveBillingReturnUrl(origin),
  });

  if (session.customerId !== billing.stripeCustomerId) {
    await saveStoredWorkspaceBilling(workspaceId, {
      ...billing,
      stripeCustomerId: session.customerId,
    });
  }

  return { url: session.url };
}

export async function createWorkspaceStripePortal(
  workspaceSession: WorkspaceSession,
  origin: string,
): Promise<{ url: string }> {
  const billing = await resolveWorkspaceBilling(workspaceSession);
  return await createWorkspaceStripePortalSession({
    workspaceId: workspaceSession.activeWorkspace.id,
    billing,
    returnUrl: resolveBillingReturnUrl(origin),
  });
}

async function findWorkspaceBillingByStripeCustomerId(customerId: string): Promise<WorkspaceBilling | null> {
  const billings = await listStoredWorkspaceBillings();
  return billings.find((billing) => billing.stripeCustomerId === customerId) ?? null;
}

export async function handleWorkspaceStripeWebhook(body: string, signature: string): Promise<void> {
  const event = constructStripeWebhookEvent(body, signature);

  let workspaceBilling: WorkspaceBilling | null = null;
  let workspaceId: string | null = null;

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const metadataWorkspaceId = typeof session.metadata?.workspaceId === "string" ? session.metadata.workspaceId : null;
      if (!metadataWorkspaceId) {
        return;
      }

      workspaceId = metadataWorkspaceId;
      const existingBilling = await getStoredWorkspaceBilling(workspaceId);
      if (!existingBilling) {
        return;
      }

      workspaceBilling = {
        ...existingBilling,
        billingProvider: "stripe",
        stripeCustomerId: typeof session.customer === "string" ? session.customer : existingBilling.stripeCustomerId,
        stripeSubscriptionId:
          typeof session.subscription === "string" ? session.subscription : existingBilling.stripeSubscriptionId,
      };
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const subscription = event.data.object;
      workspaceId =
        typeof subscription.metadata?.workspaceId === "string" ? subscription.metadata.workspaceId : null;

      if (workspaceId) {
        const existingBilling = await getStoredWorkspaceBilling(workspaceId);
        if (!existingBilling) {
          return;
        }

        workspaceBilling = {
          ...existingBilling,
          billingProvider: "stripe",
          stripeCustomerId: typeof subscription.customer === "string" ? subscription.customer : existingBilling.stripeCustomerId,
          stripeSubscriptionId: subscription.id,
        };
      } else if (typeof subscription.customer === "string") {
        workspaceBilling = await findWorkspaceBillingByStripeCustomerId(subscription.customer);
        workspaceId = workspaceBilling?.workspaceId ?? null;
        if (workspaceBilling) {
          workspaceBilling = {
            ...workspaceBilling,
            billingProvider: "stripe",
            stripeSubscriptionId: subscription.id,
          };
        }
      }
      break;
    }
    case "invoice.paid":
    case "invoice.payment_failed":
    case "invoice.voided": {
      const invoice = event.data.object;
      if (typeof invoice.customer === "string") {
        workspaceBilling = await findWorkspaceBillingByStripeCustomerId(invoice.customer);
        workspaceId = workspaceBilling?.workspaceId ?? null;
      }
      break;
    }
    default:
      return;
  }

  if (!workspaceBilling || !workspaceId) {
    return;
  }

  const workspaceState = await getWorkspaceConnectionState(workspaceId);
  const syncedBilling = await syncWorkspaceBillingFromStripe({
    billing: workspaceBilling,
    workspaceName: workspaceState?.workspaceName ?? workspaceBilling.workspaceName,
  });
  const mergedBilling = await mergeDerivedUsage(workspaceId, syncedBilling);
  await saveStoredWorkspaceBilling(workspaceId, mergedBilling);
}
