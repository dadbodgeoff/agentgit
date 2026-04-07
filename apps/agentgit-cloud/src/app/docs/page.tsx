import { ScaffoldPage } from "@/features/shared/scaffold-page";

export default function DocsPage() {
  return (
    <main className="ag-page-shell px-6 py-16">
      <div className="mx-auto max-w-6xl">
        <ScaffoldPage
          description="Public documentation landing route reserved for future hosted product docs."
          sections={[
            { title: "Cloud quickstart", description: "Onboarding documentation for workspace creation and repository connection." },
            { title: "Approval model", description: "Explain policy, approvals, and calibration in hosted mode.", kind: "cards" },
          ]}
          title="Documentation"
        />
      </div>
    </main>
  );
}
