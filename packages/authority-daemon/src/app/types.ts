import type { SessionCredentialBroker } from "@agentgit/credential-broker";
import type { AdapterRegistry, OwnedDraftStore, OwnedNoteStore, OwnedTicketStore } from "@agentgit/execution-adapters";
import type { McpPublicHostPolicyRegistry, McpServerRegistry } from "@agentgit/mcp-registry";
import type { StaticCompensationRegistry } from "@agentgit/recovery-engine";
import type { RunJournal } from "@agentgit/run-journal";
import type { LocalSnapshotEngine } from "@agentgit/snapshot-engine";

import type { HostedExecutionQueue } from "../hosted-execution-queue.js";
import type { HostedMcpWorkerClient } from "../hosted-worker-client.js";
import type { LatencyMetricsStore } from "../latency-metrics.js";
import type { PolicyRuntimeState } from "../policy-runtime.js";
import type { AuthorityState } from "../state.js";

export interface ServiceDependencies {
  state: AuthorityState;
  journal: RunJournal;
  adapterRegistry: AdapterRegistry;
  snapshotEngine: LocalSnapshotEngine;
  compensationRegistry: StaticCompensationRegistry;
  broker: SessionCredentialBroker;
  mcpRegistry: McpServerRegistry;
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry;
  hostedWorkerClient: HostedMcpWorkerClient;
  hostedExecutionQueue: HostedExecutionQueue;
  latencyMetrics: LatencyMetricsStore;
  policyRuntime: PolicyRuntimeState;
  draftStore: OwnedDraftStore;
  noteStore: OwnedNoteStore;
  ticketStore: OwnedTicketStore;
}

export interface ServiceOptions {
  socketPath: string;
  journalPath: string;
  snapshotRootPath: string;
  capabilityRefreshStaleMs: number | null;
  mcpConcurrencyLeasePath: string;
  policyGlobalConfigPath: string | null;
  policyWorkspaceConfigPath: string | null;
  policyCalibrationConfigPath: string | null;
  policyConfigPath: string | null;
}
