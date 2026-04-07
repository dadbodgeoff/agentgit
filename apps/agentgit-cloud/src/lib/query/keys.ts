export const queryKeys = {
  dashboard: ["dashboard"] as const,
  approvals: ["approvals"] as const,
  repositories: ["repositories"] as const,
  repository: (owner: string, name: string) => ["repository", owner, name] as const,
  runs: (owner: string, name: string) => ["runs", owner, name] as const,
  run: (runId: string) => ["run", runId] as const,
  action: (actionId: string) => ["action", actionId] as const,
  calibration: (repoId: string) => ["calibration", repoId] as const,
  activity: ["activity"] as const,
  audit: ["audit"] as const,
} as const;
