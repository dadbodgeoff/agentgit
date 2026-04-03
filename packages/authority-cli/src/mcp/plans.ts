import { AuthorityClient } from "@agentgit/authority-sdk";

import { inputError } from "../cli-contract.js";
import { bulletList, indentBlock, lines } from "../formatters/core.js";

type UpsertMcpSecretInput = Parameters<AuthorityClient["upsertMcpSecret"]>[0];
type UpsertMcpHostPolicyInput = Parameters<AuthorityClient["upsertMcpHostPolicy"]>[0];
type UpsertMcpServerInput = Parameters<AuthorityClient["upsertMcpServer"]>[0];
type SubmitMcpServerCandidateInput = Parameters<AuthorityClient["submitMcpServerCandidate"]>[0];
type ResolveMcpServerCandidateInput = Parameters<AuthorityClient["resolveMcpServerCandidate"]>[0];
type ApproveMcpServerProfileInput = Parameters<AuthorityClient["approveMcpServerProfile"]>[0];
type BindMcpServerCredentialsInput = Parameters<AuthorityClient["bindMcpServerCredentials"]>[0];
type SubmitActionResult = Awaited<ReturnType<AuthorityClient["submitActionAttempt"]>>;
type GetMcpServerReviewResult = Awaited<ReturnType<AuthorityClient["getMcpServerReview"]>>;

export interface McpSmokeTestPlan {
  run_id?: string;
  workflow_name?: string;
  tool_name: string;
  arguments?: Record<string, unknown>;
}

export interface McpOnboardPlan {
  secrets?: UpsertMcpSecretInput[];
  host_policies?: UpsertMcpHostPolicyInput[];
  server: UpsertMcpServerInput;
  smoke_test?: McpSmokeTestPlan;
}

export interface McpOnboardResult {
  executed_at: string;
  workspace_root: string;
  secrets: Array<{
    secret_id: string;
    created: boolean;
    status: string;
  }>;
  host_policies: Array<{
    host: string;
    created: boolean;
  }>;
  server: {
    server_id: string;
    created: boolean;
    transport: string;
  };
  smoke_test: null | {
    run_id: string;
    tool_name: string;
    mode: NonNullable<SubmitActionResult["execution_result"]>["mode"] | null;
    success: boolean;
    summary: string | null;
  };
}

export interface McpTrustReviewPlan {
  secrets?: UpsertMcpSecretInput[];
  host_policies?: UpsertMcpHostPolicyInput[];
  candidate?: SubmitMcpServerCandidateInput;
  resolve: Omit<ResolveMcpServerCandidateInput, "candidate_id"> & {
    candidate_id?: string;
  };
  approval: Omit<ApproveMcpServerProfileInput, "server_profile_id"> & {
    server_profile_id?: string;
  };
  credential_binding?: Omit<BindMcpServerCredentialsInput, "server_profile_id"> & {
    server_profile_id?: string;
  };
  activate?: boolean;
  smoke_test?: McpSmokeTestPlan;
}

export interface McpTrustReviewResult {
  executed_at: string;
  workspace_root: string;
  secrets: McpOnboardResult["secrets"];
  host_policies: McpOnboardResult["host_policies"];
  candidate_submission: null | {
    candidate_id: string;
    source_kind: string;
    submitted: true;
    resolution_state: string;
  };
  resolution: {
    candidate_id: string;
    profile_id: string;
    created_profile: boolean;
    drift_detected: boolean;
    profile_status: string;
    drift_state: string;
    canonical_endpoint: string;
    network_scope: string;
  };
  trust_decision: {
    trust_decision_id: string;
    decision: string;
    created: boolean;
    profile_status: string;
  };
  credential_binding: null | {
    credential_binding_id: string;
    binding_mode: string;
    status: string;
  };
  activation: null | {
    attempted: true;
    profile_status: string;
  };
  smoke_test: McpOnboardResult["smoke_test"];
  review: GetMcpServerReviewResult;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseMcpPlanObjectArray(
  record: Record<string, unknown>,
  field: string,
  context: string,
): Record<string, unknown>[] | undefined {
  const raw = record[field];
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw inputError(`${context} field ${field} must be an array when provided.`);
  }

  return raw.map((entry, index) => {
    if (!isObjectRecord(entry)) {
      throw inputError(`${context} field ${field}[${index}] must be an object.`);
    }
    return entry;
  });
}

function parseMcpSmokeTestPlan(value: unknown, context: string): McpSmokeTestPlan | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isObjectRecord(value)) {
    throw inputError(`${context} field smoke_test must be an object.`);
  }

  const toolName = value.tool_name;
  if (typeof toolName !== "string" || toolName.trim().length === 0) {
    throw inputError(`${context} smoke_test.tool_name must be a non-empty string.`);
  }

  const smokeArguments = value.arguments;
  if (smokeArguments !== undefined && !isObjectRecord(smokeArguments)) {
    throw inputError(`${context} smoke_test.arguments must be a JSON object when provided.`);
  }

  return {
    ...(typeof value.run_id === "string" ? { run_id: value.run_id } : {}),
    ...(typeof value.workflow_name === "string" ? { workflow_name: value.workflow_name } : {}),
    tool_name: toolName,
    ...(smokeArguments ? { arguments: smokeArguments } : {}),
  };
}

export function parseMcpOnboardPlan(value: unknown): McpOnboardPlan {
  if (!isObjectRecord(value)) {
    throw inputError("onboard-mcp expects a JSON object plan.");
  }

  const record = value;
  const server = record.server;
  if (!isObjectRecord(server)) {
    throw inputError("onboard-mcp plan requires a server object.");
  }

  const secrets = parseMcpPlanObjectArray(record, "secrets", "onboard-mcp plan");
  const hostPolicies = parseMcpPlanObjectArray(record, "host_policies", "onboard-mcp plan");
  const smokeTest = parseMcpSmokeTestPlan(record.smoke_test, "onboard-mcp plan");

  return {
    server: server as UpsertMcpServerInput,
    ...(secrets ? { secrets: secrets as UpsertMcpSecretInput[] } : {}),
    ...(hostPolicies ? { host_policies: hostPolicies as UpsertMcpHostPolicyInput[] } : {}),
    ...(smokeTest ? { smoke_test: smokeTest } : {}),
  };
}

export function parseMcpTrustReviewPlan(value: unknown): McpTrustReviewPlan {
  if (!isObjectRecord(value)) {
    throw inputError("trust-review-mcp expects a JSON object plan.");
  }

  const candidate = value.candidate;
  if (candidate !== undefined && !isObjectRecord(candidate)) {
    throw inputError("trust-review-mcp plan field candidate must be an object when provided.");
  }

  const resolve = value.resolve;
  if (!isObjectRecord(resolve)) {
    throw inputError("trust-review-mcp plan requires a resolve object.");
  }

  const approval = value.approval;
  if (!isObjectRecord(approval)) {
    throw inputError("trust-review-mcp plan requires an approval object.");
  }

  const credentialBinding = value.credential_binding;
  if (credentialBinding !== undefined && !isObjectRecord(credentialBinding)) {
    throw inputError("trust-review-mcp plan field credential_binding must be an object when provided.");
  }

  if (value.activate !== undefined && typeof value.activate !== "boolean") {
    throw inputError("trust-review-mcp plan field activate must be a boolean when provided.");
  }

  const secrets = parseMcpPlanObjectArray(value, "secrets", "trust-review-mcp plan");
  const hostPolicies = parseMcpPlanObjectArray(value, "host_policies", "trust-review-mcp plan");
  const smokeTest = parseMcpSmokeTestPlan(value.smoke_test, "trust-review-mcp plan");

  const resolveCandidateId = typeof resolve.candidate_id === "string" ? resolve.candidate_id.trim() : "";
  if (!candidate && resolveCandidateId.length === 0) {
    throw inputError("trust-review-mcp requires either candidate input or resolve.candidate_id.");
  }

  return {
    ...(secrets ? { secrets: secrets as UpsertMcpSecretInput[] } : {}),
    ...(hostPolicies ? { host_policies: hostPolicies as UpsertMcpHostPolicyInput[] } : {}),
    ...(candidate ? { candidate: candidate as SubmitMcpServerCandidateInput } : {}),
    resolve: resolve as McpTrustReviewPlan["resolve"],
    approval: approval as McpTrustReviewPlan["approval"],
    ...(credentialBinding ? { credential_binding: credentialBinding as McpTrustReviewPlan["credential_binding"] } : {}),
    ...(typeof value.activate === "boolean" ? { activate: value.activate } : {}),
    ...(smokeTest ? { smoke_test: smokeTest } : {}),
  };
}

function requireConsistentDerivedId(label: string, providedId: string | undefined, derivedId: string): string {
  if (providedId && providedId !== derivedId) {
    throw inputError(`${label} must match the resolved identifier ${derivedId}.`, {
      label,
      provided_id: providedId,
      resolved_id: derivedId,
    });
  }

  return derivedId;
}

async function executeMcpSmokeTest(
  client: AuthorityClient,
  workspaceRoot: string,
  smokeTest: McpSmokeTestPlan,
  workflowNamePrefix: string,
  rawCall: {
    server_id?: string;
    server_profile_id?: string;
  },
): Promise<NonNullable<McpOnboardResult["smoke_test"]>> {
  const runId =
    smokeTest.run_id ??
    (
      await client.registerRun({
        workflow_name: smokeTest.workflow_name ?? workflowNamePrefix,
        agent_framework: "cli",
        agent_name: "agentgit-cli",
        workspace_roots: [workspaceRoot],
        client_metadata: {
          invoked_from: "authority-cli",
        },
      })
    ).run_id;
  const actionResult = await client.submitActionAttempt({
    run_id: runId,
    tool_registration: {
      tool_name: "mcp_call_tool",
      tool_kind: "mcp",
    },
    raw_call: {
      ...rawCall,
      tool_name: smokeTest.tool_name,
      arguments: smokeTest.arguments ?? {},
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "none",
    },
    framework_context: {
      agent_name: "agentgit-cli",
      agent_framework: "cli",
    },
    received_at: new Date().toISOString(),
  });
  return {
    run_id: runId,
    tool_name: smokeTest.tool_name,
    mode: actionResult.execution_result?.mode ?? null,
    success: actionResult.execution_result?.success ?? false,
    summary:
      actionResult.execution_result && typeof actionResult.execution_result.output === "object"
        ? JSON.stringify(actionResult.execution_result.output)
        : null,
  };
}

export async function runMcpOnboardPlan(
  client: AuthorityClient,
  workspaceRoot: string,
  plan: McpOnboardPlan,
): Promise<McpOnboardResult> {
  const secretResults: McpOnboardResult["secrets"] = [];
  for (const secret of plan.secrets ?? []) {
    const result = await client.upsertMcpSecret(secret);
    secretResults.push({
      secret_id: result.secret.secret_id,
      created: result.created,
      status: result.secret.status,
    });
  }

  const hostPolicyResults: McpOnboardResult["host_policies"] = [];
  for (const hostPolicy of plan.host_policies ?? []) {
    const result = await client.upsertMcpHostPolicy(hostPolicy);
    hostPolicyResults.push({
      host: result.policy.policy.host,
      created: result.created,
    });
  }

  const serverResult = await client.upsertMcpServer(plan.server);
  let smokeTestResult: McpOnboardResult["smoke_test"] = null;
  if (plan.smoke_test) {
    smokeTestResult = await executeMcpSmokeTest(
      client,
      workspaceRoot,
      plan.smoke_test,
      `mcp-onboard-${serverResult.server.server.server_id}`,
      {
        server_id: serverResult.server.server.server_id,
      },
    );
  }

  return {
    executed_at: new Date().toISOString(),
    workspace_root: workspaceRoot,
    secrets: secretResults,
    host_policies: hostPolicyResults,
    server: {
      server_id: serverResult.server.server.server_id,
      created: serverResult.created,
      transport: serverResult.server.server.transport,
    },
    smoke_test: smokeTestResult,
  };
}

export async function runMcpTrustReviewPlan(
  client: AuthorityClient,
  workspaceRoot: string,
  plan: McpTrustReviewPlan,
): Promise<McpTrustReviewResult> {
  const secretResults: McpTrustReviewResult["secrets"] = [];
  for (const secret of plan.secrets ?? []) {
    const result = await client.upsertMcpSecret(secret);
    secretResults.push({
      secret_id: result.secret.secret_id,
      created: result.created,
      status: result.secret.status,
    });
  }

  const hostPolicyResults: McpTrustReviewResult["host_policies"] = [];
  for (const hostPolicy of plan.host_policies ?? []) {
    const result = await client.upsertMcpHostPolicy(hostPolicy);
    hostPolicyResults.push({
      host: result.policy.policy.host,
      created: result.created,
    });
  }

  let candidateSubmission: McpTrustReviewResult["candidate_submission"] = null;
  let candidateId = typeof plan.resolve.candidate_id === "string" ? plan.resolve.candidate_id.trim() : "";
  if (plan.candidate) {
    const submitted = await client.submitMcpServerCandidate(plan.candidate);
    candidateId = submitted.candidate.candidate_id;
    candidateSubmission = {
      candidate_id: submitted.candidate.candidate_id,
      source_kind: submitted.candidate.source_kind,
      submitted: true,
      resolution_state: submitted.candidate.resolution_state,
    };
  }

  const resolvePayload = {
    ...plan.resolve,
    candidate_id: requireConsistentDerivedId("resolve.candidate_id", plan.resolve.candidate_id, candidateId),
  } satisfies ResolveMcpServerCandidateInput;
  const resolveResult = await client.resolveMcpServerCandidate(resolvePayload);
  const profileId = resolveResult.profile.server_profile_id;

  const approvalPayload = {
    ...plan.approval,
    server_profile_id: requireConsistentDerivedId(
      "approval.server_profile_id",
      plan.approval.server_profile_id,
      profileId,
    ),
  } satisfies ApproveMcpServerProfileInput;
  const approvalResult = await client.approveMcpServerProfile(approvalPayload);

  let credentialBindingResult: McpTrustReviewResult["credential_binding"] = null;
  if (plan.credential_binding) {
    const bindingPayload = {
      ...plan.credential_binding,
      server_profile_id: requireConsistentDerivedId(
        "credential_binding.server_profile_id",
        plan.credential_binding.server_profile_id,
        profileId,
      ),
    } satisfies BindMcpServerCredentialsInput;
    const bindResult = await client.bindMcpServerCredentials(bindingPayload);
    credentialBindingResult = {
      credential_binding_id: bindResult.credential_binding.credential_binding_id,
      binding_mode: bindResult.credential_binding.binding_mode,
      status: bindResult.credential_binding.status,
    };
  }

  let activationResult: McpTrustReviewResult["activation"] = null;
  if (plan.activate !== false) {
    const activated = await client.activateMcpServerProfile(profileId);
    activationResult = {
      attempted: true,
      profile_status: activated.profile.status,
    };
  }

  const smokeTestResult = !plan.smoke_test
    ? null
    : await executeMcpSmokeTest(client, workspaceRoot, plan.smoke_test, `mcp-trust-review-${profileId}`, {
        server_profile_id: profileId,
      });

  const review = await client.getMcpServerReview({
    server_profile_id: profileId,
  });

  return {
    executed_at: new Date().toISOString(),
    workspace_root: workspaceRoot,
    secrets: secretResults,
    host_policies: hostPolicyResults,
    candidate_submission: candidateSubmission,
    resolution: {
      candidate_id: resolveResult.candidate.candidate_id,
      profile_id: profileId,
      created_profile: resolveResult.created_profile,
      drift_detected: resolveResult.drift_detected,
      profile_status: resolveResult.profile.status,
      drift_state: resolveResult.profile.drift_state,
      canonical_endpoint: resolveResult.profile.canonical_endpoint,
      network_scope: resolveResult.profile.network_scope,
    },
    trust_decision: {
      trust_decision_id: approvalResult.trust_decision.trust_decision_id,
      decision: approvalResult.trust_decision.decision,
      created: approvalResult.created,
      profile_status: approvalResult.profile.status,
    },
    credential_binding: credentialBindingResult,
    activation: activationResult,
    smoke_test: smokeTestResult,
    review,
  };
}

export function formatMcpOnboardResult(result: McpOnboardResult): string {
  const secrets =
    result.secrets.length === 0
      ? "none"
      : `\n${bulletList(result.secrets.map((secret) => `${secret.secret_id} [${secret.status}] created=${secret.created ? "yes" : "no"}`))}`;
  const hostPolicies =
    result.host_policies.length === 0
      ? "none"
      : `\n${bulletList(result.host_policies.map((policy) => `${policy.host} created=${policy.created ? "yes" : "no"}`))}`;
  const smokeTest = !result.smoke_test
    ? "none"
    : lines(
        `Run id: ${result.smoke_test.run_id}`,
        `Tool: ${result.smoke_test.tool_name}`,
        `Execution mode: ${result.smoke_test.mode ?? "none"}`,
        `Success: ${result.smoke_test.success ? "yes" : "no"}`,
        `Summary: ${result.smoke_test.summary ?? "none"}`,
      );

  return lines(
    `MCP onboarding completed for ${result.server.server_id}`,
    `Executed at: ${result.executed_at}`,
    `Workspace root: ${result.workspace_root}`,
    `Server transport: ${result.server.transport}`,
    `Server created: ${result.server.created ? "yes" : "no"}`,
    `Secrets:${secrets}`,
    `Host policies:${hostPolicies}`,
    `Smoke test:\n${indentBlock(smokeTest, 2)}`,
  );
}

export function formatMcpTrustReviewResult(result: McpTrustReviewResult): string {
  const secrets =
    result.secrets.length === 0
      ? "none"
      : `\n${bulletList(result.secrets.map((secret) => `${secret.secret_id} [${secret.status}] created=${secret.created ? "yes" : "no"}`))}`;
  const hostPolicies =
    result.host_policies.length === 0
      ? "none"
      : `\n${bulletList(result.host_policies.map((policy) => `${policy.host} created=${policy.created ? "yes" : "no"}`))}`;
  const candidateSubmission = !result.candidate_submission
    ? "Reused existing candidate"
    : lines(
        `Candidate: ${result.candidate_submission.candidate_id}`,
        `Source: ${result.candidate_submission.source_kind}`,
        `Resolution state: ${result.candidate_submission.resolution_state}`,
      );
  const credentialBinding = !result.credential_binding
    ? "none"
    : lines(
        `Binding: ${result.credential_binding.credential_binding_id}`,
        `Mode: ${result.credential_binding.binding_mode}`,
        `Status: ${result.credential_binding.status}`,
      );
  const activation = !result.activation
    ? "skipped"
    : lines(`Attempted: yes`, `Profile status: ${result.activation.profile_status}`);
  const smokeTest = !result.smoke_test
    ? "none"
    : lines(
        `Run id: ${result.smoke_test.run_id}`,
        `Tool: ${result.smoke_test.tool_name}`,
        `Execution mode: ${result.smoke_test.mode ?? "none"}`,
        `Success: ${result.smoke_test.success ? "yes" : "no"}`,
        `Summary: ${result.smoke_test.summary ?? "none"}`,
      );
  const review = lines(
    `Target: ${result.review.review.review_target}`,
    `Executable: ${result.review.review.executable ? "yes" : "no"}`,
    `Activation ready: ${result.review.review.activation_ready ? "yes" : "no"}`,
    `Requires resolution: ${result.review.review.requires_resolution ? "yes" : "no"}`,
    `Requires approval: ${result.review.review.requires_approval ? "yes" : "no"}`,
    `Requires credentials: ${result.review.review.requires_credentials ? "yes" : "no"}`,
    `Requires reapproval: ${result.review.review.requires_reapproval ? "yes" : "no"}`,
    `Execution support: local_proxy=${result.review.review.local_proxy_supported ? "yes" : "no"}, hosted=${result.review.review.hosted_execution_supported ? "yes" : "no"}`,
    result.review.review.warnings.length > 0
      ? `Warnings:\n${bulletList(result.review.review.warnings)}`
      : "Warnings: none",
    result.review.review.recommended_actions.length > 0
      ? `Recommended actions:\n${bulletList(result.review.review.recommended_actions)}`
      : "Recommended actions: none",
  );

  return lines(
    `MCP trust review completed for ${result.resolution.profile_id}`,
    `Executed at: ${result.executed_at}`,
    `Workspace root: ${result.workspace_root}`,
    `Candidate submission:\n${indentBlock(candidateSubmission, 2)}`,
    `Resolved endpoint: ${result.resolution.canonical_endpoint}`,
    `Network scope: ${result.resolution.network_scope}`,
    `Profile status after resolve: ${result.resolution.profile_status}`,
    `Drift state after resolve: ${result.resolution.drift_state}`,
    `Trust decision: ${result.trust_decision.trust_decision_id} [${result.trust_decision.decision}] created=${result.trust_decision.created ? "yes" : "no"}`,
    `Profile status after approval: ${result.trust_decision.profile_status}`,
    `Secrets:${secrets}`,
    `Host policies:${hostPolicies}`,
    `Credential binding:\n${indentBlock(credentialBinding, 2)}`,
    `Activation:\n${indentBlock(activation, 2)}`,
    `Smoke test:\n${indentBlock(smokeTest, 2)}`,
    `Final review:\n${indentBlock(review, 2)}`,
  );
}
