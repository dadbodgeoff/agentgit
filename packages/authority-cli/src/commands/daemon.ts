import path from "node:path";

import type { AuthorityDaemonListeningSummary } from "@agentgit/authority-daemon";

import type { CliResolvedConfig } from "../cli-config.js";

async function loadAuthorityDaemonModule(): Promise<typeof import("@agentgit/authority-daemon")> {
  return await import("@agentgit/authority-daemon");
}

function daemonStateLayout(workspaceRoot: string): {
  agentgitRoot: string;
  stateRoot: string;
  mcpRoot: string;
  journalPath: string;
  snapshotRootPath: string;
  mcpRegistryPath: string;
  mcpSecretStorePath: string;
  mcpSecretKeyPath: string;
  mcpHostPolicyPath: string;
  mcpConcurrencyLeasePath: string;
  mcpHostedWorkerEndpoint: string;
  mcpHostedWorkerAttestationKeyPath: string;
  policyWorkspaceConfigPath: string;
  policyCalibrationConfigPath: string;
} {
  const agentgitRoot = path.resolve(workspaceRoot, ".agentgit");
  const stateRoot = path.join(agentgitRoot, "state");
  const mcpRoot = path.join(stateRoot, "mcp");

  return {
    agentgitRoot,
    stateRoot,
    mcpRoot,
    journalPath: path.join(stateRoot, "authority.db"),
    snapshotRootPath: path.join(stateRoot, "snapshots"),
    mcpRegistryPath: path.join(mcpRoot, "registry.db"),
    mcpSecretStorePath: path.join(mcpRoot, "secret-store.db"),
    mcpSecretKeyPath: path.join(mcpRoot, "secret-store.key"),
    mcpHostPolicyPath: path.join(mcpRoot, "host-policies.db"),
    mcpConcurrencyLeasePath: path.join(mcpRoot, "concurrency-leases.db"),
    mcpHostedWorkerEndpoint: `unix:${path.join(mcpRoot, "hosted-worker.sock")}`,
    mcpHostedWorkerAttestationKeyPath: path.join(mcpRoot, "hosted-worker-attestation-key.json"),
    policyWorkspaceConfigPath: path.join(agentgitRoot, "policy.toml"),
    policyCalibrationConfigPath: path.join(agentgitRoot, "policy.calibration.generated.json"),
  };
}

export function buildDaemonRuntimeEnvironment(
  resolvedConfig: CliResolvedConfig,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const workspaceRoot = resolvedConfig.workspace_root.value;
  const layout = daemonStateLayout(workspaceRoot);

  return {
    ...env,
    AGENTGIT_ROOT: workspaceRoot,
    INIT_CWD: workspaceRoot,
    AGENTGIT_SOCKET_PATH: resolvedConfig.socket_path.value,
    AGENTGIT_JOURNAL_PATH: env.AGENTGIT_JOURNAL_PATH?.trim() || layout.journalPath,
    AGENTGIT_SNAPSHOT_ROOT: env.AGENTGIT_SNAPSHOT_ROOT?.trim() || layout.snapshotRootPath,
    AGENTGIT_MCP_REGISTRY_PATH: env.AGENTGIT_MCP_REGISTRY_PATH?.trim() || layout.mcpRegistryPath,
    AGENTGIT_MCP_SECRET_STORE_PATH: env.AGENTGIT_MCP_SECRET_STORE_PATH?.trim() || layout.mcpSecretStorePath,
    AGENTGIT_MCP_SECRET_KEY_PATH: env.AGENTGIT_MCP_SECRET_KEY_PATH?.trim() || layout.mcpSecretKeyPath,
    AGENTGIT_MCP_HOST_POLICY_PATH: env.AGENTGIT_MCP_HOST_POLICY_PATH?.trim() || layout.mcpHostPolicyPath,
    AGENTGIT_MCP_CONCURRENCY_LEASE_PATH:
      env.AGENTGIT_MCP_CONCURRENCY_LEASE_PATH?.trim() || layout.mcpConcurrencyLeasePath,
    AGENTGIT_MCP_HOSTED_WORKER_ENDPOINT:
      env.AGENTGIT_MCP_HOSTED_WORKER_ENDPOINT?.trim() || layout.mcpHostedWorkerEndpoint,
    AGENTGIT_MCP_HOSTED_WORKER_ATTESTATION_KEY_PATH:
      env.AGENTGIT_MCP_HOSTED_WORKER_ATTESTATION_KEY_PATH?.trim() || layout.mcpHostedWorkerAttestationKeyPath,
    AGENTGIT_POLICY_WORKSPACE_CONFIG_PATH:
      env.AGENTGIT_POLICY_WORKSPACE_CONFIG_PATH?.trim() || layout.policyWorkspaceConfigPath,
    AGENTGIT_POLICY_CALIBRATION_CONFIG_PATH:
      env.AGENTGIT_POLICY_CALIBRATION_CONFIG_PATH?.trim() || layout.policyCalibrationConfigPath,
  };
}

export async function runDaemonStartCommand(
  resolvedConfig: CliResolvedConfig,
): Promise<AuthorityDaemonListeningSummary> {
  const { runAuthorityDaemonFromEnv } = await loadAuthorityDaemonModule();
  Object.assign(process.env, buildDaemonRuntimeEnvironment(resolvedConfig));
  const daemon = await runAuthorityDaemonFromEnv({
    registerSignalHandlers: true,
  });
  return daemon.summary;
}
