import fs from "node:fs";
import path from "node:path";

import type { RequestContext } from "@agentgit/core-ports";
import {
  createFileBackedSecretKeyProvider,
  LocalEncryptedSecretStore,
  SessionCredentialBroker,
  type SecretKeyProvider,
} from "@agentgit/credential-broker";
import {
  AdapterRegistry,
  OwnedDraftStore,
  OwnedNoteStore,
  OwnedTicketIntegration,
  OwnedTicketStore,
  parseDraftLabelLocator,
  parseDraftLocator,
  parseNoteLocator,
  parseTicketAssigneeLocator,
  parseTicketLabelLocator,
  parseTicketLocator,
} from "@agentgit/execution-adapters";
import { McpPublicHostPolicyRegistry, McpServerRegistry, validateMcpServerDefinitions } from "@agentgit/mcp-registry";
import { recommendPolicyThresholds, validatePolicyConfigDocument } from "@agentgit/policy-engine";
import { type CachedCapabilityState, StaticCompensationRegistry } from "@agentgit/recovery-engine";
import type { RunJournal } from "@agentgit/run-journal";
import { answerHelperQuery, projectTimelineView } from "@agentgit/timeline-helper";
import {
  AgentGitError,
  type DaemonMethod,
  type HelperQuestionType,
  InternalError,
  type QueryHelperResponsePayload,
  RunMaintenanceRequestPayloadSchema,
  type RunMaintenanceResponsePayload,
  NotFoundError,
  McpServerDefinitionSchema,
  type McpServerDefinition,
  PreconditionError,
  type RequestEnvelope,
  RequestEnvelopeSchema,
  type ResponseEnvelope,
  type TimelineStep,
  ValidationError,
  validate,
  type VisibilityScope,
} from "@agentgit/schemas";
import { LocalSnapshotEngine } from "@agentgit/snapshot-engine";
import { handleSubmitActionAttempt as handleSubmitActionAttemptFlow } from "../handlers/submit-action.js";
import { HostedExecutionQueue } from "../hosted-execution-queue.js";
import { HostedMcpWorkerClient } from "../hosted-worker-client.js";
import { reloadPolicyRuntime, type LoadPolicyRuntimeOptions, type PolicyRuntimeState } from "../policy-runtime.js";
import { makeErrorResponse, makeSuccessResponse, replayStoredSuccessResponse } from "./response-helpers.js";
import { getRequestContext as getRequestContextFromHelpers } from "./request-helpers.js";
import type { ServiceDependencies, ServiceOptions } from "./types.js";
import { canUseIdempotency as canUseIdempotencyHelper } from "./idempotency.js";
import {
  handleListApprovals as handleListApprovalsHandler,
  handleQueryApprovalInbox as handleQueryApprovalInboxHandler,
  handleResolveApproval as handleResolveApprovalHandler,
} from "./handlers/approvals.js";
import {
  handleGetEffectivePolicy as handleGetEffectivePolicyHandler,
  handleExplainPolicyAction as handleExplainPolicyActionHandler,
  handleGetPolicyCalibrationReport as handleGetPolicyCalibrationReportHandler,
  handleGetPolicyThresholdRecommendations as handleGetPolicyThresholdRecommendationsHandler,
  handleHello as handleHelloHandler,
  handleRegisterRun as handleRegisterRunHandler,
  handleReplayPolicyThresholds as handleReplayPolicyThresholdsHandler,
  handleValidatePolicyConfig as handleValidatePolicyConfigHandler,
} from "./handlers/policy.js";
import {
  handleCreateRunCheckpoint as handleCreateRunCheckpointHandler,
  handleGetRunSummary as handleGetRunSummaryHandler,
} from "./handlers/run.js";
import {
  detectCapabilities as detectCapabilitiesHandler,
  handleDiagnostics as handleDiagnosticsHandler,
  handleGetCapabilities as handleGetCapabilitiesHandler,
} from "./handlers/session.js";
import {
  handleQueryArtifact as handleQueryArtifactHandler,
  handleQueryHelper as handleQueryHelperHandler,
  handleQueryTimeline as handleQueryTimelineHandler,
} from "./handlers/timeline.js";
import {
  handleExecuteRecovery as handleExecuteRecoveryHandler,
  handlePlanRecovery as handlePlanRecoveryHandler,
} from "./handlers/recovery.js";
import {
  executeHostedDelegatedMcpAction,
  handleActivateMcpServerProfile,
  handleApproveMcpServerProfile,
  handleBindMcpServerCredentials,
  handleCancelHostedMcpJob,
  handleGetHostedMcpJob,
  handleGetMcpServerReview,
  handleListHostedMcpJobs,
  handleListMcpHostPolicies,
  handleListMcpSecrets,
  handleListMcpServerCandidates,
  handleListMcpServerCredentialBindings,
  handleListMcpServerProfiles,
  handleListMcpServers,
  handleListMcpServerTrustDecisions,
  handleQuarantineMcpServerProfile,
  handleRemoveMcpHostPolicy,
  handleRemoveMcpSecret,
  handleRemoveMcpServer,
  handleRequeueHostedMcpJob,
  handleResolveMcpServerCandidate,
  handleRevokeMcpServerCredentials,
  handleRevokeMcpServerProfile,
  handleSubmitMcpServerCandidate,
  handleUpsertMcpHostPolicy,
  handleUpsertMcpSecret,
  handleUpsertMcpServer,
} from "./handlers/mcp.js";
import { AuthorityState } from "../state.js";
import type { LatencyMetricsStore } from "../latency-metrics.js";

const METHODS: DaemonMethod[] = [
  "hello",
  "register_run",
  "get_run_summary",
  "get_capabilities",
  "get_effective_policy",
  "validate_policy_config",
  "get_policy_calibration_report",
  "explain_policy_action",
  "get_policy_threshold_recommendations",
  "replay_policy_thresholds",
  "list_mcp_servers",
  "list_mcp_server_candidates",
  "submit_mcp_server_candidate",
  "list_mcp_server_profiles",
  "resolve_mcp_server_candidate",
  "list_mcp_server_trust_decisions",
  "approve_mcp_server_profile",
  "list_mcp_server_credential_bindings",
  "bind_mcp_server_credentials",
  "revoke_mcp_server_credentials",
  "activate_mcp_server_profile",
  "quarantine_mcp_server_profile",
  "revoke_mcp_server_profile",
  "upsert_mcp_server",
  "remove_mcp_server",
  "list_mcp_secrets",
  "upsert_mcp_secret",
  "remove_mcp_secret",
  "list_mcp_host_policies",
  "upsert_mcp_host_policy",
  "remove_mcp_host_policy",
  "get_hosted_mcp_job",
  "list_hosted_mcp_jobs",
  "requeue_hosted_mcp_job",
  "cancel_hosted_mcp_job",
  "get_mcp_server_review",
  "diagnostics",
  "run_maintenance",
  "submit_action_attempt",
  "list_approvals",
  "query_approval_inbox",
  "resolve_approval",
  "query_timeline",
  "query_helper",
  "query_artifact",
  "plan_recovery",
  "execute_recovery",
];
const IDEMPOTENT_MUTATION_METHODS = new Set<DaemonMethod>([
  "register_run",
  "submit_mcp_server_candidate",
  "resolve_mcp_server_candidate",
  "approve_mcp_server_profile",
  "bind_mcp_server_credentials",
  "revoke_mcp_server_credentials",
  "activate_mcp_server_profile",
  "quarantine_mcp_server_profile",
  "revoke_mcp_server_profile",
  "upsert_mcp_server",
  "remove_mcp_server",
  "upsert_mcp_secret",
  "remove_mcp_secret",
  "upsert_mcp_host_policy",
  "remove_mcp_host_policy",
  "requeue_hosted_mcp_job",
  "cancel_hosted_mcp_job",
  "run_maintenance",
  "submit_action_attempt",
  "resolve_approval",
  "execute_recovery",
]);
const RUNTIME_VERSION = "0.1.0";

const CAPABILITY_REFRESH_STALE_MS = 5 * 60 * 1_000;
const HELPER_FACT_WARM_VISIBILITY_SCOPES: VisibilityScope[] = ["user", "model", "internal", "sensitive_internal"];
const HELPER_FACT_WARM_RUN_QUESTIONS: HelperQuestionType[] = [
  "run_summary",
  "what_happened",
  "reversible_steps",
  "why_blocked",
  "likely_cause",
  "suggest_likely_cause",
  "identify_external_effects",
  "external_side_effects",
];
const HELPER_FACT_WARM_STEP_QUESTIONS: HelperQuestionType[] = [
  "step_details",
  "explain_policy_decision",
  "summarize_after_boundary",
  "what_changed_after_step",
  "revert_impact",
  "preview_revert_loss",
  "what_would_i_lose_if_i_revert_here",
  "list_actions_touching_scope",
];
const POLICY_CALIBRATION_MIN_SAMPLES = 5;

interface HelperProjectionContext {
  visibility_scope: VisibilityScope;
  redactions_applied: number;
  preview_budget: QueryHelperResponsePayload["preview_budget"];
  steps: TimelineStep[];
  unavailable_artifacts_present: boolean;
  artifact_state_digest: string;
}

function resolveCapabilityRefreshStaleMs(options?: { capabilityRefreshStaleMs?: number | null }): number {
  if (typeof options?.capabilityRefreshStaleMs === "number") {
    return Math.max(0, options.capabilityRefreshStaleMs);
  }

  const configured = process.env.AGENTGIT_CAPABILITY_REFRESH_STALE_MS?.trim();
  if (!configured) {
    return CAPABILITY_REFRESH_STALE_MS;
  }

  const parsed = Number.parseInt(configured, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new InternalError("Capability refresh stale threshold must be a non-negative integer.", {
      configured_value: configured,
      env_var: "AGENTGIT_CAPABILITY_REFRESH_STALE_MS",
    });
  }

  return parsed;
}

function buildCachedCapabilityState(
  journal: RunJournal,
  runtimeOptions: { capabilityRefreshStaleMs?: number | null },
): CachedCapabilityState | null {
  const capabilitySnapshot = journal.getCapabilitySnapshot();
  if (capabilitySnapshot === null) {
    return null;
  }

  const capabilityRefreshStaleMs = resolveCapabilityRefreshStaleMs(runtimeOptions);
  const refreshedAtMillis = Date.parse(capabilitySnapshot.refreshed_at);

  return {
    capabilities: capabilitySnapshot.capabilities,
    degraded_mode_warnings: capabilitySnapshot.degraded_mode_warnings,
    refreshed_at: capabilitySnapshot.refreshed_at,
    stale_after_ms: capabilityRefreshStaleMs,
    is_stale: !Number.isNaN(refreshedAtMillis) && Date.now() - refreshedAtMillis > capabilityRefreshStaleMs,
  };
}

export function createCredentialBroker(
  options: {
    env?: NodeJS.ProcessEnv;
    mcpSecretStorePath?: string;
    mcpSecretKeyPath?: string;
    mcpSecretKeyProvider?: SecretKeyProvider;
  } = {},
): SessionCredentialBroker {
  const env = options.env ?? process.env;
  let mcpSecretStore: LocalEncryptedSecretStore | null = null;
  if (options.mcpSecretStorePath && options.mcpSecretKeyPath) {
    try {
      mcpSecretStore = new LocalEncryptedSecretStore({
        dbPath: options.mcpSecretStorePath,
        keyPath: options.mcpSecretKeyPath,
        keyProvider: options.mcpSecretKeyProvider,
      });
    } catch (error) {
      if (!(error instanceof AgentGitError) || error.code !== "BROKER_UNAVAILABLE") {
        throw error;
      }

      mcpSecretStore = new LocalEncryptedSecretStore({
        dbPath: options.mcpSecretStorePath,
        keyPath: options.mcpSecretKeyPath,
        keyProvider: options.mcpSecretKeyProvider ?? createFileBackedSecretKeyProvider(),
      });
    }
  }
  const broker = new SessionCredentialBroker({
    mcpSecretStore,
  });
  const ticketsBaseUrl = env.AGENTGIT_TICKETS_BASE_URL?.trim() ?? "";
  const ticketsToken = env.AGENTGIT_TICKETS_BEARER_TOKEN?.trim() ?? "";

  if (ticketsBaseUrl.length === 0 && ticketsToken.length === 0) {
    return broker;
  }

  if (ticketsBaseUrl.length === 0 || ticketsToken.length === 0) {
    throw new InternalError("Tickets broker configuration is incomplete.", {
      requires: ["AGENTGIT_TICKETS_BASE_URL", "AGENTGIT_TICKETS_BEARER_TOKEN"],
    });
  }

  broker.registerBearerProfile({
    integration: "tickets",
    profile_id: "credprof_tickets",
    base_url: ticketsBaseUrl,
    token: ticketsToken,
    scopes: ["tickets:write"],
  });
  return broker;
}

export function createMcpServerRegistryFromEnv(env: NodeJS.ProcessEnv = process.env): McpServerDefinition[] {
  const rawConfig = env.AGENTGIT_MCP_SERVERS_JSON?.trim() ?? "";
  if (rawConfig.length === 0) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawConfig);
  } catch (error) {
    throw new InternalError("MCP server registry configuration is not valid JSON.", {
      env_var: "AGENTGIT_MCP_SERVERS_JSON",
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    return validateMcpServerDefinitions(validate(McpServerDefinitionSchema.array(), parsed));
  } catch (error) {
    if (error instanceof AgentGitError) {
      throw new InternalError(error.message, {
        env_var: "AGENTGIT_MCP_SERVERS_JSON",
        ...(error.details ?? {}),
      });
    }

    throw error;
  }
}

export function createOwnedCompensationRegistry(
  draftStore: OwnedDraftStore,
  noteStore: OwnedNoteStore,
  ticketIntegration: OwnedTicketIntegration,
): StaticCompensationRegistry {
  return new StaticCompensationRegistry([
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          (manifest.operation_kind === "update_ticket" || manifest.operation_kind === "restore_ticket") &&
          manifest.target_path.startsWith("tickets://issue/") &&
          Boolean(manifest.captured_preimage)
        );
      },
      buildCandidate({ manifest }) {
        const ticketId = parseTicketLocator(manifest.target_path) ?? `ticket_${manifest.action_id}`;

        return {
          strategy: "restore_owned_ticket_preimage",
          confidence: 0.84,
          steps: [
            {
              step_id: `step_restore_ticket_${ticketId}`,
              type: "restore_owned_ticket_preimage",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["ticket_restore"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned tickets integration"],
            objects_touched: [manifest.target_path],
            manual_steps: [
              "Verify the external ticket status, title, body, labels, and assignees match the captured preimage after recovery executes.",
            ],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const ticketId = parseTicketLocator(manifest.target_path) ?? `ticket_${manifest.action_id}`;
        if (!manifest.captured_preimage) {
          throw new PreconditionError("Owned ticket update recovery requires captured preimage metadata.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            ticket_id: ticketId,
          });
        }

        await ticketIntegration.restoreTicketFromSnapshot(ticketId, manifest.captured_preimage);
        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "delete_ticket" &&
          manifest.target_path.startsWith("tickets://issue/") &&
          Boolean(manifest.captured_preimage)
        );
      },
      buildCandidate({ manifest }) {
        const ticketId = parseTicketLocator(manifest.target_path) ?? `ticket_${manifest.action_id}`;

        return {
          strategy: "restore_owned_ticket_preimage",
          confidence: 0.85,
          steps: [
            {
              step_id: `step_restore_deleted_ticket_${ticketId}`,
              type: "restore_owned_ticket_preimage",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["ticket_restore"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned tickets integration"],
            objects_touched: [manifest.target_path],
            manual_steps: [
              "Verify the external ticket has been recreated with its prior status, labels, and assignees after recovery executes.",
            ],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const ticketId = parseTicketLocator(manifest.target_path) ?? `ticket_${manifest.action_id}`;
        if (!manifest.captured_preimage) {
          throw new PreconditionError("Owned ticket delete recovery requires captured preimage metadata.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            ticket_id: ticketId,
          });
        }

        await ticketIntegration.restoreTicketFromSnapshot(ticketId, manifest.captured_preimage);
        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "create_ticket" &&
          manifest.target_path.startsWith("tickets://issue/")
        );
      },
      buildCandidate({ manifest }) {
        const ticketId = parseTicketLocator(manifest.target_path) ?? `ticket_${manifest.action_id}`;

        return {
          strategy: "delete_owned_ticket",
          confidence: 0.83,
          steps: [
            {
              step_id: `step_delete_ticket_${ticketId}`,
              type: "delete_owned_ticket",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["ticket_delete"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned tickets integration"],
            objects_touched: [manifest.target_path],
            manual_steps: ["Verify the external ticket no longer exists after recovery executes."],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const ticketId = parseTicketLocator(manifest.target_path) ?? `ticket_${manifest.action_id}`;
        await ticketIntegration.deleteTicket(ticketId);
        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "close_ticket" &&
          manifest.target_path.startsWith("tickets://issue/")
        );
      },
      buildCandidate({ manifest }) {
        const ticketId = parseTicketLocator(manifest.target_path) ?? `ticket_${manifest.action_id}`;

        return {
          strategy: "reopen_owned_ticket",
          confidence: 0.82,
          steps: [
            {
              step_id: `step_reopen_ticket_${ticketId}`,
              type: "reopen_owned_ticket",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["ticket_reopen"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned tickets integration"],
            objects_touched: [manifest.target_path],
            manual_steps: ["Verify the external ticket is active again after recovery executes."],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const ticketId = parseTicketLocator(manifest.target_path) ?? `ticket_${manifest.action_id}`;
        await ticketIntegration.reopenTicket(ticketId);
        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "reopen_ticket" &&
          manifest.target_path.startsWith("tickets://issue/")
        );
      },
      buildCandidate({ manifest }) {
        const ticketId = parseTicketLocator(manifest.target_path) ?? `ticket_${manifest.action_id}`;

        return {
          strategy: "close_owned_ticket",
          confidence: 0.82,
          steps: [
            {
              step_id: `step_close_ticket_${ticketId}`,
              type: "close_owned_ticket",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["ticket_close"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned tickets integration"],
            objects_touched: [manifest.target_path],
            manual_steps: ["Verify the external ticket is closed after recovery executes."],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const ticketId = parseTicketLocator(manifest.target_path) ?? `ticket_${manifest.action_id}`;
        await ticketIntegration.closeTicket(ticketId);
        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "add_label" &&
          Boolean(parseTicketLabelLocator(manifest.target_path))
        );
      },
      buildCandidate({ manifest }) {
        const labelTarget = parseTicketLabelLocator(manifest.target_path);
        const ticketId = labelTarget?.ticketId ?? `ticket_${manifest.action_id}`;
        const label = labelTarget?.label ?? "unknown";

        return {
          strategy: "remove_owned_ticket_label",
          confidence: 0.88,
          steps: [
            {
              step_id: `step_remove_ticket_label_${ticketId}`,
              type: "remove_owned_ticket_label",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["ticket_label_remove"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned tickets integration"],
            objects_touched: [manifest.target_path],
            manual_steps: [`Verify label "${label}" is absent from the external ticket after recovery executes.`],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const labelTarget = parseTicketLabelLocator(manifest.target_path);
        if (!labelTarget) {
          throw new PreconditionError("Owned ticket label recovery requires a concrete label target.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            target_path: manifest.target_path,
          });
        }

        await ticketIntegration.removeLabel(labelTarget.ticketId, labelTarget.label);
        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "remove_label" &&
          Boolean(parseTicketLabelLocator(manifest.target_path))
        );
      },
      buildCandidate({ manifest }) {
        const labelTarget = parseTicketLabelLocator(manifest.target_path);
        const ticketId = labelTarget?.ticketId ?? `ticket_${manifest.action_id}`;
        const label = labelTarget?.label ?? "unknown";

        return {
          strategy: "add_owned_ticket_label",
          confidence: 0.88,
          steps: [
            {
              step_id: `step_add_ticket_label_${ticketId}`,
              type: "add_owned_ticket_label",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["ticket_label_add"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned tickets integration"],
            objects_touched: [manifest.target_path],
            manual_steps: [`Verify label "${label}" is present on the external ticket after recovery executes.`],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const labelTarget = parseTicketLabelLocator(manifest.target_path);
        if (!labelTarget) {
          throw new PreconditionError("Owned ticket label removal recovery requires a concrete label target.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            target_path: manifest.target_path,
          });
        }

        await ticketIntegration.addLabel(labelTarget.ticketId, labelTarget.label);
        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "assign_user" &&
          Boolean(parseTicketAssigneeLocator(manifest.target_path))
        );
      },
      buildCandidate({ manifest }) {
        const assigneeTarget = parseTicketAssigneeLocator(manifest.target_path);
        const ticketId = assigneeTarget?.ticketId ?? `ticket_${manifest.action_id}`;
        const userId = assigneeTarget?.userId ?? "unknown";

        return {
          strategy: "unassign_owned_ticket_user",
          confidence: 0.88,
          steps: [
            {
              step_id: `step_unassign_ticket_user_${ticketId}`,
              type: "unassign_owned_ticket_user",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["ticket_user_unassign"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned tickets integration"],
            objects_touched: [manifest.target_path],
            manual_steps: [
              `Verify user "${userId}" is no longer assigned to the external ticket after recovery executes.`,
            ],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const assigneeTarget = parseTicketAssigneeLocator(manifest.target_path);
        if (!assigneeTarget) {
          throw new PreconditionError("Owned ticket assignment recovery requires a concrete assignee target.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            target_path: manifest.target_path,
          });
        }

        await ticketIntegration.unassignUser(assigneeTarget.ticketId, assigneeTarget.userId);
        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "unassign_user" &&
          Boolean(parseTicketAssigneeLocator(manifest.target_path))
        );
      },
      buildCandidate({ manifest }) {
        const assigneeTarget = parseTicketAssigneeLocator(manifest.target_path);
        const ticketId = assigneeTarget?.ticketId ?? `ticket_${manifest.action_id}`;
        const userId = assigneeTarget?.userId ?? "unknown";

        return {
          strategy: "assign_owned_ticket_user",
          confidence: 0.88,
          steps: [
            {
              step_id: `step_assign_ticket_user_${ticketId}`,
              type: "assign_owned_ticket_user",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["ticket_user_assign"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned tickets integration"],
            objects_touched: [manifest.target_path],
            manual_steps: [`Verify user "${userId}" is assigned to the external ticket after recovery executes.`],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const assigneeTarget = parseTicketAssigneeLocator(manifest.target_path);
        if (!assigneeTarget) {
          throw new PreconditionError("Owned ticket unassignment recovery requires a concrete assignee target.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            target_path: manifest.target_path,
          });
        }

        await ticketIntegration.assignUser(assigneeTarget.ticketId, assigneeTarget.userId);
        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "create_note" &&
          manifest.target_path.startsWith("notes://workspace_note/")
        );
      },
      buildCandidate({ manifest }) {
        const noteId = parseNoteLocator(manifest.target_path) ?? `note_${manifest.action_id}`;

        return {
          strategy: "archive_owned_note",
          confidence: 0.79,
          steps: [
            {
              step_id: `step_archive_note_${noteId}`,
              type: "archive_owned_note",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["note_archive"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned notes integration"],
            objects_touched: [manifest.target_path],
            manual_steps: ["Verify the workspace note is archived in the owned notes store after recovery executes."],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const noteId = parseNoteLocator(manifest.target_path) ?? `note_${manifest.action_id}`;
        const archived = await noteStore.archiveNote(noteId);
        if (!archived) {
          throw new NotFoundError("Owned note no longer exists for compensating recovery.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            note_id: noteId,
          });
        }

        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "archive_note" &&
          manifest.target_path.startsWith("notes://workspace_note/")
        );
      },
      buildCandidate({ manifest }) {
        const noteId = parseNoteLocator(manifest.target_path) ?? `note_${manifest.action_id}`;

        return {
          strategy: "unarchive_owned_note",
          confidence: 0.8,
          steps: [
            {
              step_id: `step_unarchive_note_${noteId}`,
              type: "unarchive_owned_note",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["note_unarchive"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned notes integration"],
            objects_touched: [manifest.target_path],
            manual_steps: ["Verify the workspace note returns to active status after recovery executes."],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const noteId = parseNoteLocator(manifest.target_path) ?? `note_${manifest.action_id}`;
        const unarchived = await noteStore.unarchiveNote(noteId);
        if (!unarchived) {
          throw new NotFoundError("Owned note no longer exists for compensating recovery.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            note_id: noteId,
          });
        }

        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "unarchive_note" &&
          manifest.target_path.startsWith("notes://workspace_note/")
        );
      },
      buildCandidate({ manifest }) {
        const noteId = parseNoteLocator(manifest.target_path) ?? `note_${manifest.action_id}`;

        return {
          strategy: "archive_owned_note",
          confidence: 0.8,
          steps: [
            {
              step_id: `step_archive_note_${noteId}`,
              type: "archive_owned_note",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["note_archive"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned notes integration"],
            objects_touched: [manifest.target_path],
            manual_steps: ["Verify the workspace note is archived after recovery executes."],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const noteId = parseNoteLocator(manifest.target_path) ?? `note_${manifest.action_id}`;
        const archived = await noteStore.archiveNote(noteId);
        if (!archived) {
          throw new NotFoundError("Owned note no longer exists for compensating recovery.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            note_id: noteId,
          });
        }

        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          (manifest.operation_kind === "update_note" ||
            manifest.operation_kind === "restore_note" ||
            manifest.operation_kind === "delete_note") &&
          manifest.target_path.startsWith("notes://workspace_note/") &&
          Boolean(manifest.captured_preimage)
        );
      },
      buildCandidate({ manifest }) {
        const noteId = parseNoteLocator(manifest.target_path) ?? `note_${manifest.action_id}`;

        return {
          strategy: "restore_owned_note_preimage",
          confidence: 0.84,
          steps: [
            {
              step_id: `step_restore_note_${noteId}`,
              type: "restore_owned_note_preimage",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["note_restore"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned notes integration"],
            objects_touched: [manifest.target_path],
            manual_steps: [
              "Verify the workspace note title and body match the pre-update version after recovery executes.",
            ],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const noteId = parseNoteLocator(manifest.target_path) ?? `note_${manifest.action_id}`;
        if (!manifest.captured_preimage) {
          throw new PreconditionError("Owned note recovery requires captured preimage metadata.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            note_id: noteId,
          });
        }

        await noteStore.restoreNoteFromSnapshot(noteId, manifest.captured_preimage);
        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "add_label" &&
          Boolean(parseDraftLabelLocator(manifest.target_path))
        );
      },
      buildCandidate({ manifest }) {
        const labelTarget = parseDraftLabelLocator(manifest.target_path);
        const draftId = labelTarget?.draftId ?? `draft_${manifest.action_id}`;
        const label = labelTarget?.label ?? "unknown";

        return {
          strategy: "remove_owned_draft_label",
          confidence: 0.89,
          steps: [
            {
              step_id: `step_remove_label_${draftId}`,
              type: "remove_owned_draft_label",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["draft_label_remove"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned drafts integration"],
            objects_touched: [manifest.target_path],
            manual_steps: [`Verify label "${label}" is absent from the owned draft after recovery executes.`],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const labelTarget = parseDraftLabelLocator(manifest.target_path);
        if (!labelTarget) {
          throw new PreconditionError("Owned draft label recovery requires a concrete label target.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            target_path: manifest.target_path,
          });
        }

        const updated = await draftStore.removeLabel(labelTarget.draftId, labelTarget.label);
        if (!updated) {
          throw new NotFoundError("Owned draft no longer exists for compensating recovery.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            draft_id: labelTarget.draftId,
            label: labelTarget.label,
          });
        }

        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "remove_label" &&
          Boolean(parseDraftLabelLocator(manifest.target_path))
        );
      },
      buildCandidate({ manifest }) {
        const labelTarget = parseDraftLabelLocator(manifest.target_path);
        const draftId = labelTarget?.draftId ?? `draft_${manifest.action_id}`;
        const label = labelTarget?.label ?? "unknown";

        return {
          strategy: "add_owned_draft_label",
          confidence: 0.89,
          steps: [
            {
              step_id: `step_add_label_${draftId}`,
              type: "add_owned_draft_label",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["draft_label_add"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned drafts integration"],
            objects_touched: [manifest.target_path],
            manual_steps: [`Verify label "${label}" is present on the owned draft after recovery executes.`],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const labelTarget = parseDraftLabelLocator(manifest.target_path);
        if (!labelTarget) {
          throw new PreconditionError("Owned draft label removal recovery requires a concrete label target.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            target_path: manifest.target_path,
          });
        }

        const updated = await draftStore.addLabel(labelTarget.draftId, labelTarget.label);
        if (!updated) {
          throw new NotFoundError("Owned draft no longer exists for compensating recovery.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            draft_id: labelTarget.draftId,
            label: labelTarget.label,
          });
        }

        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "create_draft" &&
          manifest.target_path.startsWith("drafts://message_draft/")
        );
      },
      buildCandidate({ manifest }) {
        const draftId = parseDraftLocator(manifest.target_path) ?? `draft_${manifest.action_id}`;

        return {
          strategy: "archive_owned_draft",
          confidence: 0.78,
          steps: [
            {
              step_id: `step_archive_${draftId}`,
              type: "archive_owned_draft",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["draft_archive"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned drafts integration"],
            objects_touched: [manifest.target_path],
            manual_steps: ["Verify the draft remains archived in the owned drafts store after recovery executes."],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const draftId = parseDraftLocator(manifest.target_path) ?? `draft_${manifest.action_id}`;
        const archived = await draftStore.archiveDraft(draftId);
        if (!archived) {
          throw new NotFoundError("Owned draft no longer exists for compensating recovery.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            draft_id: draftId,
          });
        }

        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "archive_draft" &&
          manifest.target_path.startsWith("drafts://message_draft/")
        );
      },
      buildCandidate({ manifest }) {
        const draftId = parseDraftLocator(manifest.target_path) ?? `draft_${manifest.action_id}`;

        return {
          strategy: "unarchive_owned_draft",
          confidence: 0.81,
          steps: [
            {
              step_id: `step_unarchive_${draftId}`,
              type: "unarchive_owned_draft",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["draft_unarchive"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned drafts integration"],
            objects_touched: [manifest.target_path],
            manual_steps: [
              "Verify the draft returns to active status in the owned drafts store after recovery executes.",
            ],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const draftId = parseDraftLocator(manifest.target_path) ?? `draft_${manifest.action_id}`;
        const unarchived = await draftStore.unarchiveDraft(draftId);
        if (!unarchived) {
          throw new NotFoundError("Owned draft no longer exists for compensating recovery.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            draft_id: draftId,
          });
        }

        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "unarchive_draft" &&
          manifest.target_path.startsWith("drafts://message_draft/")
        );
      },
      buildCandidate({ manifest }) {
        const draftId = parseDraftLocator(manifest.target_path) ?? `draft_${manifest.action_id}`;

        return {
          strategy: "archive_owned_draft",
          confidence: 0.81,
          steps: [
            {
              step_id: `step_archive_${draftId}`,
              type: "archive_owned_draft",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["draft_archive"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned drafts integration"],
            objects_touched: [manifest.target_path],
            manual_steps: [
              "Verify the draft returns to archived status in the owned drafts store after recovery executes.",
            ],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const draftId = parseDraftLocator(manifest.target_path) ?? `draft_${manifest.action_id}`;
        const archived = await draftStore.archiveDraft(draftId);
        if (!archived) {
          throw new NotFoundError("Owned draft no longer exists for compensating recovery.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            draft_id: draftId,
          });
        }

        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          manifest.operation_kind === "delete_draft" &&
          manifest.target_path.startsWith("drafts://message_draft/") &&
          Boolean(manifest.captured_preimage)
        );
      },
      buildCandidate({ manifest }) {
        const draftId = parseDraftLocator(manifest.target_path) ?? `draft_${manifest.action_id}`;

        return {
          strategy: "restore_owned_draft_preimage",
          confidence: 0.85,
          steps: [
            {
              step_id: `step_restore_deleted_${draftId}`,
              type: "restore_owned_draft_preimage",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["draft_restore"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned drafts integration"],
            objects_touched: [manifest.target_path],
            manual_steps: [
              "Verify the draft has been restored with its prior subject, body, labels, and status after recovery executes.",
            ],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const draftId = parseDraftLocator(manifest.target_path) ?? `draft_${manifest.action_id}`;
        if (!manifest.captured_preimage) {
          throw new PreconditionError("Owned draft delete recovery requires captured preimage metadata.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            draft_id: draftId,
          });
        }

        await draftStore.restoreDraftFromSnapshot(draftId, manifest.captured_preimage);
        return true;
      },
    },
    {
      canCompensate(manifest) {
        return (
          manifest.operation_domain === "function" &&
          (manifest.operation_kind === "update_draft" || manifest.operation_kind === "restore_draft") &&
          manifest.target_path.startsWith("drafts://message_draft/") &&
          Boolean(manifest.captured_preimage)
        );
      },
      buildCandidate({ manifest }) {
        const draftId = parseDraftLocator(manifest.target_path) ?? `draft_${manifest.action_id}`;

        return {
          strategy: "restore_owned_draft_preimage",
          confidence: 0.84,
          steps: [
            {
              step_id: `step_restore_${draftId}`,
              type: "restore_owned_draft_preimage",
              idempotent: true,
              depends_on: [],
            },
          ],
          impact_preview: {
            external_effects: ["draft_restore"],
            data_loss_risk: "low",
          },
          warnings: [],
          review_guidance: {
            systems_touched: ["owned drafts integration"],
            objects_touched: [manifest.target_path],
            manual_steps: ["Verify the draft subject and body match the pre-update version after recovery executes."],
            uncertainty: [],
          },
        };
      },
      async execute({ manifest }) {
        const draftId = parseDraftLocator(manifest.target_path) ?? `draft_${manifest.action_id}`;
        if (!manifest.captured_preimage) {
          throw new PreconditionError("Owned draft update recovery requires captured preimage metadata.", {
            snapshot_id: manifest.snapshot_id,
            action_id: manifest.action_id,
            draft_id: draftId,
          });
        }

        await draftStore.restoreDraftFromSnapshot(draftId, manifest.captured_preimage);
        return true;
      },
    },
  ]);
}

function buildPolicyRuntimeLoadOptions(
  runtimeOptions: Pick<
    ServiceOptions,
    "policyGlobalConfigPath" | "policyWorkspaceConfigPath" | "policyCalibrationConfigPath" | "policyConfigPath"
  >,
): LoadPolicyRuntimeOptions {
  return {
    globalConfigPath: runtimeOptions.policyGlobalConfigPath,
    workspaceConfigPath: runtimeOptions.policyWorkspaceConfigPath,
    generatedConfigPath: runtimeOptions.policyCalibrationConfigPath,
    explicitConfigPath: runtimeOptions.policyConfigPath,
  };
}

function buildCalibrationThresholdUpdates(recommendations: ReturnType<typeof recommendPolicyThresholds>): Array<{
  action_family: string;
  current_ask_below: number | null;
  recommended_ask_below: number;
  direction: string;
}> {
  return recommendations
    .filter(
      (recommendation) =>
        recommendation.requires_policy_update &&
        recommendation.recommended_ask_below !== null &&
        recommendation.recommended_ask_below !== recommendation.current_ask_below,
    )
    .map((recommendation) => ({
      action_family: recommendation.action_family,
      current_ask_below: recommendation.current_ask_below,
      recommended_ask_below: recommendation.recommended_ask_below as number,
      direction: recommendation.direction,
    }));
}

async function handleRunMaintenance(
  state: AuthorityState,
  journal: RunJournal,
  snapshotEngine: LocalSnapshotEngine,
  broker: SessionCredentialBroker,
  mcpRegistry: McpServerRegistry,
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry,
  hostedWorkerClient: HostedMcpWorkerClient,
  draftStore: OwnedDraftStore,
  noteStore: OwnedNoteStore,
  ticketStore: OwnedTicketStore,
  policyRuntime: PolicyRuntimeState,
  runtimeOptions: Pick<
    ServiceOptions,
    | "socketPath"
    | "journalPath"
    | "snapshotRootPath"
    | "mcpConcurrencyLeasePath"
    | "policyGlobalConfigPath"
    | "policyWorkspaceConfigPath"
    | "policyCalibrationConfigPath"
    | "policyConfigPath"
  >,
  request: RequestEnvelope<unknown>,
  _context: RequestContext,
): Promise<ResponseEnvelope<RunMaintenanceResponsePayload>> {
  const payload = validate(RunMaintenanceRequestPayloadSchema, request.payload);
  const acceptedPriority = payload.priority_override ?? "administrative";
  const workspaceRoots = payload.scope?.workspace_root ? [payload.scope.workspace_root] : undefined;
  const jobs: RunMaintenanceResponsePayload["jobs"] = [];

  for (const jobType of payload.job_types) {
    switch (jobType) {
      case "startup_reconcile_runs": {
        const result = reconcilePersistedRuns(state, journal);
        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary:
            result.runs_considered > 0
              ? `Reconciled ${result.runs_considered} persisted run(s); rehydrated ${result.runs_rehydrated} run record(s) and ${result.sessions_rehydrated} session record(s).`
              : "No persisted runs were available for reconciliation.",
          stats: result,
        });
        break;
      }
      case "startup_reconcile_recoveries": {
        const reconciledActions = recoverInterruptedActions(journal);
        const reconciledIdempotencyKeys = reconcileInterruptedIdempotentMutations(journal);
        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary:
            reconciledActions > 0 || reconciledIdempotencyKeys > 0
              ? `Marked ${reconciledActions} interrupted action(s) and ${reconciledIdempotencyKeys} interrupted idempotent request(s) as outcome_unknown for manual reconciliation.`
              : "No interrupted actions or idempotent requests required recovery reconciliation.",
          stats: {
            reconciled_actions: reconciledActions,
            reconciled_idempotency_keys: reconciledIdempotencyKeys,
          },
        });
        break;
      }
      case "artifact_expiry": {
        const expiredArtifacts = journal.enforceArtifactRetention();
        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary:
            expiredArtifacts > 0
              ? `Expired ${expiredArtifacts} durable artifact blob(s) by retention policy.`
              : "No durable artifacts were eligible for expiry.",
          stats: {
            expired_artifacts: expiredArtifacts,
          },
        });
        break;
      }
      case "artifact_orphan_cleanup": {
        const result = journal.cleanupOrphanedArtifacts();
        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary:
            result.orphaned_files_removed > 0
              ? `Removed ${result.orphaned_files_removed} orphaned artifact blob(s) and reclaimed ${result.bytes_freed} byte(s).`
              : result.files_scanned > 0
                ? `Scanned ${result.files_scanned} artifact blob(s) and found no orphaned files to remove.`
                : "No durable artifact blobs were present for orphan cleanup.",
          stats: {
            ...result,
          },
        });
        break;
      }
      case "snapshot_compaction": {
        const result = await snapshotEngine.compactSnapshots(workspaceRoots);
        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary:
            result.snaps_removed > 0
              ? `Compaction removed ${result.snaps_removed} snapshot layer(s) across ${result.workspaces_considered} workspace(s).`
              : result.workspaces_considered > 0
                ? `Snapshot compaction ran across ${result.workspaces_considered} workspace(s) and found nothing to flatten.`
                : "No workspace indexes were available for snapshot compaction.",
          stats: {
            ...result,
          },
        });
        break;
      }
      case "snapshot_rebase_anchor": {
        const result = await snapshotEngine.rebaseSyntheticAnchors(workspaceRoots);
        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary:
            result.anchors_rebased > 0
              ? `Rebased ${result.anchors_rebased} synthetic anchor reference(s) across ${result.workspaces_considered} workspace(s) and reclaimed ${result.bytes_freed} byte(s).`
              : result.workspaces_considered > 0
                ? `Synthetic anchor rebasing scanned ${result.snapshots_scanned} snapshot(s) across ${result.workspaces_considered} workspace(s) and found no duplicate anchors to rebase.`
                : "No workspace indexes were available for synthetic anchor rebasing.",
          stats: {
            ...result,
          },
        });
        break;
      }
      case "sqlite_wal_checkpoint": {
        const journalCheckpoint = journal.checkpointWal();
        const snapshotCheckpoint = snapshotEngine.checkpointWal(workspaceRoots);
        const draftCheckpoint = draftStore.checkpointWal();
        const noteCheckpoint = noteStore.checkpointWal();
        const ticketCheckpoint = ticketStore.checkpointWal();
        const mcpRegistryCheckpoint = mcpRegistry.checkpointWal();
        const mcpHostPolicyCheckpoint = publicHostPolicyRegistry.checkpointWal();
        const mcpSecretStoreCheckpoint = broker.checkpointMcpSecretStore();
        const checkpointedDatabases =
          (journalCheckpoint.checkpointed ? 1 : 0) +
          snapshotCheckpoint.checkpointed_databases +
          (mcpRegistryCheckpoint.checkpointed ? 1 : 0) +
          (mcpHostPolicyCheckpoint.checkpointed ? 1 : 0) +
          (mcpSecretStoreCheckpoint?.checkpointed ? 1 : 0) +
          (draftCheckpoint.checkpointed ? 1 : 0) +
          (noteCheckpoint.checkpointed ? 1 : 0) +
          (ticketCheckpoint.checkpointed ? 1 : 0);
        const skippedDatabases =
          (journalCheckpoint.checkpointed ? 0 : 1) +
          snapshotCheckpoint.skipped_databases +
          (mcpRegistryCheckpoint.checkpointed ? 0 : 1) +
          (mcpHostPolicyCheckpoint.checkpointed ? 0 : 1) +
          (mcpSecretStoreCheckpoint?.checkpointed ? 0 : 1) +
          (draftCheckpoint.checkpointed ? 0 : 1) +
          (noteCheckpoint.checkpointed ? 0 : 1) +
          (ticketCheckpoint.checkpointed ? 0 : 1);

        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary:
            checkpointedDatabases > 0
              ? `Checkpointed ${checkpointedDatabases} SQLite WAL database(s); skipped ${skippedDatabases} non-WAL database(s).`
              : `No SQLite databases required WAL checkpointing; skipped ${skippedDatabases} non-WAL database(s).`,
          stats: {
            checkpointed_databases: checkpointedDatabases,
            skipped_databases: skippedDatabases,
            journal: journalCheckpoint,
            snapshots: snapshotCheckpoint,
            mcp_registry: mcpRegistryCheckpoint,
            mcp_host_policies: mcpHostPolicyCheckpoint,
            mcp_secrets: mcpSecretStoreCheckpoint,
            drafts: draftCheckpoint,
            notes: noteCheckpoint,
            tickets: ticketCheckpoint,
          },
        });
        break;
      }
      case "projection_refresh":
      case "projection_rebuild": {
        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary:
            "Timeline and helper projections are derived fresh from the journal on read at launch, so no queued rebuild was required.",
          stats: {
            projection_status: "fresh",
            lag_events: 0,
          },
        });
        break;
      }
      case "snapshot_gc": {
        const result = await snapshotEngine.garbageCollectSnapshots(workspaceRoots);
        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary:
            result.layered_snapshots_removed > 0 ||
            result.legacy_snapshots_removed > 0 ||
            result.stray_entries_removed > 0
              ? `Removed ${result.layered_snapshots_removed + result.legacy_snapshots_removed} orphaned snapshot container(s), ${result.stray_entries_removed} stray snapshot entry(s), and reclaimed ${result.bytes_freed} byte(s).`
              : result.workspaces_considered > 0
                ? `Scanned ${result.workspaces_considered} workspace snapshot index(es) and found no orphaned snapshot storage to remove.`
                : "No persisted workspace snapshot indexes were available for snapshot garbage collection.",
          stats: {
            ...result,
          },
        });
        break;
      }
      case "helper_fact_warm": {
        journal.enforceArtifactRetention();
        const targetRuns = payload.scope?.run_id
          ? (() => {
              const runSummary = journal.getRunSummary(payload.scope.run_id);
              if (!runSummary) {
                throw new NotFoundError(`No run found for ${payload.scope.run_id}.`, {
                  run_id: payload.scope.run_id,
                });
              }

              return [runSummary];
            })()
          : journal.listAllRuns();
        let runsWarmed = 0;
        let visibilityScopesWarmed = 0;
        let stepsScanned = 0;
        let helperAnswersCached = 0;

        for (const runSummary of targetRuns) {
          const currentLatestSequence = latestRunSequence(runSummary);
          const artifactStateDigest = journal.getRunArtifactStateDigest(runSummary.run_id);

          for (const visibilityScope of HELPER_FACT_WARM_VISIBILITY_SCOPES) {
            const context = buildHelperProjectionContext(
              journal,
              runSummary.run_id,
              visibilityScope,
              artifactStateDigest,
            );
            visibilityScopesWarmed += 1;
            stepsScanned += context.steps.length;

            for (const questionType of HELPER_FACT_WARM_RUN_QUESTIONS) {
              journal.storeHelperFactCache({
                run_id: runSummary.run_id,
                question_type: questionType,
                focus_step_id: null,
                compare_step_id: null,
                visibility_scope: visibilityScope,
                event_count: runSummary.event_count,
                latest_sequence: currentLatestSequence,
                artifact_state_digest: artifactStateDigest,
                response: buildHelperResponseFromContext(questionType, context),
                warmed_at: new Date().toISOString(),
              });
              helperAnswersCached += 1;
            }

            for (const step of context.steps) {
              for (const questionType of HELPER_FACT_WARM_STEP_QUESTIONS) {
                journal.storeHelperFactCache({
                  run_id: runSummary.run_id,
                  question_type: questionType,
                  focus_step_id: step.step_id,
                  compare_step_id: null,
                  visibility_scope: visibilityScope,
                  event_count: runSummary.event_count,
                  latest_sequence: currentLatestSequence,
                  artifact_state_digest: artifactStateDigest,
                  response: buildHelperResponseFromContext(questionType, context, step.step_id),
                  warmed_at: new Date().toISOString(),
                });
                helperAnswersCached += 1;
              }
            }
          }

          runsWarmed += 1;
        }

        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary:
            targetRuns.length > 0
              ? `Warmed ${helperAnswersCached} helper answer(s) across ${runsWarmed} run(s) and ${visibilityScopesWarmed} visibility projection(s).`
              : "No runs were available for helper fact warming.",
          stats: {
            runs_considered: targetRuns.length,
            runs_warmed: runsWarmed,
            visibility_scopes_warmed: visibilityScopesWarmed,
            steps_scanned: stepsScanned,
            helper_answers_cached: helperAnswersCached,
          },
        });
        break;
      }
      case "capability_refresh": {
        const snapshot = detectCapabilitiesHandler(
          broker,
          runtimeOptions,
          mcpRegistry,
          publicHostPolicyRegistry,
          hostedWorkerClient,
          payload.scope?.workspace_root,
        );
        const degradedCount = snapshot.capabilities.filter((capability) => capability.status === "degraded").length;
        const unavailableCount = snapshot.capabilities.filter(
          (capability) => capability.status === "unavailable",
        ).length;
        journal.storeCapabilitySnapshot({
          ...snapshot,
          workspace_root: payload.scope?.workspace_root ?? null,
          refreshed_at: snapshot.detection_timestamps.completed_at,
        });
        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary: `Refreshed ${snapshot.capabilities.length} capability record(s); ${degradedCount} degraded and ${unavailableCount} unavailable.`,
          stats: {
            capability_count: snapshot.capabilities.length,
            degraded_capabilities: degradedCount,
            unavailable_capabilities: unavailableCount,
            refreshed_at: snapshot.detection_timestamps.completed_at,
            workspace_root: payload.scope?.workspace_root ?? null,
          },
        });
        break;
      }
      case "policy_threshold_calibration": {
        const calibrationReport = journal.getPolicyCalibrationReport({
          run_id: payload.scope?.run_id,
          include_samples: true,
          sample_limit: null,
        });
        const recommendations = recommendPolicyThresholds(calibrationReport.report, policyRuntime.compiled_policy, {
          min_samples: POLICY_CALIBRATION_MIN_SAMPLES,
        });
        const thresholdUpdates = buildCalibrationThresholdUpdates(recommendations);

        if (thresholdUpdates.length === 0) {
          jobs.push({
            job_type: jobType,
            status: "completed",
            performed_inline: true,
            summary:
              calibrationReport.report.totals.sample_count > 0
                ? `No policy threshold updates were applied; ${calibrationReport.report.totals.sample_count} calibration sample(s) did not justify a change.`
                : "No policy threshold updates were applied because no calibration samples were available yet.",
            stats: {
              run_id: payload.scope?.run_id ?? null,
              min_samples: POLICY_CALIBRATION_MIN_SAMPLES,
              sample_count: calibrationReport.report.totals.sample_count,
              action_families_considered: calibrationReport.report.action_families.length,
              recommendations_considered: recommendations.length,
              thresholds_applied: 0,
              generated_config_path: runtimeOptions.policyCalibrationConfigPath,
            },
          });
          break;
        }

        const generatedConfigPath = runtimeOptions.policyCalibrationConfigPath;
        if (!generatedConfigPath) {
          throw new InternalError("Policy calibration config path is not configured.", {
            job_type: jobType,
          });
        }
        const generatedPolicyVersion = `workspace-generated-calibration@${new Date().toISOString()}`;
        const generatedPolicyDocument = {
          profile_name: policyRuntime.effective_policy.policy.profile_name,
          policy_version: generatedPolicyVersion,
          thresholds: {
            low_confidence: thresholdUpdates.map((update) => ({
              action_family: update.action_family,
              ask_below: update.recommended_ask_below,
            })),
          },
          rules: [],
        };
        const generatedValidation = validatePolicyConfigDocument(generatedPolicyDocument);
        if (!generatedValidation.valid || !generatedValidation.normalized_config) {
          throw new InternalError("Generated calibration policy document failed validation.", {
            issues: generatedValidation.issues,
          });
        }

        fs.mkdirSync(path.dirname(generatedConfigPath), { recursive: true });
        fs.writeFileSync(
          generatedConfigPath,
          `${JSON.stringify(generatedValidation.normalized_config, null, 2)}\n`,
          "utf8",
        );
        reloadPolicyRuntime(policyRuntime, buildPolicyRuntimeLoadOptions(runtimeOptions));

        jobs.push({
          job_type: jobType,
          status: "completed",
          performed_inline: true,
          summary: `Applied ${thresholdUpdates.length} policy low-confidence threshold update(s) from ${calibrationReport.report.totals.sample_count} calibration sample(s).`,
          stats: {
            run_id: payload.scope?.run_id ?? null,
            min_samples: POLICY_CALIBRATION_MIN_SAMPLES,
            sample_count: calibrationReport.report.totals.sample_count,
            action_families_considered: calibrationReport.report.action_families.length,
            recommendations_considered: recommendations.length,
            thresholds_applied: thresholdUpdates.length,
            generated_policy_version: generatedPolicyVersion,
            generated_config_path: generatedConfigPath,
            updates: thresholdUpdates,
          },
        });
        break;
      }
      default: {
        jobs.push({
          job_type: jobType,
          status: "not_supported",
          performed_inline: false,
          summary: "This maintenance job is documented but not yet owned by the launch runtime.",
        });
        break;
      }
    }
  }

  return makeSuccessResponse(request.request_id, request.session_id, {
    accepted_priority: acceptedPriority,
    scope: payload.scope ?? null,
    jobs,
    stream_id: null,
  });
}

function enrichTimelineArtifactHealth(journal: RunJournal, steps: TimelineStep[]): TimelineStep[] {
  return steps.map((step) => {
    const primaryArtifacts = step.primary_artifacts.map((artifact) => {
      if (!artifact.artifact_id) {
        return artifact;
      }

      try {
        const storedArtifact = journal.getArtifact(artifact.artifact_id);
        return {
          ...artifact,
          artifact_status: storedArtifact.artifact_status,
          integrity: storedArtifact.integrity,
        };
      } catch (error) {
        if (error instanceof NotFoundError) {
          return {
            ...artifact,
            artifact_status: "missing" as const,
          };
        }

        throw error;
      }
    });

    const availabilityWarnings = primaryArtifacts
      .filter(
        (artifact) => artifact.artifact_id && artifact.artifact_status && artifact.artifact_status !== "available",
      )
      .map((artifact) =>
        artifact.artifact_status === "expired"
          ? `Artifact ${artifact.artifact_id} expired under the configured retention policy and is no longer available.`
          : artifact.artifact_status === "tampered"
            ? `Artifact ${artifact.artifact_id} failed content integrity verification and may have been tampered with.`
            : artifact.artifact_status === "corrupted"
              ? `Artifact ${artifact.artifact_id} is corrupted in durable storage and can no longer be read safely.`
              : `Artifact ${artifact.artifact_id} is missing from durable storage.`,
      );

    return {
      ...step,
      primary_artifacts: primaryArtifacts,
      warnings: [...(step.warnings ?? []), ...availabilityWarnings],
    };
  });
}

function latestRunSequence(runSummary: ReturnType<RunJournal["getRunSummary"]>): number {
  return runSummary?.latest_event?.sequence ?? 0;
}

function buildHelperProjectionContext(
  journal: RunJournal,
  runId: string,
  visibilityScope: VisibilityScope,
  artifactStateDigest?: string,
): HelperProjectionContext {
  const events = journal.listRunEvents(runId);
  const projection = projectTimelineView(runId, events, visibilityScope);
  const steps = enrichTimelineArtifactHealth(journal, projection.steps);

  return {
    visibility_scope: projection.visibility_scope,
    redactions_applied: projection.redactions_applied,
    preview_budget: projection.preview_budget,
    steps,
    unavailable_artifacts_present: steps.some((step) =>
      step.primary_artifacts.some((artifact) => artifact.artifact_status && artifact.artifact_status !== "available"),
    ),
    artifact_state_digest: artifactStateDigest ?? journal.getRunArtifactStateDigest(runId),
  };
}

function buildHelperResponseFromContext(
  questionType: HelperQuestionType,
  context: HelperProjectionContext,
  focusStepId?: string,
  compareStepId?: string,
): QueryHelperResponsePayload {
  const answer = answerHelperQuery(questionType, context.steps, focusStepId, compareStepId);

  return {
    ...answer,
    visibility_scope: context.visibility_scope,
    redactions_applied: context.redactions_applied,
    preview_budget: context.preview_budget,
    uncertainty: [
      ...answer.uncertainty,
      ...(context.redactions_applied > 0
        ? [`Some details were redacted for ${context.visibility_scope} visibility.`]
        : []),
      ...(context.preview_budget.truncated_previews > 0 || context.preview_budget.omitted_previews > 0
        ? [
            `Some inline previews were truncated or omitted to stay within the response preview budget (${context.preview_budget.preview_chars_used}/${context.preview_budget.max_total_inline_preview_chars} chars used).`,
          ]
        : []),
      ...(context.unavailable_artifacts_present
        ? [
            "Some referenced artifacts are no longer available in durable storage because they expired, failed integrity verification, became corrupted, or went missing, so parts of the supporting evidence may be unavailable.",
          ]
        : []),
    ],
  };
}

export async function handleRequest(
  state: AuthorityState,
  journal: RunJournal,
  adapterRegistry: AdapterRegistry,
  snapshotEngine: LocalSnapshotEngine,
  compensationRegistry: StaticCompensationRegistry,
  broker: SessionCredentialBroker,
  mcpRegistry: McpServerRegistry,
  publicHostPolicyRegistry: McpPublicHostPolicyRegistry,
  hostedWorkerClient: HostedMcpWorkerClient,
  hostedExecutionQueue: HostedExecutionQueue,
  latencyMetrics: LatencyMetricsStore,
  policyRuntime: PolicyRuntimeState,
  draftStore: OwnedDraftStore,
  noteStore: OwnedNoteStore,
  ticketStore: OwnedTicketStore,
  runtimeOptions: Pick<
    ServiceOptions,
    | "socketPath"
    | "journalPath"
    | "snapshotRootPath"
    | "capabilityRefreshStaleMs"
    | "mcpConcurrencyLeasePath"
    | "policyGlobalConfigPath"
    | "policyWorkspaceConfigPath"
    | "policyCalibrationConfigPath"
    | "policyConfigPath"
  >,
  rawRequest: unknown,
  context: RequestContext,
): Promise<ResponseEnvelope<unknown>> {
  const requestContext = getRequestContextFromHelpers(rawRequest);

  try {
    const request = validate(RequestEnvelopeSchema, rawRequest);
    const idempotencyClaim =
      canUseIdempotencyHelper(request, IDEMPOTENT_MUTATION_METHODS) && request.session_id
        ? journal.claimIdempotentMutation({
            session_id: request.session_id,
            idempotency_key: request.idempotency_key!,
            method: request.method,
            payload: request.payload,
            stored_at: new Date().toISOString(),
          })
        : null;

    if (idempotencyClaim?.status === "replay") {
      return replayStoredSuccessResponse(request.request_id, request.session_id, idempotencyClaim.record.response);
    }

    if (idempotencyClaim?.status === "conflict") {
      throw new PreconditionError("Idempotency key has already been used for a different mutating request.", {
        session_id: request.session_id,
        idempotency_key: request.idempotency_key,
        recorded_method: idempotencyClaim.record?.method ?? request.method,
        request_method: idempotencyClaim.request_method,
        recorded_payload_digest: idempotencyClaim.record?.payload_digest ?? null,
        request_payload_digest: idempotencyClaim.request_payload_digest,
      });
    }

    if (idempotencyClaim?.status === "in_progress") {
      throw new AgentGitError(
        "An idempotent request with the same key is already in progress. Retry after the original request finishes.",
        "PRECONDITION_FAILED",
        {
          session_id: request.session_id,
          idempotency_key: request.idempotency_key,
          method: request.method,
          stored_at: idempotencyClaim.stored_at,
        },
        true,
      );
    }

    if (idempotencyClaim?.status === "outcome_unknown") {
      throw new PreconditionError(
        "A previous request with this idempotency key has an unknown outcome after interruption or journal finalization failure. Inspect side effects before retrying or reusing the key.",
        {
          session_id: request.session_id,
          idempotency_key: request.idempotency_key,
          method: request.method,
          stored_at: idempotencyClaim.record.stored_at,
          uncertainty_recorded_at: idempotencyClaim.record.uncertainty_recorded_at,
          uncertainty_reason: idempotencyClaim.record.uncertainty_reason,
        },
      );
    }

    let idempotencyFinalizedOrLocked = false;

    try {
      let response: ResponseEnvelope<unknown>;

      switch (request.method) {
        case "hello":
          response = handleHelloHandler(state, METHODS, RUNTIME_VERSION, request, context);
          break;
        case "register_run":
          response = handleRegisterRunHandler(state, journal, policyRuntime, request, context);
          break;
        case "get_run_summary":
          response = handleGetRunSummaryHandler(state, journal, request, context);
          break;
        case "get_capabilities":
          response = handleGetCapabilitiesHandler(
            broker,
            runtimeOptions,
            mcpRegistry,
            publicHostPolicyRegistry,
            hostedWorkerClient,
            request,
            context,
          );
          break;
        case "get_effective_policy":
          response = handleGetEffectivePolicyHandler(request, policyRuntime, context);
          break;
        case "validate_policy_config":
          response = handleValidatePolicyConfigHandler(request, context);
          break;
        case "get_policy_calibration_report":
          response = handleGetPolicyCalibrationReportHandler(state, journal, request, context);
          break;
        case "explain_policy_action":
          response = handleExplainPolicyActionHandler(
            state,
            journal,
            policyRuntime,
            latencyMetrics,
            runtimeOptions,
            mcpRegistry,
            request,
            context,
          );
          break;
        case "get_policy_threshold_recommendations":
          response = handleGetPolicyThresholdRecommendationsHandler(state, journal, policyRuntime, request, context);
          break;
        case "replay_policy_thresholds":
          response = handleReplayPolicyThresholdsHandler(state, journal, policyRuntime, request, context);
          break;
        case "list_mcp_servers":
          response = handleListMcpServers(mcpRegistry, request, context);
          break;
        case "list_mcp_server_candidates":
          response = handleListMcpServerCandidates(mcpRegistry, request, context);
          break;
        case "submit_mcp_server_candidate":
          response = handleSubmitMcpServerCandidate(state, mcpRegistry, request, context);
          break;
        case "list_mcp_server_profiles":
          response = handleListMcpServerProfiles(mcpRegistry, request, context);
          break;
        case "get_mcp_server_review":
          response = handleGetMcpServerReview(mcpRegistry, request, context);
          break;
        case "resolve_mcp_server_candidate":
          response = await handleResolveMcpServerCandidate(state, mcpRegistry, request, context);
          break;
        case "list_mcp_server_trust_decisions":
          response = handleListMcpServerTrustDecisions(mcpRegistry, request, context);
          break;
        case "approve_mcp_server_profile":
          response = handleApproveMcpServerProfile(state, mcpRegistry, request, context);
          break;
        case "list_mcp_server_credential_bindings":
          response = handleListMcpServerCredentialBindings(mcpRegistry, request, context);
          break;
        case "bind_mcp_server_credentials":
          response = handleBindMcpServerCredentials(state, broker, mcpRegistry, request, context);
          break;
        case "revoke_mcp_server_credentials":
          response = handleRevokeMcpServerCredentials(state, mcpRegistry, request, context);
          break;
        case "activate_mcp_server_profile":
          response = handleActivateMcpServerProfile(state, mcpRegistry, request, context);
          break;
        case "quarantine_mcp_server_profile":
          response = handleQuarantineMcpServerProfile(state, mcpRegistry, request, context);
          break;
        case "revoke_mcp_server_profile":
          response = handleRevokeMcpServerProfile(state, mcpRegistry, request, context);
          break;
        case "upsert_mcp_server":
          response = handleUpsertMcpServer(state, mcpRegistry, broker, request, context);
          break;
        case "remove_mcp_server":
          response = handleRemoveMcpServer(state, mcpRegistry, request, context);
          break;
        case "list_mcp_secrets":
          response = handleListMcpSecrets(broker, request, context);
          break;
        case "upsert_mcp_secret":
          response = handleUpsertMcpSecret(state, broker, request, context);
          break;
        case "remove_mcp_secret":
          response = handleRemoveMcpSecret(state, broker, request, context);
          break;
        case "list_mcp_host_policies":
          response = handleListMcpHostPolicies(publicHostPolicyRegistry, request, context);
          break;
        case "upsert_mcp_host_policy":
          response = handleUpsertMcpHostPolicy(state, publicHostPolicyRegistry, request, context);
          break;
        case "remove_mcp_host_policy":
          response = handleRemoveMcpHostPolicy(state, publicHostPolicyRegistry, request, context);
          break;
        case "get_hosted_mcp_job":
          response = handleGetHostedMcpJob(mcpRegistry, hostedExecutionQueue, journal, request, context);
          break;
        case "list_hosted_mcp_jobs":
          response = handleListHostedMcpJobs(mcpRegistry, hostedExecutionQueue, request, context);
          break;
        case "requeue_hosted_mcp_job":
          response = handleRequeueHostedMcpJob(state, journal, hostedExecutionQueue, request, context);
          break;
        case "cancel_hosted_mcp_job":
          response = handleCancelHostedMcpJob(state, journal, hostedExecutionQueue, request, context);
          break;
        case "diagnostics":
          response = handleDiagnosticsHandler(
            state,
            journal,
            broker,
            mcpRegistry,
            publicHostPolicyRegistry,
            hostedWorkerClient,
            hostedExecutionQueue,
            latencyMetrics,
            policyRuntime,
            runtimeOptions,
            request,
            context,
          );
          break;
        case "run_maintenance":
          response = await handleRunMaintenance(
            state,
            journal,
            snapshotEngine,
            broker,
            mcpRegistry,
            publicHostPolicyRegistry,
            hostedWorkerClient,
            draftStore,
            noteStore,
            ticketStore,
            policyRuntime,
            runtimeOptions,
            request,
            context,
          );
          break;
        case "list_approvals":
          response = handleListApprovalsHandler(state, journal, request, context);
          break;
        case "query_approval_inbox":
          response = handleQueryApprovalInboxHandler(state, journal, request, context);
          break;
        case "resolve_approval":
          response = await handleResolveApprovalHandler(
            state,
            journal,
            adapterRegistry,
            snapshotEngine,
            draftStore,
            noteStore,
            ticketStore,
            mcpRegistry,
            hostedExecutionQueue,
            latencyMetrics,
            runtimeOptions,
            request,
            context,
            executeHostedDelegatedMcpAction,
          );
          break;
        case "query_timeline":
          response = handleQueryTimelineHandler(state, journal, request, context);
          break;
        case "query_helper":
          response = handleQueryHelperHandler(state, journal, request, context);
          break;
        case "query_artifact":
          response = handleQueryArtifactHandler(state, journal, request, context);
          break;
        case "submit_action_attempt":
          response = await handleSubmitActionAttemptFlow({
            state,
            journal,
            adapterRegistry,
            snapshotEngine,
            draftStore,
            noteStore,
            ticketStore,
            mcpRegistry,
            hostedExecutionQueue,
            latencyMetrics,
            policyRuntime,
            runtimeOptions,
            buildCachedCapabilityState,
            executeHostedDelegatedAction: executeHostedDelegatedMcpAction,
            request,
            context,
          });
          break;
        case "plan_recovery":
          response = await handlePlanRecoveryHandler(
            state,
            journal,
            snapshotEngine,
            compensationRegistry,
            runtimeOptions,
            request,
            context,
          );
          break;
        case "create_run_checkpoint":
          response = await handleCreateRunCheckpointHandler(
            state,
            journal,
            snapshotEngine,
            runtimeOptions,
            request,
            context,
          );
          break;
        case "execute_recovery":
          response = await handleExecuteRecoveryHandler(
            state,
            journal,
            snapshotEngine,
            compensationRegistry,
            runtimeOptions,
            request,
            context,
          );
          break;
        default:
          throw new ValidationError("Unknown method.");
      }

      if (idempotencyClaim?.status === "claimed" && request.session_id && request.idempotency_key && response.ok) {
        try {
          journal.completeIdempotentMutation({
            session_id: request.session_id,
            idempotency_key: request.idempotency_key,
            response,
            completed_at: new Date().toISOString(),
          });
          idempotencyFinalizedOrLocked = true;
        } catch (completionError) {
          const uncertaintyRecordedAt = new Date().toISOString();
          journal.markIdempotentMutationOutcomeUnknown({
            session_id: request.session_id,
            idempotency_key: request.idempotency_key,
            uncertainty_recorded_at: uncertaintyRecordedAt,
            uncertainty_reason: "response_persistence_failed_after_side_effects",
          });
          idempotencyFinalizedOrLocked = true;

          throw new AgentGitError(
            "Request side effects completed, but durable idempotency finalization failed. The request outcome is now locked as unknown until an operator reconciles it.",
            completionError instanceof AgentGitError ? completionError.code : "INTERNAL_ERROR",
            {
              session_id: request.session_id,
              idempotency_key: request.idempotency_key,
              method: request.method,
              uncertainty_recorded_at: uncertaintyRecordedAt,
              cause: completionError instanceof Error ? completionError.message : String(completionError),
            },
            false,
          );
        }
      }

      return response;
    } catch (error) {
      if (
        idempotencyClaim?.status === "claimed" &&
        request.session_id &&
        request.idempotency_key &&
        !idempotencyFinalizedOrLocked
      ) {
        journal.markIdempotentMutationOutcomeUnknown({
          session_id: request.session_id,
          idempotency_key: request.idempotency_key,
          uncertainty_recorded_at: new Date().toISOString(),
          uncertainty_reason: "request_failed_before_durable_completion",
        });
        idempotencyFinalizedOrLocked = true;
      }

      throw error;
    }
  } catch (error) {
    return makeErrorResponse(requestContext.request_id, requestContext.session_id, error);
  }
}

export function rehydrateState(state: AuthorityState, journal: RunJournal): void {
  reconcilePersistedRuns(state, journal);
}

function reconcilePersistedRuns(
  state: AuthorityState,
  journal: RunJournal,
): {
  runs_considered: number;
  sessions_rehydrated: number;
  runs_rehydrated: number;
  total_sessions: number;
  total_runs: number;
} {
  const runs = journal.listAllRuns();
  const sessionsBefore = state.getSessionCount();
  const runsBefore = state.getRunCount();

  for (const run of runs) {
    state.rehydrateSession(run.session_id, run.workspace_roots);
    state.rehydrateRun(run);
  }

  return {
    runs_considered: runs.length,
    sessions_rehydrated: state.getSessionCount() - sessionsBefore,
    runs_rehydrated: state.getRunCount() - runsBefore,
    total_sessions: state.getSessionCount(),
    total_runs: state.getRunCount(),
  };
}

export function recoverInterruptedActions(journal: RunJournal): number {
  const runs = journal.listAllRuns();
  let reconciledActions = 0;

  for (const run of runs) {
    const events = journal.listRunEvents(run.run_id);
    const candidates = new Map<string, { snapshot_created: boolean; execution_started: boolean }>();

    for (const event of events) {
      const actionId = typeof event.payload?.action_id === "string" ? event.payload.action_id : null;
      if (!actionId) {
        continue;
      }

      const candidate = candidates.get(actionId) ?? { snapshot_created: false, execution_started: false };
      if (event.event_type === "snapshot.created") {
        candidate.snapshot_created = true;
      }
      if (event.event_type === "execution.started") {
        candidate.execution_started = true;
      }
      candidates.set(actionId, candidate);
    }

    for (const [actionId, candidate] of candidates.entries()) {
      if (!candidate.snapshot_created && !candidate.execution_started) {
        continue;
      }

      const alreadyReconciled = events.some(
        (event) => event.payload?.action_id === actionId && event.event_type === "execution.outcome_unknown",
      );
      if (alreadyReconciled) {
        continue;
      }

      const hasTerminalEvent = events.some(
        (event) =>
          event.payload?.action_id === actionId &&
          (event.event_type === "execution.completed" ||
            event.event_type === "execution.failed" ||
            event.event_type === "execution.simulated"),
      );
      if (hasTerminalEvent) {
        continue;
      }

      const now = new Date().toISOString();
      journal.appendRunEvent(run.run_id, {
        event_type: "execution.outcome_unknown",
        occurred_at: now,
        recorded_at: now,
        payload: {
          action_id: actionId,
          reason: candidate.execution_started ? "daemon_crash_recovery_in_flight" : "daemon_crash_recovery_preflight",
          message: candidate.execution_started
            ? "Daemon restarted after execution began but before a terminal event was recorded. Side effects may have landed; reconcile manually before retrying."
            : "Daemon restarted after a recovery boundary was captured but before a terminal event was recorded. Execution start was not durably observed, so retry only after reviewing the preserved boundary.",
        },
      });
      reconciledActions += 1;
    }
  }

  return reconciledActions;
}

export function reconcileInterruptedIdempotentMutations(journal: RunJournal): number {
  return journal.reconcilePendingIdempotentMutations();
}

export class AuthorityService {
  constructor(
    private readonly deps: ServiceDependencies,
    private readonly options: ServiceOptions,
  ) {}

  dispatch(rawRequest: unknown, context: RequestContext): Promise<ResponseEnvelope<unknown>> {
    return handleRequest(
      this.deps.state,
      this.deps.journal,
      this.deps.adapterRegistry,
      this.deps.snapshotEngine,
      this.deps.compensationRegistry,
      this.deps.broker,
      this.deps.mcpRegistry,
      this.deps.publicHostPolicyRegistry,
      this.deps.hostedWorkerClient,
      this.deps.hostedExecutionQueue,
      this.deps.latencyMetrics,
      this.deps.policyRuntime,
      this.deps.draftStore,
      this.deps.noteStore,
      this.deps.ticketStore,
      this.options,
      rawRequest,
      context,
    );
  }

  rehydrate(): void {
    rehydrateState(this.deps.state, this.deps.journal);
  }

  recoverInterrupted(): number {
    const reconciledActions = recoverInterruptedActions(this.deps.journal);
    reconcileInterruptedIdempotentMutations(this.deps.journal);
    return reconciledActions;
  }

  close(): void {}
}
