import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { API_VERSION } from "@agentgit/schemas";

import { AuthorityClient } from "./index.js";

interface SocketHarness {
  root: string;
  socketPath: string;
  server?: net.Server;
}

const harnesses: SocketHarness[] = [];

function createHarness(): SocketHarness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-sdk-it-"));
  const socketPath = path.join(root, "authority.sock");
  const harness = { root, socketPath };
  harnesses.push(harness);
  return harness;
}

async function closeHarness(harness: SocketHarness): Promise<void> {
  if (harness.server) {
    await new Promise<void>((resolve, reject) => {
      harness.server!.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  if (fs.existsSync(harness.socketPath)) {
    fs.rmSync(harness.socketPath, { force: true });
  }
}

async function startJsonServer(
  harness: SocketHarness,
  onRequest: (request: Record<string, unknown>, socket: net.Socket) => void,
): Promise<void> {
  if (fs.existsSync(harness.socketPath)) {
    fs.rmSync(harness.socketPath, { force: true });
  }

  harness.server = net.createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");

    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      const request = JSON.parse(line) as Record<string, unknown>;
      onRequest(request, socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    harness.server!.once("error", reject);
    harness.server!.listen(harness.socketPath, resolve);
  });
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop()!;
    await closeHarness(harness);
    fs.rmSync(harness.root, { recursive: true, force: true });
  }
});

describe("AuthorityClient transport", () => {
  it("raises a structured transport error when the socket is unavailable", async () => {
    const harness = createHarness();
    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 50,
      maxConnectRetries: 0,
    });

    await expect(client.hello([harness.root])).rejects.toMatchObject({
      name: "AuthorityClientTransportError",
      code: "SOCKET_CONNECT_FAILED",
      retryable: true,
    });
  });

  it("times out cleanly when the daemon does not respond", async () => {
    const harness = createHarness();
    await startJsonServer(harness, () => {
      return;
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 50,
      maxConnectRetries: 0,
    });

    await expect(client.hello([harness.root])).rejects.toMatchObject({
      name: "AuthorityClientTransportError",
      code: "SOCKET_RESPONSE_TIMEOUT",
      retryable: false,
    });
  });

  it("retries a connect failure once and succeeds when the daemon appears", async () => {
    const harness = createHarness();
    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 200,
      maxConnectRetries: 1,
      connectRetryDelayMs: 75,
    });

    setTimeout(() => {
      void startJsonServer(harness, (request, socket) => {
        socket.write(
          `${JSON.stringify({
            api_version: API_VERSION,
            request_id: request.request_id,
            session_id: "sess_test",
            ok: true,
            result: {
              session_id: "sess_test",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: ["hello"],
              },
            },
            error: null,
          })}\n`,
        );
        socket.end();
      });
    }, 20);

    const result = await client.hello([harness.root]);
    expect(result.session_id).toBe("sess_test");
  });

  it("surfaces daemon errors as structured response errors", async () => {
    const harness = createHarness();
    await startJsonServer(harness, (request, socket) => {
      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? null,
          ok: false,
          result: null,
          error: {
            code: "NOT_FOUND",
            error_class: "NotFoundError",
            message: "No run found.",
            details: {
              run_id: "run_missing",
            },
            retryable: false,
          },
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 50,
      maxConnectRetries: 0,
    });

    await expect(client.getRunSummary("run_missing")).rejects.toMatchObject({
      name: "AuthorityDaemonResponseError",
      code: "NOT_FOUND",
      errorClass: "NotFoundError",
      retryable: false,
    });
  });

  it("forwards idempotency keys on mutating requests", async () => {
    const harness = createHarness();
    const seenRequests: Array<Record<string, unknown>> = [];

    await startJsonServer(harness, (request, socket) => {
      seenRequests.push(request);
      const method = request.method;
      const result =
        method === "hello"
          ? {
              session_id: "sess_test",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: ["hello", "register_run", "run_maintenance", "execute_recovery"],
              },
            }
          : method === "register_run"
            ? {
                run_id: "run_test",
                run_handle: {
                  run_id: "run_test",
                  session_id: "sess_test",
                  workflow_name: "demo",
                },
                effective_policy_profile: "local-default",
              }
            : method === "run_maintenance"
              ? {
                  accepted_priority: "administrative",
                  scope: null,
                  jobs: [],
                  stream_id: null,
                }
              : {
                  restored: true,
                  outcome: "restored",
                  executed_at: "2026-03-31T12:00:00.000Z",
                  recovery_plan: {
                    schema_version: "recovery-plan.v1",
                    recovery_plan_id: "rec_test",
                    target: {
                      type: "snapshot_id",
                      snapshot_id: "snap_test",
                    },
                    recovery_class: "automated_restore",
                    strategy: "restore_snapshot",
                    confidence: 0.9,
                    steps: [],
                    impact_preview: {
                      later_actions_affected: 0,
                      overlapping_paths: [],
                      external_effects: [],
                      data_loss_risk: "low",
                    },
                    warnings: [],
                    created_at: "2026-03-31T12:00:00.000Z",
                  },
                };

      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? "sess_test",
          ok: true,
          result,
          error: null,
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 100,
      maxConnectRetries: 0,
    });

    await client.registerRun(
      {
        workflow_name: "demo",
        agent_framework: "cli",
        agent_name: "agentgit-cli",
        workspace_roots: [harness.root],
        client_metadata: {},
      },
      { idempotencyKey: "idem_register" },
    );
    await client.runMaintenance(["capability_refresh"], {}, { idempotencyKey: "idem_maint" });
    await client.executeRecovery("snap_test", { idempotencyKey: "idem_recover" });

    expect(seenRequests.find((request) => request.method === "register_run")?.idempotency_key).toBe("idem_register");
    expect(seenRequests.find((request) => request.method === "run_maintenance")?.idempotency_key).toBe("idem_maint");
    expect(seenRequests.find((request) => request.method === "execute_recovery")?.idempotency_key).toBe("idem_recover");
  });

  it("requests policy inspection, explanation, recommendation, and validation surfaces", async () => {
    const harness = createHarness();
    const seenRequests: Array<Record<string, unknown>> = [];

    await startJsonServer(harness, (request, socket) => {
      seenRequests.push(request);
      const method = request.method;
      const result =
        method === "hello"
          ? {
              session_id: "sess_test",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: [
                  "hello",
                  "get_effective_policy",
                  "get_policy_calibration_report",
                  "explain_policy_action",
                  "get_policy_threshold_recommendations",
                  "validate_policy_config",
                ],
              },
            }
          : method === "get_effective_policy"
            ? {
                policy: {
                  profile_name: "workspace-hardening",
                  policy_version: "2026.04.01",
                  rules: [],
                },
                summary: {
                  profile_name: "workspace-hardening",
                  policy_versions: ["2026.04.01", "builtin.2026-04-01"],
                  compiled_rule_count: 3,
                  loaded_sources: [
                    {
                      scope: "workspace",
                      path: "/tmp/workspace/.agentgit/policy.toml",
                      profile_name: "workspace-hardening",
                      policy_version: "2026.04.01",
                      rule_count: 1,
                    },
                  ],
                  warnings: [],
                },
              }
            : method === "get_policy_calibration_report"
              ? {
                  report: {
                    generated_at: "2026-04-01T12:00:00.000Z",
                    filters: {
                      run_id: "run_policy",
                      include_samples: true,
                      sample_limit: 5,
                    },
                    totals: {
                      sample_count: 1,
                      unique_action_families: 1,
                      confidence: {
                        average: 0.91,
                        min: 0.91,
                        max: 0.91,
                      },
                      decisions: {
                        allow: 0,
                        allow_with_snapshot: 1,
                        ask: 0,
                        deny: 0,
                      },
                      approvals: {
                        requested: 0,
                        pending: 0,
                        approved: 0,
                        denied: 0,
                      },
                      recovery_attempted_count: 0,
                    },
                    action_families: [
                      {
                        action_family: "filesystem/write",
                        sample_count: 1,
                        confidence: {
                          average: 0.91,
                          min: 0.91,
                          max: 0.91,
                        },
                        decisions: {
                          allow: 0,
                          allow_with_snapshot: 1,
                          ask: 0,
                          deny: 0,
                        },
                        approvals: {
                          requested: 0,
                          pending: 0,
                          approved: 0,
                          denied: 0,
                        },
                        snapshot_classes: [{ key: "journal_plus_anchor", count: 1 }],
                        top_matched_rules: [{ key: "builtin.fs.snapshot", count: 1 }],
                        top_reason_codes: [{ key: "SAFE_TO_RUN", count: 1 }],
                        recovery_attempted_count: 0,
                        approval_rate: 0,
                        denial_rate: null,
                      },
                    ],
                    samples: [
                      {
                        sample_id: "run_policy:act_1",
                        run_id: "run_policy",
                        action_id: "act_1",
                        evaluated_at: "2026-04-01T12:00:00.000Z",
                        action_family: "filesystem/write",
                        decision: "allow_with_snapshot",
                        normalization_confidence: 0.91,
                        matched_rules: ["builtin.fs.snapshot"],
                        reason_codes: ["SAFE_TO_RUN"],
                        snapshot_class: "journal_plus_anchor",
                        approval_requested: false,
                        approval_id: null,
                        approval_status: null,
                        resolved_at: null,
                        recovery_attempted: false,
                        recovery_result: null,
                        recovery_class: null,
                        recovery_strategy: null,
                      },
                    ],
                    samples_truncated: false,
                  },
                }
              : method === "explain_policy_action"
                ? {
                    action: {
                      schema_version: "action.v1",
                      action_id: "act_explain",
                      run_id: "run_policy",
                      session_id: "sess_test",
                      status: "normalized",
                      timestamps: {
                        requested_at: "2026-04-01T12:00:00.000Z",
                        normalized_at: "2026-04-01T12:00:01.000Z",
                      },
                      provenance: {
                        mode: "governed",
                        source: "test",
                        confidence: 0.99,
                      },
                      actor: {
                        type: "agent",
                        tool_name: "write_file",
                        tool_kind: "filesystem",
                      },
                      operation: {
                        domain: "filesystem",
                        kind: "write",
                        name: "filesystem.write",
                        display_name: "Write file",
                      },
                      execution_path: {
                        surface: "governed_fs",
                        mode: "pre_execution",
                        credential_mode: "none",
                      },
                      target: {
                        primary: {
                          type: "path",
                          locator: "/workspace/README.md",
                        },
                        scope: {
                          breadth: "single",
                          estimated_count: 1,
                          unknowns: [],
                        },
                      },
                      input: {
                        raw: {},
                        redacted: {},
                        schema_ref: null,
                        contains_sensitive_data: false,
                      },
                      risk_hints: {
                        side_effect_level: "mutating",
                        external_effects: "none",
                        reversibility_hint: "reversible",
                        sensitivity_hint: "low",
                        batch: false,
                      },
                      facets: {
                        filesystem: {
                          operation: "write",
                          byte_length: 10,
                        },
                      },
                      normalization: {
                        mapper: "test",
                        inferred_fields: [],
                        warnings: [],
                        normalization_confidence: 0.96,
                      },
                      confidence_assessment: {
                        engine_version: "test-confidence/v1",
                        score: 0.96,
                        band: "high",
                        requires_human_review: false,
                        factors: [
                          {
                            factor_id: "test_baseline",
                            label: "Test baseline",
                            kind: "baseline",
                            delta: 0.96,
                            rationale: "Test confidence baseline.",
                          },
                        ],
                      },
                    },
                    policy_outcome: {
                      schema_version: "policy-outcome.v1",
                      policy_outcome_id: "pol_explain",
                      action_id: "act_explain",
                      decision: "allow",
                      reasons: [
                        {
                          code: "FS_SMALL_WORKSPACE_WRITE",
                          severity: "low",
                          message: "Small workspace writes are allowed.",
                        },
                      ],
                      trust_requirements: {
                        wrapped_path_required: true,
                        brokered_credentials_required: false,
                        direct_credentials_forbidden: false,
                      },
                      preconditions: {
                        snapshot_required: false,
                        approval_required: false,
                        simulation_supported: false,
                      },
                      approval: null,
                      budget_effects: {
                        budget_check: "passed",
                        estimated_cost: 0,
                        remaining_mutating_actions: null,
                        remaining_destructive_actions: null,
                      },
                      policy_context: {
                        matched_rules: ["filesystem.write.small.allow"],
                        sticky_decision_applied: false,
                      },
                      evaluated_at: "2026-04-01T12:00:02.000Z",
                    },
                    action_family: "filesystem/write",
                    effective_policy_profile: "workspace-hardening",
                    low_confidence_threshold: 0.3,
                    confidence_score: 0.96,
                    confidence_triggered: false,
                    snapshot_selection: null,
                  }
                : method === "get_policy_threshold_recommendations"
                  ? {
                      generated_at: "2026-04-01T12:00:00.000Z",
                      filters: {
                        run_id: "run_policy",
                        min_samples: 2,
                      },
                      effective_policy_profile: "workspace-hardening",
                      recommendations: [
                        {
                          action_family: "shell/exec",
                          current_ask_below: 0.3,
                          recommended_ask_below: 0.41,
                          direction: "relax",
                          sample_count: 4,
                          approvals_requested: 4,
                          approvals_approved: 4,
                          approvals_denied: 0,
                          observed_confidence_min: 0.32,
                          observed_confidence_max: 0.61,
                          denied_confidence_max: null,
                          approved_confidence_min: 0.42,
                          rationale: "Relax with human review.",
                          requires_policy_update: true,
                          automatic_live_application_allowed: false,
                        },
                      ],
                    }
                  : method === "replay_policy_thresholds"
                    ? {
                        generated_at: "2026-04-01T12:00:01.000Z",
                        filters: {
                          run_id: "run_policy",
                          include_changed_samples: true,
                          sample_limit: 5,
                        },
                        effective_policy_profile: "workspace-hardening",
                        candidate_thresholds: [
                          {
                            action_family: "filesystem/write",
                            ask_below: 0.4,
                          },
                        ],
                        summary: {
                          replayable_samples: 1,
                          skipped_samples: 0,
                          changed_decisions: 1,
                          unchanged_decisions: 0,
                          current_approvals_requested: 0,
                          candidate_approvals_requested: 1,
                          approvals_reduced: 0,
                          approvals_increased: 1,
                          historically_denied_auto_allowed: 0,
                          historically_approved_auto_allowed: 0,
                          historically_allowed_newly_gated: 1,
                          current_matches_recorded: 1,
                          current_diverges_from_recorded: 0,
                        },
                        action_families: [],
                        changed_samples: [],
                        samples_truncated: false,
                      }
                    : {
                        valid: false,
                        issues: ["rules: Required"],
                        normalized_config: null,
                        compiled_profile_name: null,
                        compiled_rule_count: null,
                      };

      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? "sess_test",
          ok: true,
          result,
          error: null,
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 100,
      maxConnectRetries: 0,
    });

    const effectivePolicy = await client.getEffectivePolicy();
    const calibrationReport = await client.getPolicyCalibrationReport({
      run_id: "run_policy",
      include_samples: true,
      sample_limit: 5,
    });
    const explainedAction = await client.explainPolicyAction({
      run_id: "run_policy",
      tool_registration: {
        tool_name: "write_file",
        tool_kind: "filesystem",
      },
      raw_call: {
        path: "/workspace/README.md",
        content: "hello",
      },
      environment_context: {
        workspace_roots: ["/workspace"],
      },
      received_at: "2026-04-01T12:00:00.000Z",
    });
    const thresholdRecommendations = await client.getPolicyThresholdRecommendations({
      run_id: "run_policy",
      min_samples: 2,
    });
    const thresholdReplay = await client.replayPolicyThresholds({
      run_id: "run_policy",
      candidate_thresholds: [
        {
          action_family: "filesystem/write",
          ask_below: 0.4,
        },
      ],
      include_changed_samples: true,
      sample_limit: 5,
    });
    const validation = await client.validatePolicyConfig({
      profile_name: "invalid-policy",
      policy_version: "2026.04.01",
    });

    expect(effectivePolicy.summary.profile_name).toBe("workspace-hardening");
    expect(calibrationReport.report.totals.sample_count).toBe(1);
    expect(calibrationReport.report.samples?.[0]?.action_id).toBe("act_1");
    expect(explainedAction.action_family).toBe("filesystem/write");
    expect(explainedAction.low_confidence_threshold).toBe(0.3);
    expect(thresholdRecommendations.recommendations[0]?.direction).toBe("relax");
    expect(thresholdReplay.summary.approvals_increased).toBe(1);
    expect(validation.valid).toBe(false);
    expect(validation.issues).toContain("rules: Required");
    expect(seenRequests.find((request) => request.method === "get_effective_policy")).toBeTruthy();
    expect(seenRequests.find((request) => request.method === "get_policy_calibration_report")?.payload).toEqual({
      run_id: "run_policy",
      include_samples: true,
      sample_limit: 5,
    });
    expect(seenRequests.find((request) => request.method === "explain_policy_action")?.payload).toEqual({
      attempt: {
        run_id: "run_policy",
        tool_registration: {
          tool_name: "write_file",
          tool_kind: "filesystem",
        },
        raw_call: {
          path: "/workspace/README.md",
          content: "hello",
        },
        environment_context: {
          workspace_roots: ["/workspace"],
        },
        received_at: "2026-04-01T12:00:00.000Z",
      },
    });
    expect(seenRequests.find((request) => request.method === "get_policy_threshold_recommendations")?.payload).toEqual({
      run_id: "run_policy",
      min_samples: 2,
    });
    expect(seenRequests.find((request) => request.method === "replay_policy_thresholds")?.payload).toEqual({
      run_id: "run_policy",
      candidate_thresholds: [
        {
          action_family: "filesystem/write",
          ask_below: 0.4,
        },
      ],
      include_changed_samples: true,
      sample_limit: 5,
    });
    expect(seenRequests.find((request) => request.method === "validate_policy_config")?.payload).toEqual({
      config: {
        profile_name: "invalid-policy",
        policy_version: "2026.04.01",
      },
    });
  });

  it("sends MCP registry management requests with the expected methods and payloads", async () => {
    const harness = createHarness();
    const seenRequests: Array<Record<string, unknown>> = [];

    await startJsonServer(harness, (request, socket) => {
      seenRequests.push(request);
      const method = request.method;
      const result =
        method === "hello"
          ? {
              session_id: "sess_test",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: ["hello", "list_mcp_servers", "upsert_mcp_server", "remove_mcp_server"],
              },
            }
          : method === "list_mcp_servers"
            ? {
                servers: [],
              }
            : method === "upsert_mcp_server"
              ? {
                  created: true,
                  server: {
                    source: "operator_api",
                    created_at: "2026-03-31T12:00:00.000Z",
                    updated_at: "2026-03-31T12:00:00.000Z",
                    server: (request.payload as { server: Record<string, unknown> }).server,
                  },
                }
              : {
                  removed: true,
                  removed_server: {
                    source: "operator_api",
                    created_at: "2026-03-31T12:00:00.000Z",
                    updated_at: "2026-03-31T12:00:00.000Z",
                    server: {
                      server_id: "notes_http",
                      transport: "streamable_http",
                      url: "http://127.0.0.1:3010/mcp",
                      tools: [],
                    },
                  },
                };

      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? "sess_test",
          ok: true,
          result,
          error: null,
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 100,
      maxConnectRetries: 0,
    });

    await client.listMcpServers();
    await client.upsertMcpServer(
      {
        server_id: "notes_http",
        transport: "streamable_http",
        url: "http://127.0.0.1:3010/mcp",
        tools: [
          {
            tool_name: "echo_note",
            side_effect_level: "read_only",
            approval_mode: "allow",
          },
        ],
      },
      { idempotencyKey: "idem_mcp_upsert" },
    );
    await client.removeMcpServer("notes_http", { idempotencyKey: "idem_mcp_remove" });

    expect(seenRequests.find((request) => request.method === "list_mcp_servers")?.payload).toEqual({});
    expect(seenRequests.find((request) => request.method === "upsert_mcp_server")?.idempotency_key).toBe(
      "idem_mcp_upsert",
    );
    expect(seenRequests.find((request) => request.method === "remove_mcp_server")?.payload).toEqual({
      server_id: "notes_http",
    });
  });

  it("sends hosted MCP operator requests with the expected methods and payloads", async () => {
    const harness = createHarness();
    const seenRequests: Array<Record<string, unknown>> = [];

    await startJsonServer(harness, (request, socket) => {
      seenRequests.push(request);
      const method = request.method;
      const result =
        method === "hello"
          ? {
              session_id: "sess_test",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: ["hello", "get_hosted_mcp_job", "list_hosted_mcp_jobs", "requeue_hosted_mcp_job"],
              },
            }
          : method === "get_hosted_mcp_job"
            ? {
                job: {
                  job_id: "mcpjob_123",
                  run_id: "run_123",
                  action_id: "act_123",
                  server_profile_id: "mcpprof_123",
                  tool_name: "echo_note",
                  server_display_name: "Hosted Notes",
                  canonical_endpoint: "https://api.example.com/mcp",
                  network_scope: "public_https",
                  allowed_hosts: ["api.example.com"],
                  auth_context_ref: "none",
                  arguments: {},
                  status: "failed",
                  attempt_count: 4,
                  max_attempts: 4,
                  current_lease_id: "mcplease_123",
                  claimed_by: null,
                  claimed_at: null,
                  last_heartbeat_at: null,
                  cancel_requested_at: null,
                  cancel_requested_by_session_id: null,
                  cancel_reason: null,
                  canceled_at: null,
                  next_attempt_at: "2026-04-01T12:05:00.000Z",
                  created_at: "2026-04-01T12:00:00.000Z",
                  updated_at: "2026-04-01T12:05:00.000Z",
                  completed_at: "2026-04-01T12:05:00.000Z",
                  last_error: {
                    code: "CAPABILITY_UNAVAILABLE",
                    message: "Hosted worker unavailable",
                    retryable: true,
                  },
                  execution_result: null,
                },
                lifecycle: {
                  state: "dead_letter_retryable",
                  dead_lettered: true,
                  eligible_for_requeue: true,
                  retry_budget_remaining: 0,
                },
                leases: [],
                attestations: [],
                recent_events: [],
              }
            : method === "list_hosted_mcp_jobs"
              ? {
                  jobs: [],
                  summary: {
                    queued: 0,
                    running: 0,
                    cancel_requested: 0,
                    succeeded: 0,
                    failed: 0,
                    canceled: 0,
                    dead_letter_retryable: 0,
                    dead_letter_non_retryable: 0,
                  },
                }
              : method === "cancel_hosted_mcp_job"
                ? {
                    job: {
                      job_id: "mcpjob_456",
                      run_id: "run_123",
                      action_id: "act_123",
                      server_profile_id: "mcpprof_123",
                      tool_name: "echo_note",
                      server_display_name: "Hosted Notes",
                      canonical_endpoint: "https://api.example.com/mcp",
                      network_scope: "public_https",
                      allowed_hosts: ["api.example.com"],
                      auth_context_ref: "none",
                      arguments: {},
                      status: "canceled",
                      attempt_count: 1,
                      max_attempts: 6,
                      current_lease_id: null,
                      claimed_by: null,
                      claimed_at: null,
                      last_heartbeat_at: "2026-04-01T12:06:30.000Z",
                      cancel_requested_at: "2026-04-01T12:06:30.000Z",
                      cancel_requested_by_session_id: "sess_test",
                      cancel_reason: "operator stop",
                      canceled_at: "2026-04-01T12:06:31.000Z",
                      next_attempt_at: "2026-04-01T12:06:00.000Z",
                      created_at: "2026-04-01T12:00:00.000Z",
                      updated_at: "2026-04-01T12:06:31.000Z",
                      completed_at: "2026-04-01T12:06:31.000Z",
                      last_error: {
                        code: "CONFLICT",
                        message: "Hosted MCP execution job was canceled during execution.",
                        retryable: false,
                      },
                      execution_result: null,
                    },
                    cancellation_requested: true,
                    previous_status: "running",
                    terminal: true,
                  }
                : {
                    job: {
                      job_id: "mcpjob_123",
                      run_id: "run_123",
                      action_id: "act_123",
                      server_profile_id: "mcpprof_123",
                      tool_name: "echo_note",
                      server_display_name: "Hosted Notes",
                      canonical_endpoint: "https://api.example.com/mcp",
                      network_scope: "public_https",
                      allowed_hosts: ["api.example.com"],
                      auth_context_ref: "none",
                      arguments: {},
                      status: "queued",
                      attempt_count: 0,
                      max_attempts: 6,
                      current_lease_id: null,
                      claimed_by: null,
                      claimed_at: null,
                      last_heartbeat_at: null,
                      cancel_requested_at: null,
                      cancel_requested_by_session_id: null,
                      cancel_reason: null,
                      canceled_at: null,
                      next_attempt_at: "2026-04-01T12:06:00.000Z",
                      created_at: "2026-04-01T12:00:00.000Z",
                      updated_at: "2026-04-01T12:06:00.000Z",
                      completed_at: null,
                      last_error: null,
                      execution_result: null,
                    },
                    requeued: true,
                    previous_status: "failed",
                    attempt_count_reset: true,
                    max_attempts_updated: true,
                  };

      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? "sess_test",
          ok: true,
          result,
          error: null,
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 100,
      maxConnectRetries: 0,
    });

    await client.getHostedMcpJob("mcpjob_123");
    await client.listHostedMcpJobs({
      server_profile_id: "mcpprof_123",
      status: "failed",
      lifecycle_state: "dead_letter_retryable",
    });
    await client.requeueHostedMcpJob(
      "mcpjob_123",
      {
        reset_attempt_count: true,
        max_attempts: 6,
        reason: "worker restored",
      },
      { idempotencyKey: "idem_hosted_requeue" },
    );
    await client.cancelHostedMcpJob(
      "mcpjob_456",
      {
        reason: "operator stop",
      },
      { idempotencyKey: "idem_hosted_cancel" },
    );

    expect(seenRequests.find((request) => request.method === "get_hosted_mcp_job")?.payload).toEqual({
      job_id: "mcpjob_123",
    });
    expect(seenRequests.find((request) => request.method === "list_hosted_mcp_jobs")?.payload).toEqual({
      server_profile_id: "mcpprof_123",
      status: "failed",
      lifecycle_state: "dead_letter_retryable",
    });
    expect(seenRequests.find((request) => request.method === "requeue_hosted_mcp_job")?.payload).toEqual({
      job_id: "mcpjob_123",
      reset_attempt_count: true,
      max_attempts: 6,
      reason: "worker restored",
    });
    expect(seenRequests.find((request) => request.method === "requeue_hosted_mcp_job")?.idempotency_key).toBe(
      "idem_hosted_requeue",
    );
    expect(seenRequests.find((request) => request.method === "cancel_hosted_mcp_job")?.payload).toEqual({
      job_id: "mcpjob_456",
      reason: "operator stop",
    });
    expect(seenRequests.find((request) => request.method === "cancel_hosted_mcp_job")?.idempotency_key).toBe(
      "idem_hosted_cancel",
    );
  });

  it("sends MCP candidate and profile requests with the expected methods and payloads", async () => {
    const harness = createHarness();
    const seenRequests: Array<Record<string, unknown>> = [];

    await startJsonServer(harness, (request, socket) => {
      seenRequests.push(request);
      const method = request.method;
      const result =
        method === "hello"
          ? {
              session_id: "sess_test",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: [
                  "hello",
                  "list_mcp_server_candidates",
                  "submit_mcp_server_candidate",
                  "list_mcp_server_profiles",
                ],
              },
            }
          : method === "list_mcp_server_candidates"
            ? {
                candidates: [],
              }
            : method === "get_mcp_server_review"
              ? {
                  candidate: {
                    candidate_id: "mcpcand_123",
                    source_kind: "user_input",
                    raw_endpoint: "https://api.example.com/mcp",
                    transport_hint: "streamable_http",
                    workspace_id: null,
                    submitted_by_session_id: "sess_test",
                    submitted_by_run_id: null,
                    notes: null,
                    resolution_state: "pending",
                    resolution_error: null,
                    submitted_at: "2026-04-01T12:00:00.000Z",
                    updated_at: "2026-04-01T12:00:00.000Z",
                  },
                  profile: null,
                  active_trust_decision: null,
                  active_credential_binding: null,
                  review: {
                    review_target: "candidate",
                    executable: false,
                    activation_ready: false,
                    requires_approval: false,
                    requires_resolution: true,
                    requires_credentials: false,
                    requires_reapproval: false,
                    hosted_execution_supported: false,
                    local_proxy_supported: false,
                    drift_detected: false,
                    quarantined: false,
                    revoked: false,
                    warnings: ["Candidate has not been resolved into a durable profile yet."],
                    recommended_actions: ["Resolve the candidate before attempting review or activation."],
                  },
                }
              : method === "submit_mcp_server_candidate"
                ? {
                    candidate: {
                      candidate_id: "mcpcand_123",
                      source_kind: "user_input",
                      raw_endpoint: "https://api.example.com/mcp",
                      transport_hint: "streamable_http",
                      workspace_id: null,
                      submitted_by_session_id: "sess_test",
                      submitted_by_run_id: null,
                      notes: null,
                      resolution_state: "pending",
                      resolution_error: null,
                      submitted_at: "2026-04-01T12:00:00.000Z",
                      updated_at: "2026-04-01T12:00:00.000Z",
                    },
                  }
                : method === "resolve_mcp_server_candidate"
                  ? {
                      candidate: {
                        candidate_id: "mcpcand_123",
                        source_kind: "user_input",
                        raw_endpoint: "https://api.example.com/mcp",
                        transport_hint: "streamable_http",
                        workspace_id: null,
                        submitted_by_session_id: "sess_test",
                        submitted_by_run_id: null,
                        notes: null,
                        resolution_state: "resolved",
                        resolution_error: null,
                        submitted_at: "2026-04-01T12:00:00.000Z",
                        updated_at: "2026-04-01T12:05:00.000Z",
                      },
                      profile: {
                        server_profile_id: "mcpprof_123",
                        candidate_id: "mcpcand_123",
                        display_name: "Example MCP",
                        transport: "streamable_http",
                        canonical_endpoint: "https://api.example.com/mcp",
                        network_scope: "public_https",
                        trust_tier: "operator_approved_public",
                        status: "draft",
                        drift_state: "clean",
                        quarantine_reason_codes: [],
                        allowed_execution_modes: ["local_proxy"],
                        active_trust_decision_id: null,
                        active_credential_binding_id: null,
                        auth_descriptor: {
                          mode: "none",
                          audience: null,
                          scope_labels: [],
                        },
                        identity_baseline: {
                          canonical_host: "api.example.com",
                          canonical_port: 443,
                          tls_identity_summary: null,
                          auth_issuer: null,
                          publisher_identity: null,
                          tool_inventory_hash: "hash_tools",
                          fetched_at: "2026-04-01T12:05:00.000Z",
                        },
                        imported_tools: [],
                        tool_inventory_version: "hash_tools",
                        last_resolved_at: "2026-04-01T12:05:00.000Z",
                        created_at: "2026-04-01T12:05:00.000Z",
                        updated_at: "2026-04-01T12:05:00.000Z",
                      },
                      created_profile: true,
                      drift_detected: false,
                    }
                  : method === "list_mcp_server_profiles"
                    ? {
                        profiles: [],
                      }
                    : method === "list_mcp_server_trust_decisions"
                      ? {
                          trust_decisions: [],
                        }
                      : method === "list_mcp_server_credential_bindings"
                        ? {
                            credential_bindings: [],
                          }
                        : method === "bind_mcp_server_credentials"
                          ? {
                              profile: {
                                server_profile_id: "mcpprof_123",
                                candidate_id: "mcpcand_123",
                                display_name: "Example MCP",
                                transport: "streamable_http",
                                canonical_endpoint: "https://api.example.com/mcp",
                                network_scope: "public_https",
                                trust_tier: "operator_approved_public",
                                status: "pending_approval",
                                drift_state: "clean",
                                quarantine_reason_codes: [],
                                allowed_execution_modes: ["local_proxy"],
                                active_trust_decision_id: "mcptrust_123",
                                active_credential_binding_id: "mcpbind_123",
                                auth_descriptor: {
                                  mode: "bearer_secret_ref",
                                  audience: null,
                                  scope_labels: ["remote:mcp"],
                                },
                                identity_baseline: {
                                  canonical_host: "api.example.com",
                                  canonical_port: 443,
                                  tls_identity_summary: null,
                                  auth_issuer: null,
                                  publisher_identity: null,
                                  tool_inventory_hash: "hash_tools",
                                  fetched_at: "2026-04-01T12:05:00.000Z",
                                },
                                imported_tools: [],
                                tool_inventory_version: "hash_tools",
                                last_resolved_at: "2026-04-01T12:05:00.000Z",
                                created_at: "2026-04-01T12:05:00.000Z",
                                updated_at: "2026-04-01T12:06:30.000Z",
                              },
                              credential_binding: {
                                credential_binding_id: "mcpbind_123",
                                server_profile_id: "mcpprof_123",
                                binding_mode: "bearer_secret_ref",
                                broker_profile_id: "mcp_secret_123",
                                scope_labels: ["remote:mcp"],
                                audience: null,
                                status: "active",
                                created_at: "2026-04-01T12:06:30.000Z",
                                updated_at: "2026-04-01T12:06:30.000Z",
                                revoked_at: null,
                              },
                              created: true,
                            }
                          : method === "revoke_mcp_server_credentials"
                            ? {
                                profile: {
                                  server_profile_id: "mcpprof_123",
                                  candidate_id: "mcpcand_123",
                                  display_name: "Example MCP",
                                  transport: "streamable_http",
                                  canonical_endpoint: "https://api.example.com/mcp",
                                  network_scope: "public_https",
                                  trust_tier: "operator_approved_public",
                                  status: "draft",
                                  drift_state: "clean",
                                  quarantine_reason_codes: [],
                                  allowed_execution_modes: ["local_proxy"],
                                  active_trust_decision_id: "mcptrust_123",
                                  active_credential_binding_id: null,
                                  auth_descriptor: {
                                    mode: "bearer_secret_ref",
                                    audience: null,
                                    scope_labels: ["remote:mcp"],
                                  },
                                  identity_baseline: {
                                    canonical_host: "api.example.com",
                                    canonical_port: 443,
                                    tls_identity_summary: null,
                                    auth_issuer: null,
                                    publisher_identity: null,
                                    tool_inventory_hash: "hash_tools",
                                    fetched_at: "2026-04-01T12:05:00.000Z",
                                  },
                                  imported_tools: [],
                                  tool_inventory_version: "hash_tools",
                                  last_resolved_at: "2026-04-01T12:05:00.000Z",
                                  created_at: "2026-04-01T12:05:00.000Z",
                                  updated_at: "2026-04-01T12:07:30.000Z",
                                },
                                credential_binding: {
                                  credential_binding_id: "mcpbind_123",
                                  server_profile_id: "mcpprof_123",
                                  binding_mode: "bearer_secret_ref",
                                  broker_profile_id: "mcp_secret_123",
                                  scope_labels: ["remote:mcp"],
                                  audience: null,
                                  status: "revoked",
                                  created_at: "2026-04-01T12:06:30.000Z",
                                  updated_at: "2026-04-01T12:07:30.000Z",
                                  revoked_at: "2026-04-01T12:07:30.000Z",
                                },
                              }
                            : method === "approve_mcp_server_profile"
                              ? {
                                  profile: {
                                    server_profile_id: "mcpprof_123",
                                    candidate_id: "mcpcand_123",
                                    display_name: "Example MCP",
                                    transport: "streamable_http",
                                    canonical_endpoint: "https://api.example.com/mcp",
                                    network_scope: "public_https",
                                    trust_tier: "operator_approved_public",
                                    status: "pending_approval",
                                    drift_state: "clean",
                                    quarantine_reason_codes: [],
                                    allowed_execution_modes: ["local_proxy"],
                                    active_trust_decision_id: "mcptrust_123",
                                    active_credential_binding_id: null,
                                    auth_descriptor: {
                                      mode: "none",
                                      audience: null,
                                      scope_labels: [],
                                    },
                                    identity_baseline: {
                                      canonical_host: "api.example.com",
                                      canonical_port: 443,
                                      tls_identity_summary: null,
                                      auth_issuer: null,
                                      publisher_identity: null,
                                      tool_inventory_hash: "hash_tools",
                                      fetched_at: "2026-04-01T12:05:00.000Z",
                                    },
                                    imported_tools: [],
                                    tool_inventory_version: "hash_tools",
                                    last_resolved_at: "2026-04-01T12:05:00.000Z",
                                    created_at: "2026-04-01T12:05:00.000Z",
                                    updated_at: "2026-04-01T12:06:00.000Z",
                                  },
                                  trust_decision: {
                                    trust_decision_id: "mcptrust_123",
                                    server_profile_id: "mcpprof_123",
                                    decision: "allow_policy_managed",
                                    trust_tier: "operator_approved_public",
                                    allowed_execution_modes: ["local_proxy"],
                                    max_side_effect_level_without_approval: "read_only",
                                    reason_codes: ["INITIAL_REVIEW_COMPLETE"],
                                    approved_by_session_id: "sess_test",
                                    approved_at: "2026-04-01T12:06:00.000Z",
                                    valid_until: null,
                                    reapproval_triggers: [],
                                  },
                                  created: true,
                                }
                              : method === "activate_mcp_server_profile"
                                ? {
                                    profile: {
                                      server_profile_id: "mcpprof_123",
                                      candidate_id: "mcpcand_123",
                                      display_name: "Example MCP",
                                      transport: "streamable_http",
                                      canonical_endpoint: "https://api.example.com/mcp",
                                      network_scope: "public_https",
                                      trust_tier: "operator_approved_public",
                                      status: "active",
                                      drift_state: "clean",
                                      quarantine_reason_codes: [],
                                      allowed_execution_modes: ["local_proxy"],
                                      active_trust_decision_id: "mcptrust_123",
                                      active_credential_binding_id: "mcpbind_123",
                                      auth_descriptor: {
                                        mode: "bearer_secret_ref",
                                        audience: null,
                                        scope_labels: ["remote:mcp"],
                                      },
                                      identity_baseline: {
                                        canonical_host: "api.example.com",
                                        canonical_port: 443,
                                        tls_identity_summary: null,
                                        auth_issuer: null,
                                        publisher_identity: null,
                                        tool_inventory_hash: "hash_tools",
                                        fetched_at: "2026-04-01T12:05:00.000Z",
                                      },
                                      imported_tools: [],
                                      tool_inventory_version: "hash_tools",
                                      last_resolved_at: "2026-04-01T12:05:00.000Z",
                                      created_at: "2026-04-01T12:05:00.000Z",
                                      updated_at: "2026-04-01T12:07:00.000Z",
                                    },
                                  }
                                : method === "quarantine_mcp_server_profile"
                                  ? {
                                      profile: {
                                        server_profile_id: "mcpprof_123",
                                        candidate_id: "mcpcand_123",
                                        display_name: "Example MCP",
                                        transport: "streamable_http",
                                        canonical_endpoint: "https://api.example.com/mcp",
                                        network_scope: "public_https",
                                        trust_tier: "operator_approved_public",
                                        status: "quarantined",
                                        drift_state: "drifted",
                                        quarantine_reason_codes: ["MCP_TOOL_INVENTORY_CHANGED"],
                                        allowed_execution_modes: ["local_proxy"],
                                        active_trust_decision_id: "mcptrust_123",
                                        active_credential_binding_id: "mcpbind_123",
                                        auth_descriptor: {
                                          mode: "bearer_secret_ref",
                                          audience: null,
                                          scope_labels: ["remote:mcp"],
                                        },
                                        identity_baseline: {
                                          canonical_host: "api.example.com",
                                          canonical_port: 443,
                                          tls_identity_summary: null,
                                          auth_issuer: null,
                                          publisher_identity: null,
                                          tool_inventory_hash: "hash_tools",
                                          fetched_at: "2026-04-01T12:05:00.000Z",
                                        },
                                        imported_tools: [],
                                        tool_inventory_version: "hash_tools",
                                        last_resolved_at: "2026-04-01T12:05:00.000Z",
                                        created_at: "2026-04-01T12:05:00.000Z",
                                        updated_at: "2026-04-01T12:08:00.000Z",
                                      },
                                    }
                                  : method === "revoke_mcp_server_profile"
                                    ? {
                                        profile: {
                                          server_profile_id: "mcpprof_123",
                                          candidate_id: "mcpcand_123",
                                          display_name: "Example MCP",
                                          transport: "streamable_http",
                                          canonical_endpoint: "https://api.example.com/mcp",
                                          network_scope: "public_https",
                                          trust_tier: "operator_approved_public",
                                          status: "revoked",
                                          drift_state: "drifted",
                                          quarantine_reason_codes: ["MANUAL_REVOKE"],
                                          allowed_execution_modes: ["local_proxy"],
                                          active_trust_decision_id: "mcptrust_123",
                                          active_credential_binding_id: "mcpbind_123",
                                          auth_descriptor: {
                                            mode: "bearer_secret_ref",
                                            audience: null,
                                            scope_labels: ["remote:mcp"],
                                          },
                                          identity_baseline: {
                                            canonical_host: "api.example.com",
                                            canonical_port: 443,
                                            tls_identity_summary: null,
                                            auth_issuer: null,
                                            publisher_identity: null,
                                            tool_inventory_hash: "hash_tools",
                                            fetched_at: "2026-04-01T12:05:00.000Z",
                                          },
                                          imported_tools: [],
                                          tool_inventory_version: "hash_tools",
                                          last_resolved_at: "2026-04-01T12:05:00.000Z",
                                          created_at: "2026-04-01T12:05:00.000Z",
                                          updated_at: "2026-04-01T12:09:00.000Z",
                                        },
                                      }
                                    : {
                                        profiles: [],
                                      };

      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? "sess_test",
          ok: true,
          result,
          error: null,
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 100,
      maxConnectRetries: 0,
    });

    await client.listMcpServerCandidates();
    await client.getMcpServerReview({
      candidate_id: "mcpcand_123",
    });
    await client.submitMcpServerCandidate(
      {
        source_kind: "user_input",
        raw_endpoint: "https://api.example.com/mcp",
        transport_hint: "streamable_http",
      },
      { idempotencyKey: "idem_mcp_candidate_submit" },
    );
    await client.listMcpServerProfiles();
    await client.resolveMcpServerCandidate(
      {
        candidate_id: "mcpcand_123",
        display_name: "Example MCP",
      },
      { idempotencyKey: "idem_mcp_candidate_resolve" },
    );
    await client.listMcpServerTrustDecisions("mcpprof_123");
    await client.listMcpServerCredentialBindings("mcpprof_123");
    await client.bindMcpServerCredentials(
      {
        server_profile_id: "mcpprof_123",
        binding_mode: "bearer_secret_ref",
        broker_profile_id: "mcp_secret_123",
        scope_labels: ["remote:mcp"],
      },
      { idempotencyKey: "idem_mcp_profile_bind" },
    );
    await client.approveMcpServerProfile(
      {
        server_profile_id: "mcpprof_123",
        decision: "allow_policy_managed",
        trust_tier: "operator_approved_public",
        allowed_execution_modes: ["local_proxy"],
        reason_codes: ["INITIAL_REVIEW_COMPLETE"],
      },
      { idempotencyKey: "idem_mcp_profile_approve" },
    );
    await client.activateMcpServerProfile("mcpprof_123", { idempotencyKey: "idem_mcp_profile_activate" });
    await client.quarantineMcpServerProfile(
      {
        server_profile_id: "mcpprof_123",
        reason_codes: ["MCP_TOOL_INVENTORY_CHANGED"],
      },
      { idempotencyKey: "idem_mcp_profile_quarantine" },
    );
    await client.revokeMcpServerCredentials("mcpbind_123", { idempotencyKey: "idem_mcp_profile_binding_revoke" });
    await client.revokeMcpServerProfile(
      {
        server_profile_id: "mcpprof_123",
        reason_codes: ["MANUAL_REVOKE"],
      },
      { idempotencyKey: "idem_mcp_profile_revoke" },
    );

    expect(seenRequests.find((request) => request.method === "list_mcp_server_candidates")?.payload).toEqual({});
    expect(seenRequests.find((request) => request.method === "get_mcp_server_review")?.payload).toEqual({
      candidate_id: "mcpcand_123",
    });
    expect(seenRequests.find((request) => request.method === "submit_mcp_server_candidate")?.payload).toEqual({
      candidate: {
        source_kind: "user_input",
        raw_endpoint: "https://api.example.com/mcp",
        transport_hint: "streamable_http",
      },
    });
    expect(seenRequests.find((request) => request.method === "submit_mcp_server_candidate")?.idempotency_key).toBe(
      "idem_mcp_candidate_submit",
    );
    expect(seenRequests.find((request) => request.method === "list_mcp_server_profiles")?.payload).toEqual({});
    expect(seenRequests.find((request) => request.method === "resolve_mcp_server_candidate")?.payload).toEqual({
      candidate_id: "mcpcand_123",
      display_name: "Example MCP",
    });
    expect(seenRequests.find((request) => request.method === "resolve_mcp_server_candidate")?.idempotency_key).toBe(
      "idem_mcp_candidate_resolve",
    );
    expect(seenRequests.find((request) => request.method === "list_mcp_server_trust_decisions")?.payload).toEqual({
      server_profile_id: "mcpprof_123",
    });
    expect(seenRequests.find((request) => request.method === "list_mcp_server_credential_bindings")?.payload).toEqual({
      server_profile_id: "mcpprof_123",
    });
    expect(seenRequests.find((request) => request.method === "bind_mcp_server_credentials")?.payload).toEqual({
      server_profile_id: "mcpprof_123",
      binding_mode: "bearer_secret_ref",
      broker_profile_id: "mcp_secret_123",
      scope_labels: ["remote:mcp"],
    });
    expect(seenRequests.find((request) => request.method === "bind_mcp_server_credentials")?.idempotency_key).toBe(
      "idem_mcp_profile_bind",
    );
    expect(seenRequests.find((request) => request.method === "approve_mcp_server_profile")?.payload).toEqual({
      server_profile_id: "mcpprof_123",
      decision: "allow_policy_managed",
      trust_tier: "operator_approved_public",
      allowed_execution_modes: ["local_proxy"],
      reason_codes: ["INITIAL_REVIEW_COMPLETE"],
    });
    expect(seenRequests.find((request) => request.method === "approve_mcp_server_profile")?.idempotency_key).toBe(
      "idem_mcp_profile_approve",
    );
    expect(seenRequests.find((request) => request.method === "activate_mcp_server_profile")?.payload).toEqual({
      server_profile_id: "mcpprof_123",
    });
    expect(seenRequests.find((request) => request.method === "activate_mcp_server_profile")?.idempotency_key).toBe(
      "idem_mcp_profile_activate",
    );
    expect(seenRequests.find((request) => request.method === "quarantine_mcp_server_profile")?.payload).toEqual({
      server_profile_id: "mcpprof_123",
      reason_codes: ["MCP_TOOL_INVENTORY_CHANGED"],
    });
    expect(seenRequests.find((request) => request.method === "quarantine_mcp_server_profile")?.idempotency_key).toBe(
      "idem_mcp_profile_quarantine",
    );
    expect(seenRequests.find((request) => request.method === "revoke_mcp_server_credentials")?.payload).toEqual({
      credential_binding_id: "mcpbind_123",
    });
    expect(seenRequests.find((request) => request.method === "revoke_mcp_server_credentials")?.idempotency_key).toBe(
      "idem_mcp_profile_binding_revoke",
    );
    expect(seenRequests.find((request) => request.method === "revoke_mcp_server_profile")?.payload).toEqual({
      server_profile_id: "mcpprof_123",
      reason_codes: ["MANUAL_REVOKE"],
    });
    expect(seenRequests.find((request) => request.method === "revoke_mcp_server_profile")?.idempotency_key).toBe(
      "idem_mcp_profile_revoke",
    );
  });

  it("sends MCP secret and host-policy management requests with the expected methods and payloads", async () => {
    const harness = createHarness();
    const seenRequests: Array<Record<string, unknown>> = [];

    await startJsonServer(harness, (request, socket) => {
      seenRequests.push(request);
      const method = request.method;
      const result =
        method === "hello"
          ? {
              session_id: "sess_test",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: [
                  "hello",
                  "list_mcp_secrets",
                  "upsert_mcp_secret",
                  "remove_mcp_secret",
                  "list_mcp_host_policies",
                  "upsert_mcp_host_policy",
                  "remove_mcp_host_policy",
                ],
              },
            }
          : method === "list_mcp_secrets"
            ? {
                secrets: [],
              }
            : method === "upsert_mcp_secret"
              ? {
                  created: true,
                  rotated: false,
                  secret: {
                    secret_id: "mcp_secret_notion",
                    display_name: "Notion MCP",
                    auth_type: "bearer",
                    status: "active",
                    version: 1,
                    created_at: "2026-03-31T12:00:00.000Z",
                    updated_at: "2026-03-31T12:00:00.000Z",
                    rotated_at: null,
                    last_used_at: null,
                    source: "operator_api",
                  },
                }
              : method === "remove_mcp_secret"
                ? {
                    removed: true,
                    removed_secret: {
                      secret_id: "mcp_secret_notion",
                      display_name: "Notion MCP",
                      auth_type: "bearer",
                      status: "active",
                      version: 1,
                      created_at: "2026-03-31T12:00:00.000Z",
                      updated_at: "2026-03-31T12:00:00.000Z",
                      rotated_at: null,
                      last_used_at: null,
                      source: "operator_api",
                    },
                  }
                : method === "list_mcp_host_policies"
                  ? {
                      policies: [],
                    }
                  : method === "upsert_mcp_host_policy"
                    ? {
                        created: true,
                        policy: {
                          policy: {
                            host: "api.notion.com",
                            display_name: "Notion API",
                            allow_subdomains: false,
                            allowed_ports: [443],
                          },
                          source: "operator_api",
                          created_at: "2026-03-31T12:00:00.000Z",
                          updated_at: "2026-03-31T12:00:00.000Z",
                        },
                      }
                    : {
                        removed: true,
                        removed_policy: {
                          policy: {
                            host: "api.notion.com",
                            display_name: "Notion API",
                            allow_subdomains: false,
                            allowed_ports: [443],
                          },
                          source: "operator_api",
                          created_at: "2026-03-31T12:00:00.000Z",
                          updated_at: "2026-03-31T12:00:00.000Z",
                        },
                      };

      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? "sess_test",
          ok: true,
          result,
          error: null,
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 100,
      maxConnectRetries: 0,
    });

    await client.listMcpSecrets();
    await client.upsertMcpSecret(
      {
        secret_id: "mcp_secret_notion",
        display_name: "Notion MCP",
        bearer_token: "redacted-in-transport-test",
      },
      { idempotencyKey: "idem_mcp_secret_upsert" },
    );
    await client.removeMcpSecret("mcp_secret_notion", { idempotencyKey: "idem_mcp_secret_remove" });
    await client.listMcpHostPolicies();
    await client.upsertMcpHostPolicy(
      {
        host: "api.notion.com",
        display_name: "Notion API",
        allow_subdomains: false,
        allowed_ports: [443],
      },
      { idempotencyKey: "idem_mcp_host_upsert" },
    );
    await client.removeMcpHostPolicy("api.notion.com", { idempotencyKey: "idem_mcp_host_remove" });

    expect(seenRequests.find((request) => request.method === "list_mcp_secrets")?.payload).toEqual({});
    expect(seenRequests.find((request) => request.method === "upsert_mcp_secret")?.idempotency_key).toBe(
      "idem_mcp_secret_upsert",
    );
    expect(seenRequests.find((request) => request.method === "remove_mcp_secret")?.payload).toEqual({
      secret_id: "mcp_secret_notion",
    });
    expect(seenRequests.find((request) => request.method === "list_mcp_host_policies")?.payload).toEqual({});
    expect(seenRequests.find((request) => request.method === "upsert_mcp_host_policy")?.payload).toEqual({
      policy: {
        host: "api.notion.com",
        display_name: "Notion API",
        allow_subdomains: false,
        allowed_ports: [443],
      },
    });
    expect(seenRequests.find((request) => request.method === "remove_mcp_host_policy")?.idempotency_key).toBe(
      "idem_mcp_host_remove",
    );
  });

  it("normalizes action-boundary recovery targets for the daemon", async () => {
    const harness = createHarness();
    const seenRequests: Array<Record<string, unknown>> = [];

    await startJsonServer(harness, (request, socket) => {
      seenRequests.push(request);
      const method = request.method;
      const result =
        method === "hello"
          ? {
              session_id: "sess_test",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: ["hello", "plan_recovery"],
              },
            }
          : {
              recovery_plan: {
                schema_version: "recovery-plan.v1",
                recovery_plan_id: "rec_test",
                target: {
                  type: "action_boundary",
                  action_id: "act_test",
                },
                recovery_class: "review_only",
                strategy: "manual_review_only",
                confidence: 0.44,
                steps: [],
                impact_preview: {
                  later_actions_affected: 0,
                  overlapping_paths: [],
                  external_effects: [],
                  data_loss_risk: "unknown",
                },
                warnings: [],
                created_at: "2026-03-30T12:00:00.000Z",
              },
            };

      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? "sess_test",
          ok: true,
          result,
          error: null,
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 100,
      maxConnectRetries: 0,
    });

    await client.planRecovery("act_test");

    const recoveryRequest = seenRequests.find((request) => request.method === "plan_recovery");
    expect(recoveryRequest).toBeTruthy();
    expect(recoveryRequest?.payload).toEqual({
      target: {
        type: "action_boundary",
        action_id: "act_test",
      },
    });
  });

  it("passes through structured external-object recovery targets unchanged", async () => {
    const harness = createHarness();
    const seenRequests: Array<Record<string, unknown>> = [];

    await startJsonServer(harness, (request, socket) => {
      seenRequests.push(request);
      const method = request.method;
      const result =
        method === "hello"
          ? {
              session_id: "sess_test",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: ["hello", "execute_recovery"],
              },
            }
          : {
              recovered: true,
            };

      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? "sess_test",
          ok: true,
          result,
          error: null,
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 100,
      maxConnectRetries: 0,
    });

    await client.executeRecovery({
      type: "external_object",
      external_object_id: "draft_shared",
    });

    const recoveryRequest = seenRequests.find((request) => request.method === "execute_recovery");
    expect(recoveryRequest?.payload).toEqual({
      target: {
        type: "external_object",
        external_object_id: "draft_shared",
      },
    });
  });

  it("passes through structured run-checkpoint recovery targets unchanged", async () => {
    const harness = createHarness();
    const seenRequests: Array<Record<string, unknown>> = [];

    await startJsonServer(harness, (request, socket) => {
      seenRequests.push(request);
      const method = request.method;
      const result =
        method === "hello"
          ? {
              session_id: "sess_test",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: ["hello", "plan_recovery"],
              },
            }
          : {
              planned: true,
            };

      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? "sess_test",
          ok: true,
          result,
          error: null,
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 100,
      maxConnectRetries: 0,
    });

    await client.planRecovery({
      type: "run_checkpoint",
      run_checkpoint: "run_demo#7",
    });

    const recoveryRequest = seenRequests.find((request) => request.method === "plan_recovery");
    expect(recoveryRequest?.payload).toEqual({
      target: {
        type: "run_checkpoint",
        run_checkpoint: "run_demo#7",
      },
    });
  });

  it("passes through structured path-subset recovery targets unchanged", async () => {
    const harness = createHarness();
    const seenRequests: Array<Record<string, unknown>> = [];

    await startJsonServer(harness, (request, socket) => {
      seenRequests.push(request);
      const method = request.method;
      const result =
        method === "hello"
          ? {
              session_id: "sess_test",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: ["hello", "execute_recovery"],
              },
            }
          : {
              executed: true,
            };

      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? "sess_test",
          ok: true,
          result,
          error: null,
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 100,
      maxConnectRetries: 0,
    });

    await client.executeRecovery({
      type: "path_subset",
      snapshot_id: "snap_demo",
      paths: ["src/app.ts", "/workspace/README.md"],
    });

    const recoveryRequest = seenRequests.find((request) => request.method === "execute_recovery");
    expect(recoveryRequest?.payload).toEqual({
      target: {
        type: "path_subset",
        snapshot_id: "snap_demo",
        paths: ["src/app.ts", "/workspace/README.md"],
      },
    });
  });

  it("passes through structured branch-point recovery targets unchanged", async () => {
    const harness = createHarness();
    const seenRequests: Array<Record<string, unknown>> = [];

    await startJsonServer(harness, (request, socket) => {
      seenRequests.push(request);
      const method = request.method;
      const result =
        method === "hello"
          ? {
              session_id: "sess_test",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: ["hello", "plan_recovery"],
              },
            }
          : {
              planned: true,
            };

      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? "sess_test",
          ok: true,
          result,
          error: null,
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 100,
      maxConnectRetries: 0,
    });

    await client.planRecovery({
      type: "branch_point",
      run_id: "run_demo",
      sequence: 7,
    });

    const recoveryRequest = seenRequests.find((request) => request.method === "plan_recovery");
    expect(recoveryRequest?.payload).toEqual({
      target: {
        type: "branch_point",
        run_id: "run_demo",
        sequence: 7,
      },
    });
  });

  it("forwards optional visibility scopes on timeline and helper queries", async () => {
    const harness = createHarness();
    const seenRequests: Array<Record<string, unknown>> = [];

    await startJsonServer(harness, (request, socket) => {
      seenRequests.push(request);
      const method = request.method;
      const result =
        method === "hello"
          ? {
              session_id: "sess_visibility",
              accepted_api_version: API_VERSION,
              runtime_version: "0.1.0",
              schema_pack_version: "schema-pack.v1",
              capabilities: {
                local_only: true,
                methods: [
                  "hello",
                  "query_timeline",
                  "query_helper",
                  "query_artifact",
                  "get_capabilities",
                  "diagnostics",
                  "run_maintenance",
                ],
              },
            }
          : {
              answer: "ok",
              confidence: 0.5,
              visibility_scope: "user",
              redactions_applied: 0,
              preview_budget: {
                max_inline_preview_chars: 160,
                max_total_inline_preview_chars: 1200,
                preview_chars_used: 0,
                truncated_previews: 0,
                omitted_previews: 0,
              },
              evidence: [],
              uncertainty: [],
              steps: [],
              run_summary: {
                run_id: "run_vis",
                session_id: "sess_visibility",
                workflow_name: "visibility",
                agent_framework: "cli",
                agent_name: "agentgit-cli",
                workspace_roots: [],
                event_count: 0,
                latest_event: null,
                budget_config: {
                  max_mutating_actions: null,
                  max_destructive_actions: null,
                },
                budget_usage: {
                  mutating_actions: 0,
                  destructive_actions: 0,
                },
                maintenance_status: {
                  projection_status: "fresh",
                  projection_lag_events: 0,
                  degraded_artifact_capture_actions: 0,
                  low_disk_pressure_signals: 0,
                  artifact_health: {
                    total: 0,
                    available: 0,
                    missing: 0,
                    expired: 0,
                    corrupted: 0,
                    tampered: 0,
                  },
                },
                created_at: "2026-03-31T00:00:00.000Z",
                started_at: "2026-03-31T00:00:00.000Z",
              },
              projection_status: "fresh",
            };

      socket.write(
        `${JSON.stringify({
          api_version: API_VERSION,
          request_id: request.request_id,
          session_id: request.session_id ?? "sess_visibility",
          ok: true,
          result,
          error: null,
        })}\n`,
      );
      socket.end();
    });

    const client = new AuthorityClient({
      socketPath: harness.socketPath,
      connectTimeoutMs: 50,
      responseTimeoutMs: 100,
      maxConnectRetries: 0,
    });

    await client.queryTimeline("run_vis", "internal");
    await client.queryHelper("run_vis", "step_details", "step_1", undefined, "sensitive_internal");
    await client.queryArtifact("artifact_1", "internal", { fullContent: true });
    await client.getCapabilities("/tmp/workspace");
    await client.diagnostics(["storage_summary", "journal_health"]);
    await client.runMaintenance(["artifact_expiry", "sqlite_wal_checkpoint"], {
      priority_override: "administrative",
      scope: {
        workspace_root: "/tmp/workspace",
      },
    });

    const timelineRequest = seenRequests.find((request) => request.method === "query_timeline");
    const helperRequest = seenRequests.find((request) => request.method === "query_helper");
    const artifactRequest = seenRequests.find((request) => request.method === "query_artifact");
    const capabilitiesRequest = seenRequests.find((request) => request.method === "get_capabilities");
    const diagnosticsRequest = seenRequests.find((request) => request.method === "diagnostics");
    const maintenanceRequest = seenRequests.find((request) => request.method === "run_maintenance");
    expect(timelineRequest?.payload).toEqual({
      run_id: "run_vis",
      visibility_scope: "internal",
    });
    expect(helperRequest?.payload).toEqual({
      run_id: "run_vis",
      question_type: "step_details",
      focus_step_id: "step_1",
      visibility_scope: "sensitive_internal",
    });
    expect(artifactRequest?.payload).toEqual({
      artifact_id: "artifact_1",
      visibility_scope: "internal",
      full_content: true,
    });
    expect(capabilitiesRequest?.payload).toEqual({
      workspace_root: "/tmp/workspace",
    });
    expect(diagnosticsRequest?.payload).toEqual({
      sections: ["storage_summary", "journal_health"],
    });
    expect(maintenanceRequest?.payload).toEqual({
      job_types: ["artifact_expiry", "sqlite_wal_checkpoint"],
      priority_override: "administrative",
      scope: {
        workspace_root: "/tmp/workspace",
      },
    });
  });
});
