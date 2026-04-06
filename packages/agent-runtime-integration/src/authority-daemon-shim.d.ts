declare module "@agentgit/authority-daemon" {
  export interface AuthorityDaemonRuntimeConfig {
    socketPath: string;
  }

  export interface StartedAuthorityDaemon {
    shutdown(): Promise<void>;
  }

  export function resolveAuthorityDaemonRuntimeConfig(
    env: NodeJS.ProcessEnv,
    workspaceRoot: string,
  ): AuthorityDaemonRuntimeConfig;

  export function runAuthorityDaemon(config: AuthorityDaemonRuntimeConfig): Promise<StartedAuthorityDaemon>;
}
