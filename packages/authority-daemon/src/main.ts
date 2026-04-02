import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startServer } from "./server.js";

const projectRoot = process.env.AGENTGIT_ROOT ?? process.env.INIT_CWD ?? process.cwd();
const socketPath = process.env.AGENTGIT_SOCKET_PATH ?? path.resolve(projectRoot, ".agentgit", "authority.sock");
const journalPath =
  process.env.AGENTGIT_JOURNAL_PATH ?? path.resolve(projectRoot, ".agentgit", "state", "authority.db");
const snapshotRootPath =
  process.env.AGENTGIT_SNAPSHOT_ROOT ?? path.resolve(projectRoot, ".agentgit", "state", "snapshots");
const mcpRegistryPath =
  process.env.AGENTGIT_MCP_REGISTRY_PATH ?? path.resolve(projectRoot, ".agentgit", "state", "mcp", "registry.db");
const mcpSecretStorePath =
  process.env.AGENTGIT_MCP_SECRET_STORE_PATH ??
  path.resolve(projectRoot, ".agentgit", "state", "mcp", "secret-store.db");
const mcpSecretKeyPath =
  process.env.AGENTGIT_MCP_SECRET_KEY_PATH ??
  path.resolve(projectRoot, ".agentgit", "state", "mcp", "secret-store.key");
const mcpHostPolicyPath =
  process.env.AGENTGIT_MCP_HOST_POLICY_PATH ??
  path.resolve(projectRoot, ".agentgit", "state", "mcp", "host-policies.db");
const mcpConcurrencyLeasePath =
  process.env.AGENTGIT_MCP_CONCURRENCY_LEASE_PATH ??
  path.resolve(projectRoot, ".agentgit", "state", "mcp", "concurrency-leases.db");
const mcpHostedWorkerEndpoint =
  process.env.AGENTGIT_MCP_HOSTED_WORKER_ENDPOINT ??
  `unix:${path.resolve(projectRoot, ".agentgit", "state", "mcp", "hosted-worker.sock")}`;
const mcpHostedWorkerAutostart = process.env.AGENTGIT_MCP_HOSTED_WORKER_AUTOSTART !== "false";
const mcpHostedWorkerControlToken = process.env.AGENTGIT_MCP_HOSTED_WORKER_CONTROL_TOKEN ?? undefined;
const mcpHostedWorkerAttestationKeyPath =
  process.env.AGENTGIT_MCP_HOSTED_WORKER_ATTESTATION_KEY_PATH ??
  path.resolve(projectRoot, ".agentgit", "state", "mcp", "hosted-worker-attestation-key.json");
const mcpHostedWorkerCommand = process.env.AGENTGIT_MCP_HOSTED_WORKER_COMMAND ?? undefined;
const mcpHostedWorkerArgs = process.env.AGENTGIT_MCP_HOSTED_WORKER_ARGS?.trim().length
  ? process.env.AGENTGIT_MCP_HOSTED_WORKER_ARGS.split("\n").filter((entry) => entry.length > 0)
  : undefined;
const xdgConfigHome = process.env.XDG_CONFIG_HOME?.trim();
const policyGlobalConfigPath =
  process.env.AGENTGIT_POLICY_GLOBAL_CONFIG_PATH ??
  path.resolve(
    xdgConfigHome && xdgConfigHome.length > 0 ? xdgConfigHome : path.join(os.homedir(), ".config"),
    "agentgit",
    "authority-policy.toml",
  );
const policyWorkspaceConfigPath =
  process.env.AGENTGIT_POLICY_WORKSPACE_CONFIG_PATH ?? path.resolve(projectRoot, ".agentgit", "policy.toml");
const policyCalibrationConfigPath =
  process.env.AGENTGIT_POLICY_CALIBRATION_CONFIG_PATH ??
  path.resolve(projectRoot, ".agentgit", "policy.calibration.generated.json");
const policyConfigPath = process.env.AGENTGIT_POLICY_CONFIG_PATH ?? undefined;
const artifactRetentionMs =
  process.env.AGENTGIT_ARTIFACT_RETENTION_MS === undefined
    ? null
    : Number.parseInt(process.env.AGENTGIT_ARTIFACT_RETENTION_MS, 10);

if (process.env.AGENTGIT_ARTIFACT_RETENTION_MS !== undefined && Number.isNaN(artifactRetentionMs)) {
  throw new Error("AGENTGIT_ARTIFACT_RETENTION_MS must be an integer number of milliseconds when provided.");
}

const server = await startServer({
  socketPath,
  workspaceRootPath: projectRoot,
  journalPath,
  snapshotRootPath,
  mcpRegistryPath,
  mcpSecretStorePath,
  mcpSecretKeyPath,
  mcpHostPolicyPath,
  mcpConcurrencyLeasePath,
  mcpHostedWorkerEndpoint,
  mcpHostedWorkerAutostart,
  mcpHostedWorkerControlToken,
  mcpHostedWorkerAttestationKeyPath,
  mcpHostedWorkerCommand,
  mcpHostedWorkerArgs,
  policyGlobalConfigPath,
  policyWorkspaceConfigPath,
  policyCalibrationConfigPath,
  policyConfigPath,
  artifactRetentionMs,
});

console.log(
  JSON.stringify({
    status: "listening",
    socket_path: socketPath,
    journal_path: journalPath,
    snapshot_root_path: snapshotRootPath,
    mcp_registry_path: mcpRegistryPath,
    mcp_secret_store_path: mcpSecretStorePath,
    mcp_secret_key_path: mcpSecretKeyPath,
    mcp_host_policy_path: mcpHostPolicyPath,
    mcp_concurrency_lease_path: mcpConcurrencyLeasePath,
    mcp_hosted_worker_endpoint: mcpHostedWorkerEndpoint,
    mcp_hosted_worker_autostart: mcpHostedWorkerAutostart,
    mcp_hosted_worker_attestation_key_path: mcpHostedWorkerAttestationKeyPath,
    policy_global_config_path: policyGlobalConfigPath,
    policy_workspace_config_path: policyWorkspaceConfigPath,
    policy_calibration_config_path: policyCalibrationConfigPath,
    policy_config_path: policyConfigPath ?? null,
    artifact_retention_ms: artifactRetentionMs,
  }),
);

const shutdown = () => {
  server.close(() => {
    if (fs.existsSync(socketPath)) {
      fs.rmSync(socketPath, { force: true });
    }
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
