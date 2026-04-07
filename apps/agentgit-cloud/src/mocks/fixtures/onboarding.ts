import {
  OnboardingBootstrapSchema,
  OnboardingLaunchResponseSchema,
  type OnboardingBootstrap,
  type OnboardingFormValues,
  type OnboardingLaunchResponse,
  type PreviewState,
} from "@/schemas/cloud";

const onboardingBootstrapFixture = OnboardingBootstrapSchema.parse({
  suggestedWorkspaceName: "Acme platform",
  suggestedWorkspaceSlug: "acme-platform",
  availableRepositories: [
    {
      id: "repo_acme_api_gateway",
      owner: "acme",
      name: "api-gateway",
      defaultBranch: "main",
      description: "Edge auth gateway and token exchange service.",
      requiresOrgApproval: false,
    },
    {
      id: "repo_acme_platform_ui",
      owner: "acme",
      name: "platform-ui",
      defaultBranch: "main",
      description: "Hosted dashboard, approvals, and repository oversight UI.",
      requiresOrgApproval: false,
    },
    {
      id: "repo_acme_infrastructure",
      owner: "acme",
      name: "infrastructure",
      defaultBranch: "release/2026-04",
      description: "Terraform and deployment automation for production services.",
      requiresOrgApproval: true,
    },
  ],
  connectedRepositoryIds: [],
  invites: [],
  defaultNotificationChannel: "slack",
  recommendedPolicyPack: "guarded",
});

const onboardingEmptyBootstrapFixture = OnboardingBootstrapSchema.parse({
  suggestedWorkspaceName: "Acme platform",
  suggestedWorkspaceSlug: "acme-platform",
  availableRepositories: [],
  connectedRepositoryIds: [],
  invites: [],
  defaultNotificationChannel: "slack",
  recommendedPolicyPack: "guarded",
});

export function getOnboardingBootstrapFixture(previewState: PreviewState): OnboardingBootstrap {
  return previewState === "empty" ? onboardingEmptyBootstrapFixture : onboardingBootstrapFixture;
}

export function launchOnboardingFixture(values: OnboardingFormValues): OnboardingLaunchResponse {
  return OnboardingLaunchResponseSchema.parse({
    workspaceId: "ws_acme_01",
    launchedAt: "2026-04-07T15:04:00Z",
    connectedRepositoryCount: values.repositoryIds.length,
    invitedTeamCount: values.invites.length,
    message: "Workspace launched. Redirecting to the dashboard.",
  });
}
