import { ScaffoldPage } from "@/features/shared/scaffold-page";

export default function PricingPage(): JSX.Element {
  return (
    <main className="ag-page-shell px-6 py-16">
      <div className="mx-auto max-w-6xl">
        <ScaffoldPage
          description="Public pricing surface reserved in the route map before feature implementation begins."
          sections={[
            { title: "Plan comparison", description: "Hosted plan matrix and pricing tiers.", kind: "cards" },
            { title: "Feature boundaries", description: "Clarify OSS daemon versus hosted cloud capabilities.", kind: "table" },
          ]}
          title="Pricing"
        />
      </div>
    </main>
  );
}
