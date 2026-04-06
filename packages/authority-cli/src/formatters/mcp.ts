import type { AuthorityClient } from "@agentgit/authority-sdk";

import { bulletList, lines, maybeLine } from "./core.js";

type ListMcpServersResult = Awaited<ReturnType<AuthorityClient["listMcpServers"]>>;
type ListMcpServerCandidatesResult = Awaited<ReturnType<AuthorityClient["listMcpServerCandidates"]>>;
type ListMcpServerProfilesResult = Awaited<ReturnType<AuthorityClient["listMcpServerProfiles"]>>;
type GetMcpServerReviewResult = Awaited<ReturnType<AuthorityClient["getMcpServerReview"]>>;
type ListMcpServerTrustDecisionsResult = Awaited<ReturnType<AuthorityClient["listMcpServerTrustDecisions"]>>;
type ListMcpServerCredentialBindingsResult = Awaited<ReturnType<AuthorityClient["listMcpServerCredentialBindings"]>>;
type ListMcpSecretsResult = Awaited<ReturnType<AuthorityClient["listMcpSecrets"]>>;
type ListMcpHostPoliciesResult = Awaited<ReturnType<AuthorityClient["listMcpHostPolicies"]>>;
type ListHostedMcpJobsResult = Awaited<ReturnType<AuthorityClient["listHostedMcpJobs"]>>;
type ShowHostedMcpJobResult = Awaited<ReturnType<AuthorityClient["getHostedMcpJob"]>>;
type RequeueHostedMcpJobResult = Awaited<ReturnType<AuthorityClient["requeueHostedMcpJob"]>>;
type CancelHostedMcpJobResult = Awaited<ReturnType<AuthorityClient["cancelHostedMcpJob"]>>;
type RegisteredMcpServer = ListMcpServersResult["servers"][number];
type RegisteredMcpSecret = ListMcpSecretsResult["secrets"][number];
type RegisteredMcpHostPolicy = ListMcpHostPoliciesResult["policies"][number];

export function formatMcpServers(result: ListMcpServersResult): string {
  const serverLines =
    result.servers.length === 0
      ? "No local governed MCP servers are registered."
      : result.servers
          .map((record: RegisteredMcpServer) => {
            const transportTarget =
              record.server.transport === "streamable_http" ? record.server.url : record.server.command;
            return lines(
              `- ${record.server.server_id} [${record.server.transport}]`,
              maybeLine("  Display name", record.server.display_name),
              `  Source: ${record.source}`,
              `  Transport target: ${transportTarget}`,
              record.server.transport === "streamable_http"
                ? `  Network scope: ${record.server.network_scope ?? "loopback"}`
                : null,
              record.server.transport === "streamable_http"
                ? `  Max concurrent calls: ${record.server.max_concurrent_calls ?? 1}`
                : null,
              `  Tools: ${record.server.tools.map((tool) => `${tool.tool_name}:${tool.side_effect_level}:${tool.approval_mode ?? "ask"}`).join(", ")}`,
              `  Created: ${record.created_at}`,
              `  Updated: ${record.updated_at}`,
            );
          })
          .join("\n\n");

  return lines("Local governed MCP servers", serverLines);
}

export function formatMcpServerCandidates(result: ListMcpServerCandidatesResult): string {
  const candidateLines =
    result.candidates.length === 0
      ? "No MCP server candidates have been submitted."
      : result.candidates
          .map((candidate) =>
            lines(
              `- ${candidate.candidate_id} [${candidate.source_kind}]`,
              `  Raw endpoint: ${candidate.raw_endpoint}`,
              `  Transport hint: ${candidate.transport_hint ?? "unspecified"}`,
              `  Resolution state: ${candidate.resolution_state}`,
              `  Submitted by session: ${candidate.submitted_by_session_id ?? "unknown"}`,
              `  Submitted by run: ${candidate.submitted_by_run_id ?? "none"}`,
              `  Workspace: ${candidate.workspace_id ?? "none"}`,
              maybeLine("  Notes", candidate.notes ?? undefined),
              maybeLine("  Resolution error", candidate.resolution_error ?? undefined),
              `  Submitted: ${candidate.submitted_at}`,
              `  Updated: ${candidate.updated_at}`,
            ),
          )
          .join("\n\n");

  return lines("MCP server candidates", candidateLines);
}

export function formatMcpServerProfiles(result: ListMcpServerProfilesResult): string {
  const profileLines =
    result.profiles.length === 0
      ? "No MCP server profiles have been resolved yet."
      : result.profiles
          .map((profile) =>
            lines(
              `- ${profile.server_profile_id} [${profile.status}]`,
              maybeLine("  Display name", profile.display_name ?? undefined),
              `  Transport: ${profile.transport}`,
              `  Canonical endpoint: ${profile.canonical_endpoint}`,
              `  Network scope: ${profile.network_scope}`,
              `  Trust tier: ${profile.trust_tier}`,
              `  Drift state: ${profile.drift_state}`,
              `  Quarantine reasons: ${profile.quarantine_reason_codes.join(", ") || "none"}`,
              `  Execution modes: ${profile.allowed_execution_modes.join(", ") || "none"}`,
              `  Active trust decision: ${profile.active_trust_decision_id ?? "none"}`,
              `  Auth mode: ${profile.auth_descriptor.mode}`,
              `  Candidate: ${profile.candidate_id ?? "none"}`,
              `  Tool inventory version: ${profile.tool_inventory_version ?? "none"}`,
              `  Last resolved: ${profile.last_resolved_at ?? "never"}`,
              `  Created: ${profile.created_at}`,
              `  Updated: ${profile.updated_at}`,
            ),
          )
          .join("\n\n");

  return lines("MCP server profiles", profileLines);
}

export function formatMcpServerReview(result: GetMcpServerReviewResult): string {
  return lines(
    "MCP server review",
    result.candidate
      ? lines(
          `Candidate: ${result.candidate.candidate_id} [${result.candidate.source_kind}]`,
          `Candidate endpoint: ${result.candidate.raw_endpoint}`,
          `Candidate resolution: ${result.candidate.resolution_state}`,
          maybeLine("Candidate resolution error", result.candidate.resolution_error ?? undefined),
        )
      : "Candidate: none",
    result.profile
      ? lines(
          `Profile: ${result.profile.server_profile_id} [${result.profile.status}]`,
          `Profile endpoint: ${result.profile.canonical_endpoint}`,
          `Trust tier: ${result.profile.trust_tier}`,
          `Drift state: ${result.profile.drift_state}`,
          `Execution modes: ${result.profile.allowed_execution_modes.join(", ") || "none"}`,
          `Quarantine reasons: ${result.profile.quarantine_reason_codes.join(", ") || "none"}`,
          `Active trust decision: ${result.active_trust_decision?.trust_decision_id ?? "none"}`,
          `Active credential binding: ${result.active_credential_binding?.credential_binding_id ?? "none"}`,
        )
      : "Profile: none",
    `Executable: ${result.review.executable ? "yes" : "no"}`,
    `Activation ready: ${result.review.activation_ready ? "yes" : "no"}`,
    `Requires resolution: ${result.review.requires_resolution ? "yes" : "no"}`,
    `Requires approval: ${result.review.requires_approval ? "yes" : "no"}`,
    `Requires credentials: ${result.review.requires_credentials ? "yes" : "no"}`,
    `Requires reapproval: ${result.review.requires_reapproval ? "yes" : "no"}`,
    `Execution support: local_proxy=${result.review.local_proxy_supported ? "yes" : "no"}, hosted=${result.review.hosted_execution_supported ? "yes" : "no"}`,
    result.review.warnings.length > 0 ? `Warnings:\n${bulletList(result.review.warnings)}` : "Warnings: none",
    result.review.recommended_actions.length > 0
      ? `Recommended actions:\n${bulletList(result.review.recommended_actions)}`
      : "Recommended actions: none",
  );
}

export function formatMcpServerTrustDecisions(result: ListMcpServerTrustDecisionsResult): string {
  const decisionLines =
    result.trust_decisions.length === 0
      ? "No MCP server trust decisions are recorded."
      : result.trust_decisions
          .map((decision) =>
            lines(
              `- ${decision.trust_decision_id} [${decision.decision}]`,
              `  Profile: ${decision.server_profile_id}`,
              `  Trust tier: ${decision.trust_tier}`,
              `  Execution modes: ${decision.allowed_execution_modes.join(", ") || "none"}`,
              `  Max side effect without approval: ${decision.max_side_effect_level_without_approval}`,
              `  Reason codes: ${decision.reason_codes.join(", ") || "none"}`,
              `  Reapproval triggers: ${decision.reapproval_triggers.join(", ") || "none"}`,
              `  Approved by session: ${decision.approved_by_session_id ?? "unknown"}`,
              `  Approved at: ${decision.approved_at}`,
              `  Valid until: ${decision.valid_until ?? "none"}`,
            ),
          )
          .join("\n\n");

  return lines("MCP server trust decisions", decisionLines);
}

export function formatMcpServerCredentialBindings(result: ListMcpServerCredentialBindingsResult): string {
  const bindingLines =
    result.credential_bindings.length === 0
      ? "No MCP server credential bindings are recorded."
      : result.credential_bindings
          .map((binding) =>
            lines(
              `- ${binding.credential_binding_id} [${binding.binding_mode}]`,
              `  Profile: ${binding.server_profile_id}`,
              `  Broker profile: ${binding.broker_profile_id}`,
              `  Status: ${binding.status}`,
              `  Scope labels: ${binding.scope_labels.join(", ") || "none"}`,
              `  Audience: ${binding.audience ?? "none"}`,
              `  Created: ${binding.created_at}`,
              `  Updated: ${binding.updated_at}`,
              `  Revoked: ${binding.revoked_at ?? "not revoked"}`,
            ),
          )
          .join("\n\n");

  return lines("MCP server credential bindings", bindingLines);
}

export function formatMcpSecrets(result: ListMcpSecretsResult): string {
  const secretLines =
    result.secrets.length === 0
      ? "No governed MCP secrets are stored."
      : result.secrets
          .map((secret: RegisteredMcpSecret) =>
            lines(
              `- ${secret.secret_id} [${secret.auth_type}]`,
              maybeLine("  Display name", secret.display_name ?? undefined),
              `  Version: ${secret.version}`,
              `  Status: ${secret.status}`,
              `  Source: ${secret.source}`,
              `  Created: ${secret.created_at}`,
              `  Updated: ${secret.updated_at}`,
              `  Rotated: ${secret.rotated_at ?? "never"}`,
              `  Last used: ${secret.last_used_at ?? "never"}`,
              `  Expires: ${secret.expires_at ?? "never"}`,
            ),
          )
          .join("\n\n");

  return lines("Governed MCP secrets", secretLines);
}

export function formatMcpHostPolicies(result: ListMcpHostPoliciesResult): string {
  const policyLines =
    result.policies.length === 0
      ? "No governed MCP public host policies are registered."
      : result.policies
          .map((record: RegisteredMcpHostPolicy) =>
            lines(
              `- ${record.policy.host}`,
              maybeLine("  Display name", record.policy.display_name),
              `  Allow subdomains: ${record.policy.allow_subdomains ? "yes" : "no"}`,
              `  Allowed ports: ${record.policy.allowed_ports?.join(", ") ?? "any"}`,
              `  Source: ${record.source}`,
              `  Created: ${record.created_at}`,
              `  Updated: ${record.updated_at}`,
            ),
          )
          .join("\n\n");

  return lines("Governed MCP public host policies", policyLines);
}

export function formatHostedMcpJobs(result: ListHostedMcpJobsResult): string {
  const jobLines =
    result.jobs.length === 0
      ? "No hosted MCP execution jobs matched the requested filters."
      : result.jobs
          .map((job: ListHostedMcpJobsResult["jobs"][number]) =>
            lines(
              `- ${job.job_id} [${job.status}]`,
              `  Server profile: ${job.server_profile_id}`,
              `  Tool: ${job.server_display_name}/${job.tool_name}`,
              `  Attempts: ${job.attempt_count}/${job.max_attempts}`,
              `  Updated: ${job.updated_at}`,
              `  Next attempt: ${job.next_attempt_at}`,
              maybeLine("  Last error", job.last_error?.message ?? null),
            ),
          )
          .join("\n\n");

  return lines(
    "Hosted MCP execution jobs",
    `Summary: ${result.summary.queued} queued, ${result.summary.running} running, ${result.summary.cancel_requested} cancel requested, ${result.summary.succeeded} succeeded, ${result.summary.failed} failed, ${result.summary.canceled} canceled`,
    `Dead-letter summary: ${result.summary.dead_letter_retryable} retryable, ${result.summary.dead_letter_non_retryable} non-retryable`,
    jobLines,
  );
}

export function formatHostedMcpJob(result: ShowHostedMcpJobResult): string {
  return lines(
    `Hosted MCP job ${result.job.job_id}`,
    `Lifecycle: ${result.lifecycle.state}`,
    `Dead-lettered: ${result.lifecycle.dead_lettered ? "yes" : "no"}`,
    `Eligible for requeue: ${result.lifecycle.eligible_for_requeue ? "yes" : "no"}`,
    `Retry budget remaining: ${result.lifecycle.retry_budget_remaining}`,
    `Server profile: ${result.job.server_profile_id}`,
    `Tool: ${result.job.server_display_name}/${result.job.tool_name}`,
    `Attempts: ${result.job.attempt_count}/${result.job.max_attempts}`,
    `Current lease: ${result.job.current_lease_id ?? "none"}`,
    `Cancel requested: ${result.job.cancel_requested_at ?? "no"}`,
    `Cancel reason: ${result.job.cancel_reason ?? "none"}`,
    `Canceled at: ${result.job.canceled_at ?? "not canceled"}`,
    `Last error: ${result.job.last_error?.message ?? "none"}`,
    `Leases: ${result.leases.length}`,
    `Attestations: ${result.attestations.length}`,
    result.recent_events.length > 0
      ? `Recent events:\n${bulletList(
          result.recent_events.map(
            (event) =>
              `${event.sequence} ${event.event_type} @ ${event.occurred_at}${
                event.payload ? ` ${JSON.stringify(event.payload)}` : ""
              }`,
          ),
        )}`
      : "Recent events: none",
  );
}

export function formatRequeueHostedMcpJob(result: RequeueHostedMcpJobResult): string {
  return lines(
    `Requeued hosted MCP job ${result.job.job_id}`,
    `Previous status: ${result.previous_status}`,
    `Current status: ${result.job.status}`,
    `Server profile: ${result.job.server_profile_id}`,
    `Tool: ${result.job.server_display_name}/${result.job.tool_name}`,
    `Attempts: ${result.job.attempt_count}/${result.job.max_attempts}`,
    `Attempt count reset: ${result.attempt_count_reset ? "yes" : "no"}`,
    `Max attempts updated: ${result.max_attempts_updated ? "yes" : "no"}`,
    `Next attempt: ${result.job.next_attempt_at}`,
  );
}

export function formatCancelHostedMcpJob(result: CancelHostedMcpJobResult): string {
  return lines(
    `${result.terminal ? "Canceled" : "Cancellation requested for"} hosted MCP job ${result.job.job_id}`,
    `Previous status: ${result.previous_status}`,
    `Current status: ${result.job.status}`,
    `Server profile: ${result.job.server_profile_id}`,
    `Tool: ${result.job.server_display_name}/${result.job.tool_name}`,
    `Reason: ${result.job.cancel_reason ?? "none"}`,
    `Cancel requested at: ${result.job.cancel_requested_at ?? "unknown"}`,
    `Canceled at: ${result.job.canceled_at ?? "not yet canceled"}`,
  );
}
