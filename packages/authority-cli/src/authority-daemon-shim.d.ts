declare module "@agentgit/authority-daemon" {
  export interface AuthorityDaemonRuntimeConfig {
    projectRoot: string;
    socketPath: string;
    journalPath: string;
    snapshotRootPath: string;
    mcpRegistryPath: string;
    mcpSecretStorePath: string;
    mcpSecretKeyPath: string;
    mcpHostPolicyPath: string;
    mcpConcurrencyLeasePath: string;
    mcpHostedWorkerEndpoint: string;
    mcpHostedWorkerAutostart: boolean;
    mcpHostedWorkerControlToken?: string;
    mcpHostedWorkerAttestationKeyPath: string;
    mcpHostedWorkerCommand?: string;
    mcpHostedWorkerArgs?: string[];
    policyGlobalConfigPath: string;
    policyWorkspaceConfigPath: string;
    policyCalibrationConfigPath: string;
    policyConfigPath?: string;
    artifactRetentionMs: number | null;
  }

  export interface AuthorityDaemonListeningSummary {
    status: "listening";
    socket_path: string;
    journal_path: string;
    snapshot_root_path: string;
    mcp_registry_path: string;
    mcp_secret_store_path: string;
    mcp_secret_key_path: string;
    mcp_host_policy_path: string;
    mcp_concurrency_lease_path: string;
    mcp_hosted_worker_endpoint: string;
    mcp_hosted_worker_autostart: boolean;
    mcp_hosted_worker_attestation_key_path: string;
    policy_global_config_path: string;
    policy_workspace_config_path: string;
    policy_calibration_config_path: string;
    policy_config_path: string | null;
    artifact_retention_ms: number | null;
  }

  export interface RunAuthorityDaemonOptions {
    registerSignalHandlers?: boolean;
    onListening?: (summary: AuthorityDaemonListeningSummary) => void;
  }

  export interface StartedAuthorityDaemon {
    config: AuthorityDaemonRuntimeConfig;
    summary: AuthorityDaemonListeningSummary;
    shutdown(): Promise<void>;
  }

  export function resolveAuthorityDaemonRuntimeConfig(
    env?: NodeJS.ProcessEnv,
    cwd?: string,
  ): AuthorityDaemonRuntimeConfig;

  export function runAuthorityDaemon(
    config: AuthorityDaemonRuntimeConfig,
    options?: RunAuthorityDaemonOptions,
  ): Promise<StartedAuthorityDaemon>;

  export function runAuthorityDaemonFromEnv(
    options?: RunAuthorityDaemonOptions,
  ): Promise<StartedAuthorityDaemon>;
}
