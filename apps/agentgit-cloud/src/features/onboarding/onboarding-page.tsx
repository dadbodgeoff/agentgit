import { Button } from "@/components/primitives";
import { ScaffoldPage } from "@/features/shared/scaffold-page";

export function OnboardingPage(): JSX.Element {
  return (
    <ScaffoldPage
      actions={<Button>Launch workspace</Button>}
      description="Stepper-based team onboarding for workspace creation, repository connection, invitations, and default policy setup."
      sections={[
        { title: "Workspace setup", description: "Name and slug collection plus validation." },
        { title: "Repository connection", description: "Multi-select repository picker and policy pack defaults." },
        { title: "Team and review", description: "Role assignment, summary, and launch gate." },
      ]}
      title="Onboarding"
    />
  );
}
