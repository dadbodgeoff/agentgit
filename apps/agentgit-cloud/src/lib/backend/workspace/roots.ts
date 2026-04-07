import "server-only";

export function resolveWorkspaceRoots(): string[] {
  const configuredRoots = process.env.AGENTGIT_CLOUD_WORKSPACE_ROOTS;
  if (configuredRoots) {
    return configuredRoots
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  return [process.env.AGENTGIT_ROOT ?? process.cwd()];
}
