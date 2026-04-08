import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { bootstrapLocalDaemon } from "./app/bootstrap.js";
import { type StartServerOptions } from "./stores/local-store-factory.js";
import { UnixSocketTransport, resolveUnixSocketAuthTokenPath } from "./transports/unix-socket.js";

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
  server: net.Server;
  shutdown: () => Promise<void>;
}

export function resolveAuthorityDaemonRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): AuthorityDaemonRuntimeConfig {
  const projectRoot = env.AGENTGIT_ROOT ?? env.INIT_CWD ?? cwd;
  const socketPath = env.AGENTGIT_SOCKET_PATH ?? path.resolve(projectRoot, ".agentgit", "authority.sock");
  const journalPath = env.AGENTGIT_JOURNAL_PATH ?? path.resolve(projectRoot, ".agentgit", "state", "authority.db");
  const snapshotRootPath = env.AGENTGIT_SNAPSHOT_ROOT ?? path.resolve(projectRoot, ".agentgit", "state", "snapshots");
  const mcpRegistryPath =
    env.AGENTGIT_MCP_REGISTRY_PATH ?? path.resolve(projectRoot, ".agentgit", "state", "mcp", "registry.db");
  const mcpSecretStorePath =
    env.AGENTGIT_MCP_SECRET_STORE_PATH ?? path.resolve(projectRoot, ".agentgit", "state", "mcp", "secret-store.db");
  const mcpSecretKeyPath =
    env.AGENTGIT_MCP_SECRET_KEY_PATH ?? path.resolve(projectRoot, ".agentgit", "state", "mcp", "secret-store.key");
  const mcpHostPolicyPath =
    env.AGENTGIT_MCP_HOST_POLICY_PATH ?? path.resolve(projectRoot, ".agentgit", "state", "mcp", "host-policies.db");
  const mcpConcurrencyLeasePath =
    env.AGENTGIT_MCP_CONCURRENCY_LEASE_PATH ??
    path.resolve(projectRoot, ".agentgit", "state", "mcp", "concurrency-leases.db");
  const mcpHostedWorkerEndpoint =
    env.AGENTGIT_MCP_HOSTED_WORKER_ENDPOINT ??
    `unix:${path.resolve(projectRoot, ".agentgit", "state", "mcp", "hosted-worker.sock")}`;
  const mcpHostedWorkerAutostart = env.AGENTGIT_MCP_HOSTED_WORKER_AUTOSTART !== "false";
  const mcpHostedWorkerControlToken = env.AGENTGIT_MCP_HOSTED_WORKER_CONTROL_TOKEN ?? undefined;
  const mcpHostedWorkerAttestationKeyPath =
    env.AGENTGIT_MCP_HOSTED_WORKER_ATTESTATION_KEY_PATH ??
    path.resolve(projectRoot, ".agentgit", "state", "mcp", "hosted-worker-attestation-key.json");
  const mcpHostedWorkerCommand = env.AGENTGIT_MCP_HOSTED_WORKER_COMMAND ?? undefined;
  const mcpHostedWorkerArgs = env.AGENTGIT_MCP_HOSTED_WORKER_ARGS?.trim().length
    ? env.AGENTGIT_MCP_HOSTED_WORKER_ARGS.split("\n").filter((entry) => entry.length > 0)
    : undefined;
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const policyGlobalConfigPath =
    env.AGENTGIT_POLICY_GLOBAL_CONFIG_PATH ??
    path.resolve(
      xdgConfigHome && xdgConfigHome.length > 0 ? xdgConfigHome : path.join(os.homedir(), ".config"),
      "agentgit",
      "authority-policy.toml",
    );
  const policyWorkspaceConfigPath =
    env.AGENTGIT_POLICY_WORKSPACE_CONFIG_PATH ?? path.resolve(projectRoot, ".agentgit", "policy.toml");
  const policyCalibrationConfigPath =
    env.AGENTGIT_POLICY_CALIBRATION_CONFIG_PATH ??
    path.resolve(projectRoot, ".agentgit", "policy.calibration.generated.json");
  const policyConfigPath = env.AGENTGIT_POLICY_CONFIG_PATH ?? undefined;
  const artifactRetentionMs =
    env.AGENTGIT_ARTIFACT_RETENTION_MS === undefined ? null : Number.parseInt(env.AGENTGIT_ARTIFACT_RETENTION_MS, 10);

  if (env.AGENTGIT_ARTIFACT_RETENTION_MS !== undefined && Number.isNaN(artifactRetentionMs)) {
    throw new Error("AGENTGIT_ARTIFACT_RETENTION_MS must be an integer number of milliseconds when provided.");
  }

  return {
    projectRoot,
    socketPath,
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
  };
}

function buildListeningSummary(config: AuthorityDaemonRuntimeConfig): AuthorityDaemonListeningSummary {
  return {
    status: "listening",
    socket_path: config.socketPath,
    journal_path: config.journalPath,
    snapshot_root_path: config.snapshotRootPath,
    mcp_registry_path: config.mcpRegistryPath,
    mcp_secret_store_path: config.mcpSecretStorePath,
    mcp_secret_key_path: config.mcpSecretKeyPath,
    mcp_host_policy_path: config.mcpHostPolicyPath,
    mcp_concurrency_lease_path: config.mcpConcurrencyLeasePath,
    mcp_hosted_worker_endpoint: config.mcpHostedWorkerEndpoint,
    mcp_hosted_worker_autostart: config.mcpHostedWorkerAutostart,
    mcp_hosted_worker_attestation_key_path: config.mcpHostedWorkerAttestationKeyPath,
    policy_global_config_path: config.policyGlobalConfigPath,
    policy_workspace_config_path: config.policyWorkspaceConfigPath,
    policy_calibration_config_path: config.policyCalibrationConfigPath,
    policy_config_path: config.policyConfigPath ?? null,
    artifact_retention_ms: config.artifactRetentionMs,
  };
}

export async function runAuthorityDaemon(
  config: AuthorityDaemonRuntimeConfig,
  options: RunAuthorityDaemonOptions = {},
): Promise<StartedAuthorityDaemon> {
  const startServerOptions: StartServerOptions = {
    socketPath: config.socketPath,
    workspaceRootPath: config.projectRoot,
    journalPath: config.journalPath,
    snapshotRootPath: config.snapshotRootPath,
    mcpRegistryPath: config.mcpRegistryPath,
    mcpSecretStorePath: config.mcpSecretStorePath,
    mcpSecretKeyPath: config.mcpSecretKeyPath,
    mcpHostPolicyPath: config.mcpHostPolicyPath,
    mcpConcurrencyLeasePath: config.mcpConcurrencyLeasePath,
    mcpHostedWorkerEndpoint: config.mcpHostedWorkerEndpoint,
    mcpHostedWorkerAutostart: config.mcpHostedWorkerAutostart,
    mcpHostedWorkerControlToken: config.mcpHostedWorkerControlToken,
    mcpHostedWorkerAttestationKeyPath: config.mcpHostedWorkerAttestationKeyPath,
    mcpHostedWorkerCommand: config.mcpHostedWorkerCommand,
    mcpHostedWorkerArgs: config.mcpHostedWorkerArgs,
    policyGlobalConfigPath: config.policyGlobalConfigPath,
    policyWorkspaceConfigPath: config.policyWorkspaceConfigPath,
    policyCalibrationConfigPath: config.policyCalibrationConfigPath,
    policyConfigPath: config.policyConfigPath,
    artifactRetentionMs: config.artifactRetentionMs,
  };

  const { service, cleanup } = await bootstrapLocalDaemon(startServerOptions);
  const unixTransport = new UnixSocketTransport({ socketPath: config.socketPath });
  await unixTransport.listen((request, context) => service.dispatch(request, context));
  const server = unixTransport.getServer()!;
  let cleanupPromise: Promise<void> | null = null;
  const runCleanup = (): Promise<void> => {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        service.close();
        await cleanup();
      })();
    }
    return cleanupPromise;
  };
  server.on("close", () => {
    void runCleanup();
  });

  const summary = buildListeningSummary(config);
  options.onListening?.(summary);

  let shuttingDown = false;
  const removeFileIfExists = (filePath: string) => {
    try {
      fs.rmSync(filePath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  };
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    await runCleanup();
    removeFileIfExists(config.socketPath);
    removeFileIfExists(resolveUnixSocketAuthTokenPath(config.socketPath));
  };

  if (options.registerSignalHandlers) {
    const handleSignal = () => {
      void shutdown()
        .then(() => {
          process.exit(0);
        })
        .catch((error) => {
          console.error(error instanceof Error ? error.message : String(error));
          process.exit(1);
        });
    };
    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
  }

  return {
    config,
    summary,
    server,
    shutdown,
  };
}

export async function runAuthorityDaemonFromEnv(
  options: RunAuthorityDaemonOptions = {},
): Promise<StartedAuthorityDaemon> {
  const config = resolveAuthorityDaemonRuntimeConfig(process.env, process.cwd());
  return runAuthorityDaemon(config, {
    ...options,
    onListening(summary) {
      process.stdout.write(`${JSON.stringify(summary)}\n`);
      options.onListening?.(summary);
    },
  });
}
