export const publicRoutes = {
  landing: "/",
  pricing: "/pricing",
  docs: "/docs",
  signIn: "/sign-in",
  signInCallback: "/sign-in/callback",
} as const;

export const authenticatedRoutes = {
  dashboard: "/app",
  repositories: "/app/repos",
  approvals: "/app/approvals",
  activity: "/app/activity",
  audit: "/app/audit",
  settings: "/app/settings",
  team: "/app/settings/team",
  billing: "/app/settings/billing",
  integrations: "/app/settings/integrations",
  connectors: "/app/settings/connectors",
  onboarding: "/app/onboarding",
  calibration: "/app/calibration",
} as const;

export function repositoryRoute(owner: string, name: string): string {
  return `/app/repos/${owner}/${name}`;
}

export function repositoryRunsRoute(owner: string, name: string): string {
  return `${repositoryRoute(owner, name)}/runs`;
}

export function runDetailRoute(owner: string, name: string, runId: string): string {
  return `${repositoryRunsRoute(owner, name)}/${runId}`;
}

export function actionDetailRoute(owner: string, name: string, runId: string, actionId: string): string {
  return `${runDetailRoute(owner, name, runId)}/actions/${actionId}`;
}

export function repositoryPolicyRoute(owner: string, name: string): string {
  return `${repositoryRoute(owner, name)}/policy`;
}

export function repositorySnapshotsRoute(owner: string, name: string): string {
  return `${repositoryRoute(owner, name)}/snapshots`;
}
