import { AuthorityClient } from "@agentgit/authority-sdk";

import { CLI_EXIT_CODES, inputError, usageError } from "../cli-contract.js";
import { parseSecretCommandOptions, secretUsage } from "../cli-secret-input.js";
import { printResult } from "../cli-output.js";
import { lines } from "../formatters/core.js";
import {
  formatCancelHostedMcpJob,
  formatHostedMcpJob,
  formatHostedMcpJobs,
  formatMcpHostPolicies,
  formatMcpSecrets,
  formatMcpServerCandidates,
  formatMcpServerCredentialBindings,
  formatMcpServerProfiles,
  formatMcpServerReview,
  formatMcpServers,
  formatMcpServerTrustDecisions,
  formatRequeueHostedMcpJob,
} from "../formatters/mcp.js";
import {
  formatMcpOnboardResult,
  formatMcpTrustReviewResult,
  runMcpOnboardPlan,
  runMcpTrustReviewPlan,
  parseMcpOnboardPlan,
  parseMcpTrustReviewPlan,
} from "../mcp/plans.js";
import { parseIntegerFlag, parseJsonArgOrFile, shiftCommandValue } from "../parsers/common.js";

type ListHostedMcpJobsResult = Awaited<ReturnType<AuthorityClient["listHostedMcpJobs"]>>;
type HostedMcpJobStatus = ListHostedMcpJobsResult["jobs"][number]["status"];
type HostedMcpJobLifecycleState = Awaited<
  ReturnType<AuthorityClient["getHostedMcpJob"]>
>["lifecycle"]["state"];

const MCP_COMMANDS = new Set([
  "onboard-mcp",
  "trust-review-mcp",
  "list-mcp-servers",
  "list-mcp-server-candidates",
  "submit-mcp-server-candidate",
  "list-mcp-server-profiles",
  "show-mcp-server-review",
  "resolve-mcp-server-candidate",
  "list-mcp-server-trust-decisions",
  "approve-mcp-server-profile",
  "list-mcp-server-credential-bindings",
  "bind-mcp-server-credentials",
  "revoke-mcp-server-credentials",
  "activate-mcp-server-profile",
  "quarantine-mcp-server-profile",
  "revoke-mcp-server-profile",
  "list-mcp-secrets",
  "list-mcp-host-policies",
  "upsert-mcp-secret",
  "remove-mcp-secret",
  "upsert-mcp-host-policy",
  "remove-mcp-host-policy",
  "show-hosted-mcp-job",
  "list-hosted-mcp-jobs",
  "requeue-hosted-mcp-job",
  "cancel-hosted-mcp-job",
  "upsert-mcp-server",
  "remove-mcp-server",
]);

const HOSTED_MCP_JOB_STATUSES = new Set<HostedMcpJobStatus>([
  "queued",
  "running",
  "cancel_requested",
  "succeeded",
  "failed",
  "canceled",
]);

const HOSTED_MCP_JOB_LIFECYCLE_STATES = new Set<HostedMcpJobLifecycleState>([
  "queued",
  "running",
  "cancel_requested",
  "succeeded",
  "dead_letter_retryable",
  "dead_letter_non_retryable",
  "canceled",
]);

function parseHostedMcpJobFilter(value: string | undefined): {
  status?: HostedMcpJobStatus;
  lifecycle_state?: HostedMcpJobLifecycleState;
} {
  if (!value) {
    return {};
  }

  if (HOSTED_MCP_JOB_STATUSES.has(value as HostedMcpJobStatus)) {
    return {
      status: value as HostedMcpJobStatus,
    };
  }

  if (HOSTED_MCP_JOB_LIFECYCLE_STATES.has(value as HostedMcpJobLifecycleState)) {
    return {
      lifecycle_state: value as HostedMcpJobLifecycleState,
    };
  }

  throw inputError(
    "Hosted MCP job filter must be one of queued, running, cancel_requested, succeeded, failed, canceled, dead_letter_retryable, or dead_letter_non_retryable.",
    {
      filter: value,
    },
  );
}

function parseRequeueHostedMcpJobOptions(args: string[]): {
  reset_attempt_count?: boolean;
  max_attempts?: number;
  reason?: string;
} {
  const options: {
    reset_attempt_count?: boolean;
    max_attempts?: number;
    reason?: string;
  } = {};
  const rest = [...args];

  while (rest.length > 0) {
    const current = rest.shift();
    switch (current) {
      case "--reset-attempts":
        options.reset_attempt_count = true;
        break;
      case "--max-attempts":
        options.max_attempts = parseIntegerFlag(shiftCommandValue(rest, "--max-attempts"), "--max-attempts");
        if ((options.max_attempts ?? 0) < 1) {
          throw inputError("--max-attempts expects a positive integer.", {
            flag: "--max-attempts",
            value: options.max_attempts,
          });
        }
        break;
      case "--reason":
        options.reason = shiftCommandValue(rest, "--reason");
        if (options.reason.trim().length === 0) {
          throw inputError("--reason expects a non-empty value.", {
            flag: "--reason",
          });
        }
        break;
      default:
        throw inputError(`Unknown requeue-hosted-mcp-job flag: ${current}`, {
          flag: current,
        });
    }
  }

  return options;
}

function parseCancelHostedMcpJobOptions(args: string[]): {
  reason?: string;
} {
  const options: {
    reason?: string;
  } = {};
  const rest = [...args];

  while (rest.length > 0) {
    const current = rest.shift();
    switch (current) {
      case "--reason":
        options.reason = shiftCommandValue(rest, "--reason");
        if (options.reason.trim().length === 0) {
          throw inputError("--reason expects a non-empty value.", {
            flag: "--reason",
          });
        }
        break;
      default:
        throw inputError(`Unknown cancel-hosted-mcp-job flag: ${current}`, {
          flag: current,
        });
    }
  }

  return options;
}

export function isMcpCommand(command: string): boolean {
  return MCP_COMMANDS.has(command);
}

export async function runMcpCommand(options: {
  command: string;
  client: AuthorityClient;
  workspaceRoot: string;
  rest: string[];
  jsonOutput: boolean;
}): Promise<void> {
  const { command, client, workspaceRoot, rest, jsonOutput } = options;

  switch (command) {
    case "onboard-mcp": {
      const planArg = rest[0];
      if (!planArg) {
        throw usageError("Usage: agentgit-authority [global-flags] onboard-mcp <plan-json-or-path>");
      }
      if (rest.length > 1) {
        throw usageError("Usage: agentgit-authority [global-flags] onboard-mcp <plan-json-or-path>");
      }

      const parsedPlan = parseMcpOnboardPlan(parseJsonArgOrFile(planArg));
      const result = await runMcpOnboardPlan(client, workspaceRoot, parsedPlan);
      printResult(result, jsonOutput, formatMcpOnboardResult);
      if (result.smoke_test && !result.smoke_test.success) {
        process.exitCode = CLI_EXIT_CODES.UNAVAILABLE;
      }
      return;
    }
    case "trust-review-mcp": {
      const planArg = rest[0];
      if (!planArg) {
        throw usageError("Usage: agentgit-authority [global-flags] trust-review-mcp <plan-json-or-path>");
      }
      if (rest.length > 1) {
        throw usageError("Usage: agentgit-authority [global-flags] trust-review-mcp <plan-json-or-path>");
      }

      const parsedPlan = parseMcpTrustReviewPlan(parseJsonArgOrFile(planArg));
      const result = await runMcpTrustReviewPlan(client, workspaceRoot, parsedPlan);
      printResult(result, jsonOutput, formatMcpTrustReviewResult);
      if ((result.smoke_test && !result.smoke_test.success) || !result.review.review.executable) {
        process.exitCode = CLI_EXIT_CODES.UNAVAILABLE;
      }
      return;
    }
    case "list-mcp-servers": {
      const result = await client.listMcpServers();
      printResult(result, jsonOutput, formatMcpServers);
      return;
    }
    case "list-mcp-server-candidates": {
      const result = await client.listMcpServerCandidates();
      printResult(result, jsonOutput, formatMcpServerCandidates);
      return;
    }
    case "submit-mcp-server-candidate": {
      const definitionArg = rest[0];

      if (!definitionArg) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] submit-mcp-server-candidate <definition-json-or-path>",
        );
      }

      const result = await client.submitMcpServerCandidate(
        parseJsonArgOrFile(definitionArg) as Parameters<AuthorityClient["submitMcpServerCandidate"]>[0],
      );
      printResult(result, jsonOutput, (value) =>
        lines(
          `Submitted MCP server candidate ${value.candidate.candidate_id}`,
          `Source: ${value.candidate.source_kind}`,
          `Resolution state: ${value.candidate.resolution_state}`,
          `Submitted: ${value.candidate.submitted_at}`,
        ),
      );
      return;
    }
    case "list-mcp-server-profiles": {
      const result = await client.listMcpServerProfiles();
      printResult(result, jsonOutput, formatMcpServerProfiles);
      return;
    }
    case "show-mcp-server-review": {
      const reviewTargetId = rest[0];

      if (!reviewTargetId) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] show-mcp-server-review <candidate-id|server-profile-id>",
        );
      }

      const result = await client.getMcpServerReview(
        reviewTargetId.startsWith("mcpcand_")
          ? { candidate_id: reviewTargetId }
          : { server_profile_id: reviewTargetId },
      );
      printResult(result, jsonOutput, formatMcpServerReview);
      return;
    }
    case "resolve-mcp-server-candidate": {
      const definitionArg = rest[0];

      if (!definitionArg) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] resolve-mcp-server-candidate <definition-json-or-path>",
        );
      }

      const result = await client.resolveMcpServerCandidate(
        parseJsonArgOrFile(definitionArg) as Parameters<AuthorityClient["resolveMcpServerCandidate"]>[0],
      );
      printResult(result, jsonOutput, (value) =>
        lines(
          `Resolved MCP server candidate ${value.candidate.candidate_id}`,
          `Profile: ${value.profile.server_profile_id}`,
          `Created profile: ${value.created_profile ? "yes" : "no"}`,
          `Drift detected: ${value.drift_detected ? "yes" : "no"}`,
          `Profile status: ${value.profile.status}`,
        ),
      );
      return;
    }
    case "list-mcp-server-trust-decisions": {
      const result = await client.listMcpServerTrustDecisions(rest[0]);
      printResult(result, jsonOutput, formatMcpServerTrustDecisions);
      return;
    }
    case "list-mcp-server-credential-bindings": {
      const result = await client.listMcpServerCredentialBindings(rest[0]);
      printResult(result, jsonOutput, formatMcpServerCredentialBindings);
      return;
    }
    case "bind-mcp-server-credentials": {
      const definitionArg = rest[0];

      if (!definitionArg) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] bind-mcp-server-credentials <definition-json-or-path>",
        );
      }

      const result = await client.bindMcpServerCredentials(
        parseJsonArgOrFile(definitionArg) as Parameters<AuthorityClient["bindMcpServerCredentials"]>[0],
      );
      printResult(result, jsonOutput, (value) =>
        lines(
          `Bound MCP server credentials ${value.credential_binding.credential_binding_id}`,
          `Profile: ${value.profile.server_profile_id}`,
          `Binding mode: ${value.credential_binding.binding_mode}`,
          `Status: ${value.credential_binding.status}`,
        ),
      );
      return;
    }
    case "revoke-mcp-server-credentials": {
      const credentialBindingId = rest[0];

      if (!credentialBindingId) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] revoke-mcp-server-credentials <credential-binding-id>",
        );
      }

      const result = await client.revokeMcpServerCredentials(credentialBindingId);
      printResult(result, jsonOutput, (value) =>
        lines(
          `Revoked MCP server credentials ${value.credential_binding.credential_binding_id}`,
          `Profile: ${value.credential_binding.server_profile_id}`,
          `Status: ${value.credential_binding.status}`,
        ),
      );
      return;
    }
    case "approve-mcp-server-profile": {
      const definitionArg = rest[0];

      if (!definitionArg) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] approve-mcp-server-profile <definition-json-or-path>",
        );
      }

      const result = await client.approveMcpServerProfile(
        parseJsonArgOrFile(definitionArg) as Parameters<AuthorityClient["approveMcpServerProfile"]>[0],
      );
      printResult(result, jsonOutput, (value) =>
        lines(
          `Recorded MCP profile trust decision ${value.trust_decision.trust_decision_id}`,
          `Profile: ${value.profile.server_profile_id}`,
          `Decision: ${value.trust_decision.decision}`,
          `Profile status: ${value.profile.status}`,
        ),
      );
      return;
    }
    case "activate-mcp-server-profile": {
      const serverProfileId = rest[0];

      if (!serverProfileId) {
        throw usageError("Usage: agentgit-authority [global-flags] activate-mcp-server-profile <server-profile-id>");
      }

      const result = await client.activateMcpServerProfile(serverProfileId);
      printResult(result, jsonOutput, (value) =>
        lines(`Activated MCP server profile ${value.profile.server_profile_id}`, `Status: ${value.profile.status}`),
      );
      return;
    }
    case "quarantine-mcp-server-profile": {
      const definitionArg = rest[0];

      if (!definitionArg) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] quarantine-mcp-server-profile <definition-json-or-path>",
        );
      }

      const result = await client.quarantineMcpServerProfile(
        parseJsonArgOrFile(definitionArg) as Parameters<AuthorityClient["quarantineMcpServerProfile"]>[0],
      );
      printResult(result, jsonOutput, (value) =>
        lines(
          `Quarantined MCP server profile ${value.profile.server_profile_id}`,
          `Status: ${value.profile.status}`,
          `Reason codes: ${value.profile.quarantine_reason_codes.join(", ") || "none"}`,
        ),
      );
      return;
    }
    case "revoke-mcp-server-profile": {
      const definitionArg = rest[0];

      if (!definitionArg) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] revoke-mcp-server-profile <definition-json-or-path>",
        );
      }

      const result = await client.revokeMcpServerProfile(
        parseJsonArgOrFile(definitionArg) as Parameters<AuthorityClient["revokeMcpServerProfile"]>[0],
      );
      printResult(result, jsonOutput, (value) =>
        lines(
          `Revoked MCP server profile ${value.profile.server_profile_id}`,
          `Status: ${value.profile.status}`,
          `Reason codes: ${value.profile.quarantine_reason_codes.join(", ") || "none"}`,
        ),
      );
      return;
    }
    case "list-mcp-secrets": {
      const result = await client.listMcpSecrets();
      printResult(result, jsonOutput, formatMcpSecrets);
      return;
    }
    case "list-mcp-host-policies": {
      const result = await client.listMcpHostPolicies();
      printResult(result, jsonOutput, formatMcpHostPolicies);
      return;
    }
    case "upsert-mcp-secret": {
      if (rest.length === 0) {
        throw usageError(secretUsage());
      }

      const parsedSecret = await parseSecretCommandOptions(rest, workspaceRoot);

      const result = await client.upsertMcpSecret({
        secret_id: parsedSecret.secretId,
        ...(parsedSecret.displayName ? { display_name: parsedSecret.displayName } : {}),
        ...(parsedSecret.expiresAt ? { expires_at: parsedSecret.expiresAt } : {}),
        bearer_token: parsedSecret.bearerToken,
      } as Parameters<AuthorityClient["upsertMcpSecret"]>[0]);
      printResult(result, jsonOutput, (value) =>
        lines(
          `${value.created ? "Stored" : value.rotated ? "Rotated" : "Updated"} MCP secret ${value.secret.secret_id}`,
          `Version: ${value.secret.version}`,
          `Updated: ${value.secret.updated_at}`,
        ),
      );
      return;
    }
    case "remove-mcp-secret": {
      const secretId = rest[0];

      if (!secretId) {
        throw usageError("Usage: agentgit-authority [global-flags] remove-mcp-secret <secret-id>");
      }

      const result = await client.removeMcpSecret(secretId);
      printResult(result, jsonOutput, (value) =>
        value.removed
          ? `Removed MCP secret ${value.removed_secret?.secret_id ?? secretId}`
          : `No MCP secret named ${secretId} was stored.`,
      );
      return;
    }
    case "upsert-mcp-host-policy": {
      const definitionArg = rest[0];

      if (!definitionArg) {
        throw usageError("Usage: agentgit-authority [global-flags] upsert-mcp-host-policy <definition-json-or-path>");
      }

      const result = await client.upsertMcpHostPolicy(
        parseJsonArgOrFile(definitionArg) as Parameters<AuthorityClient["upsertMcpHostPolicy"]>[0],
      );
      printResult(result, jsonOutput, (value) =>
        lines(
          `${value.created ? "Registered" : "Updated"} MCP host policy ${value.policy.policy.host}`,
          `Allow subdomains: ${value.policy.policy.allow_subdomains ? "yes" : "no"}`,
          `Updated: ${value.policy.updated_at}`,
        ),
      );
      return;
    }
    case "remove-mcp-host-policy": {
      const host = rest[0];

      if (!host) {
        throw usageError("Usage: agentgit-authority [global-flags] remove-mcp-host-policy <host>");
      }

      const result = await client.removeMcpHostPolicy(host);
      printResult(result, jsonOutput, (value) =>
        value.removed
          ? `Removed MCP host policy ${value.removed_policy?.policy.host ?? host}`
          : `No MCP host policy for ${host} was registered.`,
      );
      return;
    }
    case "show-hosted-mcp-job": {
      const jobId = rest[0];

      if (!jobId) {
        throw usageError("Usage: agentgit-authority [global-flags] show-hosted-mcp-job <job-id>");
      }

      const result = await client.getHostedMcpJob(jobId);
      printResult(result, jsonOutput, formatHostedMcpJob);
      return;
    }
    case "list-hosted-mcp-jobs": {
      const serverProfileId = rest[0];
      const filter = parseHostedMcpJobFilter(rest[1]);
      const result = await client.listHostedMcpJobs({
        ...(serverProfileId ? { server_profile_id: serverProfileId } : {}),
        ...filter,
      });
      printResult(result, jsonOutput, formatHostedMcpJobs);
      return;
    }
    case "requeue-hosted-mcp-job": {
      const jobId = rest[0];

      if (!jobId) {
        throw usageError(
          "Usage: agentgit-authority [global-flags] requeue-hosted-mcp-job <job-id> [--reset-attempts] [--max-attempts <n>] [--reason <text>]",
        );
      }

      const result = await client.requeueHostedMcpJob(jobId, parseRequeueHostedMcpJobOptions(rest.slice(1)));
      printResult(result, jsonOutput, formatRequeueHostedMcpJob);
      return;
    }
    case "cancel-hosted-mcp-job": {
      const jobId = rest[0];

      if (!jobId) {
        throw usageError("Usage: agentgit-authority [global-flags] cancel-hosted-mcp-job <job-id> [--reason <text>]");
      }

      const result = await client.cancelHostedMcpJob(jobId, parseCancelHostedMcpJobOptions(rest.slice(1)));
      printResult(result, jsonOutput, formatCancelHostedMcpJob);
      return;
    }
    case "upsert-mcp-server": {
      const definitionArg = rest[0];

      if (!definitionArg) {
        throw usageError("Usage: agentgit-authority [global-flags] upsert-mcp-server <definition-json-or-path>");
      }

      const result = await client.upsertMcpServer(
        parseJsonArgOrFile(definitionArg) as Parameters<AuthorityClient["upsertMcpServer"]>[0],
      );
      printResult(result, jsonOutput, (value) =>
        lines(
          `${value.created ? "Registered" : "Updated"} MCP server ${value.server.server.server_id}`,
          `Transport: ${value.server.server.transport}`,
          `Source: ${value.server.source}`,
          `Updated: ${value.server.updated_at}`,
        ),
      );
      return;
    }
    case "remove-mcp-server": {
      const serverId = rest[0];

      if (!serverId) {
        throw usageError("Usage: agentgit-authority [global-flags] remove-mcp-server <server-id>");
      }

      const result = await client.removeMcpServer(serverId);
      printResult(result, jsonOutput, (value) =>
        value.removed
          ? `Removed MCP server ${value.removed_server?.server.server_id ?? serverId}`
          : `No MCP server named ${serverId} was registered.`,
      );
      return;
    }
    default:
      throw usageError(`Unsupported MCP command: ${command}`);
  }
}
