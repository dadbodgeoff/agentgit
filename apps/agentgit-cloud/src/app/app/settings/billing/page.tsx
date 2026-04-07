import { ScaffoldPage } from "@/features/shared/scaffold-page";

export default function BillingSettingsRoute() {
  return (
    <ScaffoldPage
      description="Billing scaffold reserved for owner-only plan and workspace billing controls."
      sections={[
        { title: "Current plan", description: "Plan card and usage summary." },
        { title: "Invoices", description: "Read-only billing history table.", kind: "table" },
      ]}
      title="Billing"
    />
  );
}
