import fs from "node:fs";
import path from "node:path";

import { startServer } from "./server.js";

const projectRoot = process.env.AGENTGIT_ROOT ?? process.env.INIT_CWD ?? process.cwd();
const socketPath = process.env.AGENTGIT_SOCKET_PATH ?? path.resolve(projectRoot, ".agentgit", "authority.sock");
const journalPath = process.env.AGENTGIT_JOURNAL_PATH ?? path.resolve(projectRoot, ".agentgit", "state", "authority.db");
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
const artifactRetentionMs =
  process.env.AGENTGIT_ARTIFACT_RETENTION_MS === undefined
    ? null
    : Number.parseInt(process.env.AGENTGIT_ARTIFACT_RETENTION_MS, 10);

if (process.env.AGENTGIT_ARTIFACT_RETENTION_MS !== undefined && Number.isNaN(artifactRetentionMs)) {
  throw new Error("AGENTGIT_ARTIFACT_RETENTION_MS must be an integer number of milliseconds when provided.");
}

const server = await startServer({
  socketPath,
  journalPath,
  snapshotRootPath,
  mcpRegistryPath,
  mcpSecretStorePath,
  mcpSecretKeyPath,
  mcpHostPolicyPath,
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
