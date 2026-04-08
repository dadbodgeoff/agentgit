import { createHash, randomUUID } from "node:crypto";
import path from "node:path";

import {
  AdapterRegistry,
  FilesystemExecutionAdapter,
  FunctionExecutionAdapter,
  McpExecutionAdapter,
  OwnedDraftStore,
  OwnedNoteStore,
  OwnedTicketIntegration,
  OwnedTicketStore,
  ShellExecutionAdapter,
} from "@agentgit/execution-adapters";
import { McpPublicHostPolicyRegistry, McpServerRegistry } from "@agentgit/mcp-registry";
import { createRunJournal } from "@agentgit/run-journal";
import { LocalSnapshotEngine } from "@agentgit/snapshot-engine";

import { type ServiceDependencies, type ServiceOptions } from "../app/types.js";
import { HostedExecutionQueue } from "../hosted-execution-queue.js";
import { HostedMcpWorkerClient } from "../hosted-worker-client.js";
import { loadPolicyRuntime } from "../policy-runtime.js";
import { AuthorityState } from "../state.js";
import { executeHostedDelegatedJobAttempt } from "../app/handlers/mcp.js";
import {
  createCredentialBroker,
  createMcpServerRegistryFromEnv,
  createOwnedCompensationRegistry,
} from "../app/authority-service.js";

export interface StartServerOptions {
  socketPath: string;
  workspaceRootPath?: string;
  journalPath: string;
  snapshotRootPath: string;
  mcpRegistryPath?: string;
  mcpSecretStorePath?: string;
  mcpSecretKeyPath?: string;
  mcpHostPolicyPath?: string;
  mcpConcurrencyLeasePath?: string;
  mcpHostedWorkerEndpoint?: string;
  mcpHostedWorkerAutostart?: boolean;
  mcpHostedWorkerControlToken?: string;
  mcpHostedWorkerAttestationKeyPath?: string;
  mcpHostedWorkerCommand?: string;
  mcpHostedWorkerArgs?: string[];
  policyGlobalConfigPath?: string | null;
  policyWorkspaceConfigPath?: string | null;
  policyCalibrationConfigPath?: string | null;
  policyConfigPath?: string | null;
  artifactRetentionMs?: number | null;
  capabilityRefreshStaleMs?: number | null;
}

export interface LocalStoreAssembly {
  deps: ServiceDependencies;
  serviceOptions: ServiceOptions;
  cleanup: () => Promise<void>;
}

export async function createLocalStores(options: StartServerOptions): Promise<LocalStoreAssembly> {
  const state = new AuthorityState();
  const journal = createRunJournal({
    dbPath: options.journalPath,
    artifactRetentionMs: options.artifactRetentionMs,
  });
  const adapterRegistry = new AdapterRegistry();
  const snapshotEngine = new LocalSnapshotEngine({
    rootDir: options.snapshotRootPath,
  });
  const integrationsDbPath = path.join(path.dirname(options.snapshotRootPath), "integrations", "state.db");
  const mcpRegistryPath =
    options.mcpRegistryPath ?? path.join(path.dirname(options.snapshotRootPath), "mcp", "registry.db");
  const mcpSecretStorePath =
    options.mcpSecretStorePath ?? path.join(path.dirname(options.snapshotRootPath), "mcp", "secret-store.db");
  const mcpSecretKeyPath =
    options.mcpSecretKeyPath ?? path.join(path.dirname(options.snapshotRootPath), "mcp", "secret-store.key");
  const mcpHostPolicyPath =
    options.mcpHostPolicyPath ?? path.join(path.dirname(options.snapshotRootPath), "mcp", "host-policies.db");
  const mcpConcurrencyLeasePath =
    options.mcpConcurrencyLeasePath ??
    path.join(path.dirname(options.snapshotRootPath), "mcp", "concurrency-leases.db");
  const mcpHostedWorkerEndpoint =
    options.mcpHostedWorkerEndpoint ??
    `unix:${path.join(path.dirname(options.snapshotRootPath), "mcp", "hosted-worker.sock")}`;
  const mcpHostedWorkerAttestationKeyPath =
    options.mcpHostedWorkerAttestationKeyPath ??
    path.join(path.dirname(options.snapshotRootPath), "mcp", "hosted-worker-attestation-key.json");
  const workspaceRootPath = options.workspaceRootPath ?? process.cwd();
  const policyGlobalConfigPath = options.policyGlobalConfigPath ?? null;
  const policyWorkspaceConfigPath =
    options.policyWorkspaceConfigPath ?? path.join(workspaceRootPath, ".agentgit", "policy.toml");
  const policyCalibrationConfigPath =
    options.policyCalibrationConfigPath ??
    path.join(workspaceRootPath, ".agentgit", "policy.calibration.generated.json");
  const policyConfigPath = options.policyConfigPath ?? null;
  const credentialBroker = createCredentialBroker({
    mcpSecretStorePath,
    mcpSecretKeyPath,
  });
  const publicHostPolicyRegistry = new McpPublicHostPolicyRegistry({
    dbPath: mcpHostPolicyPath,
  });
  const mcpRegistry = new McpServerRegistry({
    dbPath: mcpRegistryPath,
    publicHostPolicyRegistry,
  });
  const policyRuntime = loadPolicyRuntime({
    globalConfigPath: policyGlobalConfigPath,
    workspaceConfigPath: policyWorkspaceConfigPath,
    generatedConfigPath: policyCalibrationConfigPath,
    explicitConfigPath: policyConfigPath,
  });
  const hostedWorkerClient = new HostedMcpWorkerClient({
    endpoint: mcpHostedWorkerEndpoint,
    autostart: options.mcpHostedWorkerAutostart ?? true,
    controlToken:
      options.mcpHostedWorkerControlToken ??
      ((options.mcpHostedWorkerAutostart ?? true)
        ? createHash("sha256").update(`${process.pid}:${Date.now()}:${options.socketPath}`).digest("hex")
        : null),
    attestationKeyPath: mcpHostedWorkerAttestationKeyPath,
    command: options.mcpHostedWorkerCommand,
    args: options.mcpHostedWorkerArgs,
  });
  const hostedExecutionQueue = new HostedExecutionQueue({
    registry: mcpRegistry,
    instanceId: `daemon:${process.pid}:${randomUUID()}`,
    onTerminalFailure: (job, error) => {
      const now = new Date().toISOString();
      journal.appendRunEvent(job.run_id, {
        event_type: "mcp_hosted_job_dead_lettered",
        occurred_at: now,
        recorded_at: now,
        payload: {
          action_id: job.action_id,
          job_id: job.job_id,
          server_profile_id: job.server_profile_id,
          tool_name: job.tool_name,
          attempt_count: job.attempt_count,
          max_attempts: job.max_attempts,
          current_lease_id: job.current_lease_id,
          error_code: error.code,
          error_message: error.message,
          retryable: error.retryable,
        },
      });
    },
    processor: (job, signalHeartbeat, cancelSignal) =>
      executeHostedDelegatedJobAttempt({
        job,
        broker: credentialBroker,
        mcpRegistry,
        journal,
        hostedWorkerClient,
        signalHeartbeat,
        cancelSignal,
      }),
  });
  await hostedWorkerClient.warmup().catch(() => undefined);
  const bootstrapMcpServers = createMcpServerRegistryFromEnv();
  mcpRegistry.bootstrapServers(bootstrapMcpServers);
  const draftStore = new OwnedDraftStore(integrationsDbPath);
  const noteStore = new OwnedNoteStore(integrationsDbPath);
  const ticketStore = new OwnedTicketStore(integrationsDbPath);
  const ticketIntegration = new OwnedTicketIntegration(ticketStore, credentialBroker);
  const compensationRegistry = createOwnedCompensationRegistry(draftStore, noteStore, ticketIntegration);

  adapterRegistry.register(new FilesystemExecutionAdapter());
  adapterRegistry.register(new ShellExecutionAdapter());
  adapterRegistry.register(
    new McpExecutionAdapter(mcpRegistry, {
      credentialBroker,
      publicHostPolicyRegistry,
      concurrencyLeaseDbPath: mcpConcurrencyLeasePath,
    }),
  );
  adapterRegistry.register(new FunctionExecutionAdapter(draftStore, noteStore, ticketIntegration));

  return {
    deps: {
      state,
      journal,
      adapterRegistry,
      snapshotEngine,
      compensationRegistry,
      broker: credentialBroker,
      mcpRegistry,
      publicHostPolicyRegistry,
      hostedWorkerClient,
      hostedExecutionQueue,
      policyRuntime,
      draftStore,
      noteStore,
      ticketStore,
    },
    serviceOptions: {
      socketPath: options.socketPath,
      journalPath: options.journalPath,
      snapshotRootPath: options.snapshotRootPath,
      capabilityRefreshStaleMs: options.capabilityRefreshStaleMs ?? null,
      mcpConcurrencyLeasePath,
      policyGlobalConfigPath,
      policyWorkspaceConfigPath,
      policyCalibrationConfigPath,
      policyConfigPath,
    },
    cleanup: async () => {
      hostedExecutionQueue.close();
      await hostedWorkerClient.close();
      draftStore.close();
      noteStore.close();
      ticketStore.close();
      mcpRegistry.close();
      journal.close();
    },
  };
}
