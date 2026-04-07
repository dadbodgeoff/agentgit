import { ScaffoldPage } from "@/features/shared/scaffold-page";

export default function IntegrationsRoute(): JSX.Element {
  return (
    <ScaffoldPage
      description="Integration settings scaffold for GitHub app status, webhooks, and future notification channels."
      sections={[
        { title: "GitHub integration", description: "Installation and health surface." },
        { title: "Notification channels", description: "Slack and email channel wiring." },
      ]}
      title="Integrations"
    />
  );
}
