"use client";

import { useEffect, useState } from "react";

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";

import { EmptyState, LoadingSkeleton, PageStatePanel } from "@/components/feedback";
import { MetricCard, PageHeader } from "@/components/composites";
import {
  Badge,
  Button,
  Card,
  Input,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRoot,
  TableRow,
  ToastCard,
  ToastViewport,
} from "@/components/primitives";
import { ApiClientError } from "@/lib/api/client";
import {
  createWorkspaceStripeCheckoutSession,
  createWorkspaceStripePortalSession,
  getWorkspaceStripeBillingStatus,
  updateWorkspaceBilling,
} from "@/lib/api/endpoints/billing";
import { useWorkspaceBillingQuery } from "@/lib/query/hooks";
import { queryKeys } from "@/lib/query/keys";
import { isTrustedStripeHostedUrl } from "@/lib/security/external-url";
import { formatAbsoluteDate, formatCurrencyUsd, formatNumber } from "@/lib/utils/format";
import {
  BillingUpdateSchema,
  type BillingInvoice,
  type BillingLimitBreach,
  type BillingUpdate,
  type BillingPlanTier,
} from "@/schemas/cloud";

function selectClassName() {
  return "ag-focus-ring h-9 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] px-3 text-[14px] text-[var(--ag-text-primary)] hover:border-[var(--ag-border-strong)] focus:border-[var(--ag-color-brand)]";
}

function getInvoiceTone(status: BillingInvoice["status"]): "success" | "warning" | "neutral" {
  if (status === "paid") {
    return "success";
  }

  if (status === "open") {
    return "warning";
  }

  return "neutral";
}

const planDescriptions: Record<BillingPlanTier, string> = {
  starter: "For a small team getting its first governed repositories online.",
  team: "For an active team that needs approvals, calibration, and cross-repo visibility.",
  enterprise: "For larger organizations with procurement review and higher governance volume.",
};

const breachLabels: Record<BillingLimitBreach, string> = {
  seats: "Seat limit exceeded",
  repositories: "Repository cap exceeded",
  approvals: "Approval quota exceeded",
};

export function BillingSettingsPage() {
  const queryClient = useQueryClient();
  const billingQuery = useWorkspaceBillingQuery();
  const stripeStatusQuery = useQuery({
    queryKey: [...queryKeys.billing, "stripe-status"],
    queryFn: getWorkspaceStripeBillingStatus,
  });
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const form = useForm<BillingUpdate>({
    resolver: zodResolver(BillingUpdateSchema),
    defaultValues: {
      planTier: "team",
      billingCycle: "yearly",
      billingEmail: "",
      invoiceEmail: "",
      taxId: "",
    },
    mode: "onBlur",
  });

  const {
    formState: { errors, isDirty, isSubmitting },
    handleSubmit,
    register,
    reset,
    watch,
  } = form;

  useEffect(() => {
    if (!billingQuery.data) {
      return;
    }

    reset({
      planTier: billingQuery.data.planTier,
      billingCycle: billingQuery.data.billingCycle,
      billingEmail: billingQuery.data.billingEmail,
      invoiceEmail: billingQuery.data.invoiceEmail,
      taxId: billingQuery.data.taxId ?? "",
    });
  }, [billingQuery.data, reset]);

  useEffect(() => {
    if (!toastMessage) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setToastMessage(null);
    }, 4000);

    return () => window.clearTimeout(timeout);
  }, [toastMessage]);

  useEffect(() => {
    if (!errorToast) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setErrorToast(null);
    }, 4000);

    return () => window.clearTimeout(timeout);
  }, [errorToast]);

  const saveMutation = useMutation({
    mutationFn: (values: BillingUpdate) => updateWorkspaceBilling(values),
    onSuccess: (result) => {
      queryClient.setQueryData(queryKeys.billing, result.billing);
      reset({
        planTier: result.billing.planTier,
        billingCycle: result.billing.billingCycle,
        billingEmail: result.billing.billingEmail,
        invoiceEmail: result.billing.invoiceEmail,
        taxId: result.billing.taxId ?? "",
      });
      setSubmitError(null);
      setToastMessage(result.message);
      queryClient.invalidateQueries({ queryKey: [...queryKeys.billing, "stripe-status"] }).catch(() => undefined);
    },
    onError: (error) => {
      if (error instanceof ApiClientError) {
        const message =
          typeof error.details === "object" &&
          error.details !== null &&
          "message" in error.details &&
          typeof error.details.message === "string"
            ? error.details.message
            : "Could not save billing settings. Retry.";

        setSubmitError(message);
        setErrorToast(message);
        return;
      }

      setSubmitError("Could not save billing settings. Retry.");
      setErrorToast("Could not save billing settings. Retry.");
    },
  });

  const values = watch();

  const checkoutMutation = useMutation({
    mutationFn: async () => {
      if (isDirty) {
        await saveMutation.mutateAsync(values);
      }

      return await createWorkspaceStripeCheckoutSession();
    },
    onSuccess: ({ url }) => {
      if (!isTrustedStripeHostedUrl(url)) {
        setSubmitError("Received an unexpected Stripe checkout URL.");
        setErrorToast("Received an unexpected Stripe checkout URL.");
        return;
      }

      window.location.assign(url);
    },
    onError: (error) => {
      const message =
        error instanceof ApiClientError
          ? typeof error.details === "object" &&
            error.details !== null &&
            "message" in error.details &&
            typeof error.details.message === "string"
            ? error.details.message
            : "Could not start Stripe checkout. Retry."
          : "Could not start Stripe checkout. Retry.";

      setSubmitError(message);
      setErrorToast(message);
    },
  });

  const portalMutation = useMutation({
    mutationFn: createWorkspaceStripePortalSession,
    onSuccess: ({ url }) => {
      if (!isTrustedStripeHostedUrl(url)) {
        setSubmitError("Received an unexpected Stripe billing portal URL.");
        setErrorToast("Received an unexpected Stripe billing portal URL.");
        return;
      }

      window.location.assign(url);
    },
    onError: (error) => {
      const message =
        error instanceof ApiClientError
          ? typeof error.details === "object" &&
            error.details !== null &&
            "message" in error.details &&
            typeof error.details.message === "string"
            ? error.details.message
            : "Could not open the Stripe billing portal. Retry."
          : "Could not open the Stripe billing portal. Retry.";

      setSubmitError(message);
      setErrorToast(message);
    },
  });

  async function onSubmit(values: BillingUpdate) {
    setSubmitError(null);
    await saveMutation.mutateAsync(values);
  }

  if (billingQuery.isPending) {
    return (
      <>
        <PageHeader
          description="Owner-only billing controls for plan selection, invoice routing, and usage review."
          title="Billing"
        />
        <div className="grid gap-6 md:grid-cols-3">
          <MetricCard label="Monthly estimate" value="--" />
          <MetricCard label="Seats used" value="--" />
          <MetricCard label="Approvals used" value="--" />
        </div>
        <Card className="space-y-4">
          <LoadingSkeleton className="w-48" />
          <LoadingSkeleton className="w-full" lines={10} />
        </Card>
      </>
    );
  }

  if (billingQuery.isError) {
    return (
      <>
        <PageHeader
          description="Owner-only billing controls for plan selection, invoice routing, and usage review."
          title="Billing"
        />
        <PageStatePanel errorMessage="Could not load billing data. Retry." state="error" />
      </>
    );
  }

  if (!billingQuery.data) {
    return (
      <>
        <PageHeader
          description="Owner-only billing controls for plan selection, invoice routing, and usage review."
          title="Billing"
        />
        <EmptyState description="Billing has not been initialized for this workspace yet." title="No billing data" />
      </>
    );
  }

  const billing = billingQuery.data;
  const stripeStatus = stripeStatusQuery.data;
  const stripeProviderActive = billing.billingProvider === "stripe";
  const checkoutDisabled =
    checkoutMutation.isPending ||
    saveMutation.isPending ||
    stripeStatusQuery.isPending ||
    !stripeStatus?.checkoutEnabled;
  const portalDisabled =
    portalMutation.isPending ||
    stripeStatusQuery.isPending ||
    !stripeStatus?.portalEnabled;

  return (
    <>
      <PageHeader
        actions={
          <Badge tone={isDirty ? "warning" : "success"}>{isDirty ? "Unsaved billing changes" : "Billing synced"}</Badge>
        }
        description="Owner-only billing controls for plan selection, invoice routing, and usage review."
        title="Billing"
      />

      <div className="grid gap-6 md:grid-cols-3">
        <MetricCard
          label="Monthly estimate"
          trend={`${billing.planTier} plan`}
          value={formatCurrencyUsd(billing.monthlyEstimateUsd)}
        />
        <MetricCard
          label="Seats used"
          trend={`${formatNumber(billing.seatsIncluded)} included`}
          value={`${formatNumber(billing.seatsUsed)}/${formatNumber(billing.seatsIncluded)}`}
        />
        <MetricCard
          label="Approvals used"
          trend={`${formatNumber(billing.approvalsIncluded)} included`}
          value={`${formatNumber(billing.approvalsUsed)}/${formatNumber(billing.approvalsIncluded)}`}
        />
      </div>

      <Card className="space-y-3 border-[var(--ag-color-brand)] bg-[var(--ag-bg-elevated)]">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Hosted beta billing mode</h2>
            <p className="text-sm text-[var(--ag-text-secondary)]">
              Stripe is intentionally not live yet. This workspace runs on a hosted beta gate that enforces plan limits
              without charging a card.
            </p>
          </div>
          <Badge tone={billing.billingAccessStatus === "active" ? "success" : "warning"}>
            {billing.billingAccessStatus === "active" ? "Beta access active" : "Over beta limits"}
          </Badge>
        </div>
        {billing.limitBreaches.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {billing.limitBreaches.map((breach) => (
              <Badge key={breach} tone="warning">
                {breachLabels[breach]}
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-sm text-[var(--ag-text-secondary)]">
            Current usage is within the selected plan envelope for seats, repositories, and rolling approval volume.
          </p>
        )}
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.55fr)_minmax(320px,1fr)]">
        <form className="space-y-6" onSubmit={handleSubmit(onSubmit)}>
          <Card className="space-y-5">
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">Plan and billing cycle</h2>
              <p className="text-sm text-[var(--ag-text-secondary)]">
                {stripeProviderActive
                  ? "This workspace is on live Stripe billing. Plan changes now flow through Stripe, while billing contacts remain editable here."
                  : "Billing settings now persist durably in the cloud app, and the selected plan is enforced as the hosted beta entitlement envelope."}
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
              {(["starter", "team", "enterprise"] as BillingPlanTier[]).map((planTier) => {
                const selected = values.planTier === planTier;

                return (
                  <label
                    className={
                      selected
                        ? "flex cursor-pointer flex-col gap-3 rounded-[var(--ag-radius-lg)] border border-[var(--ag-color-brand)] bg-[var(--ag-bg-elevated)] p-4"
                        : "flex cursor-pointer flex-col gap-3 rounded-[var(--ag-radius-lg)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-card)] p-4 hover:border-[var(--ag-border-strong)] hover:bg-[var(--ag-bg-elevated)]"
                    }
                    key={planTier}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-base font-semibold capitalize">{planTier}</span>
                      <input disabled={stripeProviderActive} type="radio" value={planTier} {...register("planTier")} />
                    </div>
                    <p className="text-sm text-[var(--ag-text-secondary)]">{planDescriptions[planTier]}</p>
                  </label>
                );
              })}
            </div>

            <label className="flex w-full max-w-xs flex-col gap-1">
              <span className="text-[13px] font-semibold text-[var(--ag-text-primary)]">Billing cycle</span>
              <select className={selectClassName()} disabled={stripeProviderActive} {...register("billingCycle")}>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
              <span className="text-[12px] text-[var(--ag-text-secondary)]">
                {stripeProviderActive
                  ? "The active Stripe subscription controls plan cadence. Use the billing portal to change it."
                  : "Yearly mode reflects a discounted effective monthly estimate for procurement planning, even before Stripe is enabled."}
              </span>
            </label>
          </Card>

          <Card className="space-y-5">
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">Billing contacts</h2>
              <p className="text-sm text-[var(--ag-text-secondary)]">
                Owner-only contact settings determine who receives payment issues and invoice copies.
              </p>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Input
                errorText={errors.billingEmail?.message}
                helpText="Primary owner or finance contact for billing issues."
                id="billing-email"
                label="Billing email"
                {...register("billingEmail")}
              />
              <Input
                errorText={errors.invoiceEmail?.message}
                helpText="Destination for invoice PDFs and renewal reminders."
                id="invoice-email"
                label="Invoice email"
                {...register("invoiceEmail")}
              />
            </div>

            <Input
              errorText={errors.taxId?.message}
              helpText="Optional tax or procurement identifier."
              id="tax-id"
              label="Tax ID (optional)"
              {...register("taxId")}
            />
          </Card>

          <Card className="space-y-5">
            <div className="space-y-2">
              <h2 className="text-lg font-semibold">Invoice history</h2>
              <p className="text-sm text-[var(--ag-text-secondary)]">
                {billing.billingProvider === "stripe"
                  ? "Stripe invoices sync into this workspace billing surface so owners can review recent billing periods without leaving the control plane."
                  : "Invoice history appears automatically when live Stripe billing is enabled. During hosted beta, plan enforcement works without generating processor invoices."}
              </p>
            </div>
            {billing.invoices.length === 0 ? (
              <EmptyState
                description="This workspace is still on beta-gated access, so there are no processor-issued invoices yet."
                title="No invoices yet"
              />
            ) : (
              <TableRoot>
                <TableHead>
                  <TableRow>
                    <TableHeaderCell>Period</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell>Issued</TableHeaderCell>
                    <TableHeaderCell>Due</TableHeaderCell>
                    <TableHeaderCell>Amount</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {billing.invoices.map((invoice) => (
                    <TableRow key={invoice.id}>
                      <TableCell className="font-medium">{invoice.periodLabel}</TableCell>
                      <TableCell>
                        <Badge tone={getInvoiceTone(invoice.status)}>{invoice.status}</Badge>
                      </TableCell>
                      <TableCell>{formatAbsoluteDate(invoice.issuedAt)}</TableCell>
                      <TableCell>{invoice.dueAt ? formatAbsoluteDate(invoice.dueAt) : "—"}</TableCell>
                      <TableCell className="font-mono">{formatCurrencyUsd(invoice.amountUsd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </TableRoot>
            )}
          </Card>

          {submitError ? (
            <div className="rounded-[var(--ag-radius-md)] border border-[color:rgb(239_68_68_/_0.25)] bg-[var(--ag-bg-error)] px-4 py-3 text-sm text-[var(--ag-color-error)]">
              {submitError}
            </div>
          ) : null}

          <Card className="sticky bottom-4 space-y-4 border-[var(--ag-color-brand)] bg-[var(--ag-bg-elevated)]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">Save rail</h2>
                <p className="text-sm text-[var(--ag-text-secondary)]">
                  Saving here changes the enforced hosted beta envelope immediately for future repo and seat growth.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={!isDirty || isSubmitting}
                  onClick={() =>
                    reset({
                      planTier: billing.planTier,
                      billingCycle: billing.billingCycle,
                      billingEmail: billing.billingEmail,
                      invoiceEmail: billing.invoiceEmail,
                      taxId: billing.taxId ?? "",
                    })
                  }
                  type="button"
                  variant="secondary"
                >
                  Reset changes
                </Button>
                <Button disabled={!isDirty || isSubmitting} type="submit">
                  {isSubmitting ? "Saving..." : "Save billing"}
                </Button>
              </div>
            </div>
          </Card>
        </form>

        <div className="space-y-6">
          <Card className="space-y-4">
            <h2 className="text-lg font-semibold">Payment method status</h2>
            <div className="space-y-3 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <div className="font-medium">{billing.paymentMethodLabel}</div>
                <Badge tone={billing.paymentMethodStatus === "active" ? "success" : "warning"}>
                  {billing.paymentMethodStatus.replace("_", " ")}
                </Badge>
              </div>
              <p className="text-sm text-[var(--ag-text-secondary)]">
                {stripeStatus?.message ??
                  "Card collection is disabled during hosted beta unless live Stripe is configured for this environment."}
              </p>
              <div className="flex flex-wrap gap-2">
                {stripeProviderActive ? (
                  <Button
                    disabled={portalDisabled}
                    onClick={() => void portalMutation.mutateAsync()}
                    size="sm"
                    variant="secondary"
                  >
                    {portalMutation.isPending ? "Opening portal..." : "Open Stripe portal"}
                  </Button>
                ) : (
                  <Button
                    disabled={checkoutDisabled}
                    onClick={() => void checkoutMutation.mutateAsync()}
                    size="sm"
                    variant="secondary"
                  >
                    {checkoutMutation.isPending
                      ? "Opening checkout..."
                      : isDirty
                        ? "Save and continue to Stripe"
                        : "Continue to Stripe checkout"}
                  </Button>
                )}
                {!stripeProviderActive && !stripeStatus?.checkoutEnabled ? (
                  <Badge tone="neutral">Stripe unavailable here</Badge>
                ) : null}
              </div>
            </div>
          </Card>

          <Card className="space-y-4">
            <h2 className="text-lg font-semibold">Usage snapshot</h2>
            <div className="space-y-3 text-sm text-[var(--ag-text-secondary)]">
              <div className="flex items-center justify-between gap-3">
                <span>Repositories connected</span>
                <span className="font-mono text-[var(--ag-text-primary)]">
                  {formatNumber(billing.repositoriesConnected)}/{formatNumber(billing.repositoriesIncluded)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Seats used</span>
                <span className="font-mono text-[var(--ag-text-primary)]">
                  {formatNumber(billing.seatsUsed)}/{formatNumber(billing.seatsIncluded)}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span>Next invoice date</span>
                <span className="font-mono text-[var(--ag-text-primary)]">
                  {billing.billingProvider === "beta_gate"
                    ? `Review ${formatAbsoluteDate(billing.nextInvoiceDate)}`
                    : formatAbsoluteDate(billing.nextInvoiceDate)}
                </span>
              </div>
            </div>
          </Card>

          <Card className="space-y-4">
            <h2 className="text-lg font-semibold">Shipping status</h2>
            <div className="rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] px-4 py-3 font-mono text-xs text-[var(--ag-text-secondary)]">
              <div>Active billing mode:</div>
              <div>- {billing.billingProvider === "stripe" ? "live Stripe subscription with webhook sync" : "hosted beta gate with enforced plan caps"}</div>
              <div>- durable owner-managed billing contacts</div>
              <div>
                - {billing.billingProvider === "stripe" ? "customer portal and invoice history are live" : "live card collection only appears when Stripe is configured"}
              </div>
              <div className="mt-3">Operator expectation:</div>
              <div>
                - {billing.billingProvider === "stripe" ? "manage plan and payment method in Stripe" : "upgrade the selected tier before adding more seats or repositories"}
              </div>
              <div>- review approval volume before the next access checkpoint</div>
            </div>
          </Card>
        </div>
      </div>

      {toastMessage ? (
        <ToastViewport>
          <ToastCard className="border-[color:rgb(34_197_94_/_0.28)]">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[var(--ag-text-primary)]">Billing saved</div>
              <p className="text-sm text-[var(--ag-text-secondary)]">{toastMessage}</p>
            </div>
          </ToastCard>
        </ToastViewport>
      ) : null}
      {errorToast ? (
        <ToastViewport>
          <ToastCard className="border-[color:rgb(239_68_68_/_0.28)]">
            <div className="space-y-1">
              <div className="text-sm font-semibold text-[var(--ag-text-primary)]">Save failed</div>
              <p className="text-sm text-[var(--ag-text-secondary)]">{errorToast}</p>
            </div>
          </ToastCard>
        </ToastViewport>
      ) : null}
    </>
  );
}
