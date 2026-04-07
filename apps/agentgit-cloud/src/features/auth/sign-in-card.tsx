"use client";

import { useMemo, useState } from "react";

import Link from "next/link";
import { signIn } from "next-auth/react";

import { Button, Card, Input } from "@/components/primitives";
import { DEVELOPMENT_PROVIDER_ID } from "@/lib/auth/provider-config";
import { publicRoutes } from "@/lib/navigation/routes";
import { cn } from "@/lib/utils/cn";

function selectClassName() {
  return "ag-focus-ring h-9 rounded-[var(--ag-radius-md)] border border-[var(--ag-border-default)] bg-[var(--ag-bg-card)] px-3 text-[14px] text-[var(--ag-text-primary)] hover:border-[var(--ag-border-strong)] focus:border-[var(--ag-color-brand)]";
}

export function SignInCard({
  callbackUrl,
  enableDevelopmentCredentials,
  enableGitHub,
  errorMessage,
}: {
  callbackUrl: string;
  enableDevelopmentCredentials: boolean;
  enableGitHub: boolean;
  errorMessage?: string;
}) {
  const [name, setName] = useState("Jordan Smith");
  const [email, setEmail] = useState("jordan@acme.dev");
  const [role, setRole] = useState("admin");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const resolvedErrorMessage = useMemo(() => {
    if (!errorMessage) {
      return null;
    }

    if (errorMessage === "Configuration") {
      return "Authentication is configured incorrectly. Check the auth environment variables.";
    }

    if (errorMessage === "AccessDenied") {
      return "Access was denied by the authentication provider.";
    }

    return errorMessage;
  }, [errorMessage]);

  async function handleGitHubSignIn() {
    setIsSubmitting(true);
    try {
      await signIn("github", { redirectTo: callbackUrl });
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDevelopmentSignIn() {
    setIsSubmitting(true);
    try {
      await signIn(DEVELOPMENT_PROVIDER_ID, {
        email,
        name,
        redirectTo: callbackUrl,
        role,
      });
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Card className="w-full max-w-md space-y-6">
      <div className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-[-0.02em]">Sign in</h1>
        <p className="text-sm text-[var(--ag-text-secondary)]">
          GitHub OAuth is the production auth path for AgentGit Cloud. Development credentials are local-only and stay
          disabled in production unless you explicitly opt into them.
        </p>
      </div>

      {resolvedErrorMessage ? (
        <div className="rounded-[var(--ag-radius-md)] border border-[color:rgb(239_68_68_/_0.25)] bg-[var(--ag-bg-error)] px-4 py-3 text-sm text-[var(--ag-color-error)]">
          {resolvedErrorMessage}
        </div>
      ) : null}

      {enableGitHub ? (
        <Button className="w-full" disabled={isSubmitting} onClick={() => void handleGitHubSignIn()}>
          Continue with GitHub
        </Button>
      ) : (
        <div className="rounded-[var(--ag-radius-md)] border border-dashed border-[var(--ag-border-default)] px-4 py-3 text-sm text-[var(--ag-text-secondary)]">
          GitHub OAuth is not configured yet. Add `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET`, and `AUTH_SECRET` to enable it.
        </div>
      )}

      {enableDevelopmentCredentials ? (
        <div className="space-y-4 rounded-[var(--ag-radius-lg)] border border-[var(--ag-border-subtle)] bg-[var(--ag-bg-elevated)] p-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold">Development sign-in</h2>
            <p className="text-sm text-[var(--ag-text-secondary)]">
              Use this local path to verify auth, route protection, and role-gated UI before production OAuth is live.
            </p>
          </div>

          <div className="space-y-3">
            <Input
              label="Display name"
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
            <Input
              label="Email"
              onChange={(event) => setEmail(event.target.value)}
              value={email}
            />
            <label className="flex w-full flex-col gap-1">
              <span className="text-[13px] font-semibold text-[var(--ag-text-primary)]">Workspace role</span>
              <select className={selectClassName()} onChange={(event) => setRole(event.target.value)} value={role}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
                <option value="owner">Owner</option>
              </select>
            </label>
          </div>

          <Button className="w-full" disabled={isSubmitting} onClick={() => void handleDevelopmentSignIn()} variant="secondary">
            Continue with development access
          </Button>
        </div>
      ) : null}

      <p className="text-xs text-[var(--ag-text-tertiary)]">
        OAuth callback endpoints are handled under `/api/auth/*`. The legacy callback stub remains available at{" "}
        <Link className="text-[var(--ag-color-brand)]" href={publicRoutes.signInCallback}>
          {publicRoutes.signInCallback}
        </Link>
        .
      </p>
      <div className={cn("rounded-[var(--ag-radius-md)] border border-[var(--ag-border-subtle)] px-3 py-2 text-xs text-[var(--ag-text-secondary)]")}>
        Redirect after sign-in: <span className="font-mono">{callbackUrl}</span>
      </div>
    </Card>
  );
}
