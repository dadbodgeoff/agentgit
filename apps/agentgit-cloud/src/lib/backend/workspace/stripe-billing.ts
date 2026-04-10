import "server-only";

import Stripe from "stripe";

import type {
  BillingCycle,
  BillingInvoice,
  BillingPaymentMethodStatus,
  BillingPlanTier,
  StripeBillingStatus,
  WorkspaceBilling,
} from "@/schemas/cloud";
import { isProductionAuth } from "@/lib/auth/provider-config";

const STRIPE_PRICE_ENV: Record<BillingPlanTier, Record<BillingCycle, string>> = {
  starter: {
    monthly: "STRIPE_PRICE_STARTER_MONTHLY",
    yearly: "STRIPE_PRICE_STARTER_YEARLY",
  },
  team: {
    monthly: "STRIPE_PRICE_TEAM_MONTHLY",
    yearly: "STRIPE_PRICE_TEAM_YEARLY",
  },
  enterprise: {
    monthly: "STRIPE_PRICE_ENTERPRISE_MONTHLY",
    yearly: "STRIPE_PRICE_ENTERPRISE_YEARLY",
  },
};

let stripeClient: Stripe | null = null;

export class WorkspaceStripeError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "WorkspaceStripeError";
  }
}

export class WorkspaceStripeConfigurationError extends WorkspaceStripeError {
  constructor(message: string) {
    super(message, 503);
    this.name = "WorkspaceStripeConfigurationError";
  }
}

export class WorkspaceStripeStateError extends WorkspaceStripeError {
  constructor(message: string, statusCode = 409) {
    super(message, statusCode);
    this.name = "WorkspaceStripeStateError";
  }
}

function normalizeEnv(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function getStripeSecretKey(): string | null {
  return normalizeEnv(process.env.STRIPE_SECRET_KEY);
}

export function getStripeWebhookSecret(): string | null {
  return normalizeEnv(process.env.STRIPE_WEBHOOK_SECRET);
}

function getStripePriceId(planTier: BillingPlanTier, billingCycle: BillingCycle): string | null {
  const priceId = normalizeEnv(process.env[STRIPE_PRICE_ENV[planTier][billingCycle]]);
  if (!priceId) {
    return null;
  }

  return priceId.startsWith("price_") ? priceId : null;
}

function getConfiguredPriceIds() {
  return {
    starter: {
      monthly: getStripePriceId("starter", "monthly"),
      yearly: getStripePriceId("starter", "yearly"),
    },
    team: {
      monthly: getStripePriceId("team", "monthly"),
      yearly: getStripePriceId("team", "yearly"),
    },
    enterprise: {
      monthly: getStripePriceId("enterprise", "monthly"),
      yearly: getStripePriceId("enterprise", "yearly"),
    },
  } satisfies Record<BillingPlanTier, Record<BillingCycle, string | null>>;
}

function getStripeClient(): Stripe {
  const secretKey = getStripeSecretKey();
  if (!secretKey) {
    throw new WorkspaceStripeConfigurationError(
      "Stripe is not configured in this environment yet. Add STRIPE_SECRET_KEY and the plan price ids to enable live billing.",
    );
  }

  if (isProductionAuth && !secretKey.startsWith("sk_live_")) {
    throw new WorkspaceStripeConfigurationError(
      "Production Stripe billing requires a live secret key that starts with sk_live_.",
    );
  }

  if (!stripeClient) {
    stripeClient = new Stripe(secretKey);
  }

  return stripeClient;
}

function resolvePaymentMethodLabel(paymentMethod: Stripe.PaymentMethod | null, fallback: string): string {
  if (!paymentMethod || paymentMethod.type !== "card" || !paymentMethod.card) {
    return fallback;
  }

  const brand = paymentMethod.card.brand.toUpperCase();
  return `${brand} ending ${paymentMethod.card.last4}`;
}

function resolvePaymentMethodStatus(
  subscriptionStatus: Stripe.Subscription.Status | null,
  paymentMethod: Stripe.PaymentMethod | null,
): BillingPaymentMethodStatus {
  if (subscriptionStatus && ["past_due", "unpaid", "incomplete", "incomplete_expired"].includes(subscriptionStatus)) {
    return "update_required";
  }

  if (paymentMethod?.type === "card" && paymentMethod.card?.exp_month && paymentMethod.card.exp_year) {
    const currentMonth = new Date();
    const expiration = new Date(paymentMethod.card.exp_year, paymentMethod.card.exp_month - 1, 1);
    const monthDelta =
      (expiration.getFullYear() - currentMonth.getFullYear()) * 12 + (expiration.getMonth() - currentMonth.getMonth());

    if (monthDelta >= 0 && monthDelta <= 1) {
      return "expiring";
    }
  }

  return "active";
}

function mapInvoiceStatus(status: Stripe.Invoice.Status | null | undefined): BillingInvoice["status"] {
  if (status === "paid") {
    return "paid";
  }

  if (status === "void") {
    return "void";
  }

  return "open";
}

function mapStripeInvoice(invoice: Stripe.Invoice): BillingInvoice {
  const periodStart = typeof invoice.period_start === "number" ? new Date(invoice.period_start * 1000) : null;
  const periodEnd = typeof invoice.period_end === "number" ? new Date(invoice.period_end * 1000) : null;

  return {
    id: invoice.id,
    periodLabel:
      periodStart && periodEnd
        ? `${periodStart.toLocaleString("en-US", { month: "short", year: "numeric" })} - ${periodEnd.toLocaleString("en-US", { month: "short", year: "numeric" })}`
        : (invoice.description ?? invoice.number ?? "Stripe invoice"),
    amountUsd: (invoice.total ?? invoice.amount_due ?? invoice.amount_paid ?? 0) / 100,
    status: mapInvoiceStatus(invoice.status),
    issuedAt: new Date((invoice.created ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    dueAt: typeof invoice.due_date === "number" ? new Date(invoice.due_date * 1000).toISOString() : undefined,
  };
}

function resolvePlanFromPriceId(priceId: string): { planTier: BillingPlanTier; billingCycle: BillingCycle } | null {
  const configured = getConfiguredPriceIds();

  for (const [planTier, cycles] of Object.entries(configured) as Array<
    [BillingPlanTier, Record<BillingCycle, string | null>]
  >) {
    for (const [billingCycle, configuredPriceId] of Object.entries(cycles) as Array<[BillingCycle, string | null]>) {
      if (configuredPriceId === priceId) {
        return { planTier, billingCycle };
      }
    }
  }

  return null;
}

function selectRelevantSubscription(subscriptions: Stripe.ApiList<Stripe.Subscription>): Stripe.Subscription | null {
  const preferredStatuses: Stripe.Subscription.Status[] = ["active", "trialing", "past_due", "unpaid", "canceled"];

  for (const status of preferredStatuses) {
    const match = subscriptions.data.find((subscription) => subscription.status === status);
    if (match) {
      return match;
    }
  }

  return subscriptions.data[0] ?? null;
}

export function getWorkspaceStripeStatus(billing: WorkspaceBilling): StripeBillingStatus {
  const secretKey = getStripeSecretKey();
  const priceId = getStripePriceId(billing.planTier, billing.billingCycle);

  if (!secretKey) {
    return {
      provider: billing.billingProvider,
      checkoutEnabled: false,
      portalEnabled: false,
      message: "Stripe is not configured in this environment yet.",
    };
  }

  if (billing.billingProvider === "stripe") {
    return {
      provider: billing.billingProvider,
      checkoutEnabled: false,
      portalEnabled: Boolean(billing.stripeCustomerId),
      message: billing.stripeCustomerId
        ? "Live Stripe billing is active for this workspace."
        : "Stripe is configured, but this workspace has not finished checkout yet.",
    };
  }

  if (!priceId) {
    return {
      provider: billing.billingProvider,
      checkoutEnabled: false,
      portalEnabled: false,
      message: `Stripe checkout is not configured for the ${billing.planTier} ${billing.billingCycle} plan yet.`,
    };
  }

  return {
    provider: billing.billingProvider,
    checkoutEnabled: true,
    portalEnabled: false,
    message: "Stripe checkout is available for the current plan selection.",
  };
}

export async function createWorkspaceStripeCheckoutSession(params: {
  workspaceId: string;
  workspaceName: string;
  billing: WorkspaceBilling;
  successUrl: string;
  cancelUrl: string;
}) {
  const stripe = getStripeClient();
  const priceId = getStripePriceId(params.billing.planTier, params.billing.billingCycle);
  if (!priceId) {
    throw new WorkspaceStripeConfigurationError(
      `Stripe checkout is not configured for the ${params.billing.planTier} ${params.billing.billingCycle} plan yet.`,
    );
  }

  const price = await stripe.prices.retrieve(priceId);
  if (!price.active || price.type !== "recurring" || typeof price.unit_amount !== "number" || price.unit_amount <= 0) {
    throw new WorkspaceStripeConfigurationError(
      `Stripe price ${priceId} is inactive or invalid for the ${params.billing.planTier} ${params.billing.billingCycle} plan.`,
    );
  }

  let customerId = params.billing.stripeCustomerId ?? null;
  if (customerId) {
    await stripe.customers.update(customerId, {
      email: params.billing.billingEmail,
      name: params.workspaceName,
      metadata: {
        workspaceId: params.workspaceId,
      },
    });
  } else {
    const customer = await stripe.customers.create({
      email: params.billing.billingEmail,
      name: params.workspaceName,
      metadata: {
        workspaceId: params.workspaceId,
      },
    });
    customerId = customer.id;
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    allow_promotion_codes: false,
    billing_address_collection: "auto",
    customer: customerId,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: {
      workspaceId: params.workspaceId,
      planTier: params.billing.planTier,
      billingCycle: params.billing.billingCycle,
    },
    subscription_data: {
      metadata: {
        workspaceId: params.workspaceId,
      },
    },
  });

  if (!session.url) {
    throw new WorkspaceStripeStateError("Stripe did not return a checkout URL.", 502);
  }

  return {
    customerId,
    url: session.url,
  };
}

export async function createWorkspaceStripePortalSession(params: {
  workspaceId: string;
  billing: WorkspaceBilling;
  returnUrl: string;
}) {
  const stripe = getStripeClient();
  if (!params.billing.stripeCustomerId) {
    throw new WorkspaceStripeStateError("This workspace does not have an active Stripe customer yet.");
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: params.billing.stripeCustomerId,
    return_url: params.returnUrl,
  });

  return {
    url: session.url,
  };
}

export function constructStripeWebhookEvent(body: string, signature: string): Stripe.Event {
  const webhookSecret = getStripeWebhookSecret();
  if (!webhookSecret) {
    throw new WorkspaceStripeConfigurationError(
      "Stripe webhook handling is not configured yet. Add STRIPE_WEBHOOK_SECRET to enable billing sync.",
    );
  }

  return getStripeClient().webhooks.constructEvent(body, signature, webhookSecret);
}

export async function syncWorkspaceBillingFromStripe(params: { billing: WorkspaceBilling; workspaceName: string }) {
  if (!params.billing.stripeCustomerId) {
    throw new WorkspaceStripeStateError("No Stripe customer is associated with this workspace.");
  }

  const stripe = getStripeClient();
  const customer = await stripe.customers.retrieve(params.billing.stripeCustomerId, {
    expand: ["invoice_settings.default_payment_method"],
  });

  if (customer.deleted) {
    throw new WorkspaceStripeStateError("The Stripe customer attached to this workspace no longer exists.");
  }

  let subscription: Stripe.Subscription | null = null;
  if (params.billing.stripeSubscriptionId) {
    subscription = await stripe.subscriptions.retrieve(params.billing.stripeSubscriptionId, {
      expand: ["default_payment_method"],
    });
  } else {
    const subscriptions = await stripe.subscriptions.list({
      customer: customer.id,
      status: "all",
      limit: 10,
      expand: ["data.default_payment_method"],
    });
    subscription = selectRelevantSubscription(subscriptions);
  }

  if (!subscription) {
    throw new WorkspaceStripeStateError("No Stripe subscription is active for this workspace.");
  }

  const subscriptionPriceId = subscription.items.data[0]?.price?.id ?? null;
  const mappedPlan = subscriptionPriceId ? resolvePlanFromPriceId(subscriptionPriceId) : null;
  if (!mappedPlan) {
    throw new WorkspaceStripeStateError(
      "The active Stripe subscription does not map to a configured AgentGit plan.",
      502,
    );
  }

  const invoices = await stripe.invoices.list({
    customer: customer.id,
    limit: 8,
  });

  const defaultPaymentMethod =
    subscription.default_payment_method && typeof subscription.default_payment_method !== "string"
      ? subscription.default_payment_method
      : customer.invoice_settings.default_payment_method &&
          typeof customer.invoice_settings.default_payment_method !== "string"
        ? customer.invoice_settings.default_payment_method
        : null;

  const nextPeriodEnd = subscription.items.data[0]?.current_period_end;
  const nextInvoiceDate =
    typeof nextPeriodEnd === "number" ? new Date(nextPeriodEnd * 1000).toISOString() : params.billing.nextInvoiceDate;

  return {
    ...params.billing,
    workspaceName: params.workspaceName,
    billingProvider: "stripe" as const,
    planTier: mappedPlan.planTier,
    billingCycle: mappedPlan.billingCycle,
    billingEmail: customer.email ?? params.billing.billingEmail,
    nextInvoiceDate,
    paymentMethodLabel: resolvePaymentMethodLabel(defaultPaymentMethod, "Stripe billing active"),
    paymentMethodStatus: resolvePaymentMethodStatus(subscription.status, defaultPaymentMethod),
    invoices: invoices.data.map(mapStripeInvoice),
    stripeCustomerId: customer.id,
    stripeSubscriptionId: subscription.id,
  } satisfies WorkspaceBilling;
}
