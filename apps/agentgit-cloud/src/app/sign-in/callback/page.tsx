import { Card } from "@/components/primitives";

export default function SignInCallbackPage() {
  return (
    <main className="ag-page-shell flex min-h-screen items-center justify-center px-6 py-16">
      <Card className="w-full max-w-md text-center">
        <h1 className="text-xl font-semibold">Completing sign-in</h1>
        <p className="mt-2 text-sm text-[var(--ag-text-secondary)]">
          This route is reserved for the GitHub OAuth callback handler and session bootstrap.
        </p>
      </Card>
    </main>
  );
}
