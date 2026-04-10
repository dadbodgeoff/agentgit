import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTempDirTracker } from "@agentgit/test-fixtures";

import { McpPublicHostPolicyRegistry, McpServerRegistry, validateMcpServerDefinitions } from "./index.js";

const dirs = createTempDirTracker("agentgit-mcp-registry-");
const TEST_PINNED_OCI_IMAGE =
  "docker.io/library/node@sha256:1111111111111111111111111111111111111111111111111111111111111111";
const TEST_OCI_SIGNATURE_POLICY = {
  mode: "cosign_keyless" as const,
  certificate_identity: "https://github.com/agentgit/agentgit/.github/workflows/release.yml@refs/heads/main",
  certificate_oidc_issuer: "https://token.actions.githubusercontent.com",
};

afterEach(() => {
  dirs.cleanup();
});

describe("validateMcpServerDefinitions", () => {
  it("rejects streamable_http bearer auth without an env var", () => {
    expect(() =>
      validateMcpServerDefinitions([
        {
          server_id: "notes_http",
          transport: "streamable_http",
          url: "http://127.0.0.1:3010/mcp",
          auth: {
            type: "bearer_env",
          } as never,
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      ]),
    ).toThrow("Request payload validation failed.");
  });

  it("rejects non-loopback streamable_http MCP URLs", () => {
    expect(() =>
      validateMcpServerDefinitions([
        {
          server_id: "notes_http_remote",
          transport: "streamable_http",
          url: "https://example.com/mcp",
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      ]),
    ).toThrow("currently limited to operator-managed local loopback URLs");
  });

  it("accepts explicit private-network streamable_http MCP URLs", () => {
    expect(
      validateMcpServerDefinitions([
        {
          server_id: "notes_http_private",
          transport: "streamable_http",
          url: "http://10.24.3.11:3010/mcp",
          network_scope: "private",
          max_concurrent_calls: 2,
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        server_id: "notes_http_private",
        transport: "streamable_http",
        url: "http://10.24.3.11:3010/mcp",
        network_scope: "private",
        max_concurrent_calls: 2,
      }),
    ]);
  });

  it("accepts explicit public HTTPS streamable_http MCP URLs with bearer auth", () => {
    expect(
      validateMcpServerDefinitions([
        {
          server_id: "notes_http_public",
          transport: "streamable_http",
          url: "https://api.example.com/mcp",
          network_scope: "public_https",
          auth: {
            type: "bearer_env",
            bearer_env_var: "AGENTGIT_PUBLIC_MCP_TOKEN",
          },
          max_concurrent_calls: 2,
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        server_id: "notes_http_public",
        transport: "streamable_http",
        url: "https://api.example.com/mcp",
        network_scope: "public_https",
        max_concurrent_calls: 2,
      }),
    ]);
  });

  it("rejects public HTTPS MCP URLs that are not https", () => {
    expect(() =>
      validateMcpServerDefinitions([
        {
          server_id: "notes_http_public_insecure",
          transport: "streamable_http",
          url: "http://api.example.com/mcp",
          network_scope: "public_https",
          auth: {
            type: "bearer_env",
            bearer_env_var: "AGENTGIT_PUBLIC_MCP_TOKEN",
          },
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      ]),
    ).toThrow("requires an https URL");
  });

  it("rejects public HTTPS MCP URLs without bearer auth", () => {
    expect(() =>
      validateMcpServerDefinitions([
        {
          server_id: "notes_http_public_no_auth",
          transport: "streamable_http",
          url: "https://api.example.com/mcp",
          network_scope: "public_https",
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      ]),
    ).toThrow(
      "requires operator-managed bearer authentication backed by a secret reference or legacy env configuration",
    );
  });

  it("rejects streamable_http custom authorization headers", () => {
    expect(() =>
      validateMcpServerDefinitions([
        {
          server_id: "notes_http_public_bad_header",
          transport: "streamable_http",
          url: "https://api.example.com/mcp",
          network_scope: "public_https",
          headers: {
            Authorization: "Bearer bypass",
          },
          auth: {
            type: "bearer_env",
            bearer_env_var: "AGENTGIT_PUBLIC_MCP_TOKEN",
          },
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      ]),
    ).toThrow("may not override authorization");
  });

  it("rejects duplicate tool names within one server", () => {
    expect(() =>
      validateMcpServerDefinitions([
        {
          server_id: "notes_stdio",
          transport: "stdio",
          command: process.execPath,
          sandbox: {
            type: "oci_container",
            image: TEST_PINNED_OCI_IMAGE,
            allowed_registries: ["docker.io"],
            signature_verification: TEST_OCI_SIGNATURE_POLICY,
          },
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      ]),
    ).toThrow("Duplicate MCP tool_name configured");
  });

  it("rejects stdio servers without an explicit OCI sandbox configuration", () => {
    expect(() =>
      validateMcpServerDefinitions([
        {
          server_id: "notes_stdio",
          transport: "stdio",
          command: process.execPath,
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      ]),
    ).toThrow("requires an explicit oci_container sandbox configuration");
  });

  it("accepts stdio OCI sandbox definitions with local build metadata for development", () => {
    expect(
      validateMcpServerDefinitions([
        {
          server_id: "notes_stdio_oci_build",
          transport: "stdio",
          command: "node",
          args: ["/workspace/server.mjs"],
          sandbox: {
            type: "oci_container",
            image: "agentgit/notes-stdio:dev",
            build: {
              context_path: ".",
              dockerfile_path: "./Dockerfile",
              rebuild_policy: "always",
              build_args: {
                NODE_ENV: "development",
              },
            },
          },
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        server_id: "notes_stdio_oci_build",
        transport: "stdio",
        sandbox: expect.objectContaining({
          type: "oci_container",
          image: "agentgit/notes-stdio:dev",
          build: expect.objectContaining({
            context_path: ".",
            dockerfile_path: "./Dockerfile",
            rebuild_policy: "always",
          }),
        }),
      }),
    ]);
  });

  it("rejects stdio OCI sandbox definitions that use mutable tags without build metadata", () => {
    expect(() =>
      validateMcpServerDefinitions([
        {
          server_id: "notes_stdio_mutable",
          transport: "stdio",
          command: "node",
          sandbox: {
            type: "oci_container",
            image: "node:22-bookworm-slim",
          },
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      ]),
    ).toThrow("must be pinned by sha256 digest unless oci_container.build is configured");
  });

  it("rejects stdio OCI sandbox definitions that omit allowed registries for remote images", () => {
    expect(() =>
      validateMcpServerDefinitions([
        {
          server_id: "notes_stdio_untrusted_registry",
          transport: "stdio",
          command: "node",
          sandbox: {
            type: "oci_container",
            image: TEST_PINNED_OCI_IMAGE,
            signature_verification: TEST_OCI_SIGNATURE_POLICY,
          },
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      ]),
    ).toThrow("must declare allowed_registries unless oci_container.build is configured");
  });

  it("rejects stdio OCI sandbox definitions whose image registry is outside allowed_registries", () => {
    expect(() =>
      validateMcpServerDefinitions([
        {
          server_id: "notes_stdio_wrong_registry",
          transport: "stdio",
          command: "node",
          sandbox: {
            type: "oci_container",
            image: TEST_PINNED_OCI_IMAGE,
            allowed_registries: ["ghcr.io"],
            signature_verification: TEST_OCI_SIGNATURE_POLICY,
          },
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      ]),
    ).toThrow("image registry is not permitted by allowed_registries");
  });

  it("rejects stdio OCI sandbox definitions that omit signature verification for remote images", () => {
    expect(() =>
      validateMcpServerDefinitions([
        {
          server_id: "notes_stdio_unsigned",
          transport: "stdio",
          command: "node",
          sandbox: {
            type: "oci_container",
            image: TEST_PINNED_OCI_IMAGE,
            allowed_registries: ["docker.io"],
          },
          tools: [
            {
              tool_name: "echo_note",
              side_effect_level: "read_only",
              approval_mode: "allow",
            },
          ],
        },
      ]),
    ).toThrow("must configure signature_verification unless oci_container.build is configured");
  });
});

describe("McpPublicHostPolicyRegistry", () => {
  it("matches exact host and port policies for governed public HTTPS targets", () => {
    const root = dirs.make();
    const registry = new McpPublicHostPolicyRegistry({
      dbPath: path.join(root, "host-policies.db"),
    });

    registry.upsertPolicy({
      host: "api.notion.com",
      display_name: "Notion API",
      allow_subdomains: false,
      allowed_ports: [443],
    });

    expect(registry.findPolicyForUrl(new URL("https://api.notion.com/mcp"))?.policy.host).toBe("api.notion.com");
    expect(registry.findPolicyForUrl(new URL("https://api.notion.com:8443/mcp"))).toBeNull();

    registry.close();
  });

  it("rejects wildcard subdomain host policies", () => {
    const root = dirs.make();
    const registry = new McpPublicHostPolicyRegistry({
      dbPath: path.join(root, "host-policies.db"),
    });

    expect(() =>
      registry.upsertPolicy({
        host: "example.com",
        display_name: "Example",
        allow_subdomains: true,
        allowed_ports: [443],
      }),
    ).toThrow("allow_subdomains is not supported");

    registry.close();
  });

  it("supports policy lookup, removal, and explicit allowlist enforcement", () => {
    const root = dirs.make();
    const registry = new McpPublicHostPolicyRegistry({
      dbPath: path.join(root, "host-policies.db"),
    });

    const created = registry.upsertPolicy({
      host: "api.example.com",
      display_name: "Example API",
      allow_subdomains: false,
      allowed_ports: [8443, 443, 443],
    });

    expect(created.created).toBe(true);
    expect(registry.getPolicy(" api.example.com ")?.policy.allowed_ports).toEqual([443, 8443]);
    expect(registry.assertUrlAllowed(new URL("https://api.example.com:8443/mcp")).policy.host).toBe("api.example.com");

    const removed = registry.removePolicy("api.example.com");
    expect(removed?.policy.host).toBe("api.example.com");
    expect(registry.removePolicy("api.example.com")).toBeNull();
    expect(registry.findPolicyForUrl(new URL("https://api.example.com/mcp"))).toBeNull();
    expect(() => registry.assertUrlAllowed(new URL("https://api.example.com/mcp"), "server_demo")).toThrow(
      "requires an explicit operator-managed host allowlist policy",
    );
    expect(registry.checkpointWal()).toEqual(
      expect.objectContaining({
        checkpointed: expect.any(Boolean),
        journal_mode: expect.any(String),
      }),
    );

    registry.close();
  });
});

describe("McpServerRegistry", () => {
  it("stores and reloads registered servers durably", () => {
    const root = dirs.make();
    const dbPath = path.join(root, "registry.db");
    const registry = new McpServerRegistry({ dbPath });

    const created = registry.upsertServer({
      server_id: "notes_http",
      display_name: "Notes over HTTP",
      transport: "streamable_http",
      url: "http://127.0.0.1:3010/mcp",
      headers: {
        "x-agentgit-origin": "test",
      },
      auth: {
        type: "bearer_env",
        bearer_env_var: "AGENTGIT_NOTES_HTTP_TOKEN",
      },
      tools: [
        {
          tool_name: "echo_note",
          side_effect_level: "read_only",
          approval_mode: "allow",
        },
      ],
    });

    expect(created.created).toBe(true);
    registry.close();

    const reloaded = new McpServerRegistry({ dbPath });
    expect(reloaded.listServers()).toMatchObject([
      {
        source: "operator_api",
        server: {
          server_id: "notes_http",
          transport: "streamable_http",
          url: "http://127.0.0.1:3010/mcp",
          auth: {
            type: "bearer_env",
            bearer_env_var: "AGENTGIT_NOTES_HTTP_TOKEN",
          },
        },
      },
    ]);
    reloaded.close();
  });

  it("requires an explicit public host policy for governed public HTTPS registrations", () => {
    const root = dirs.make();
    const hostPolicyRegistry = new McpPublicHostPolicyRegistry({
      dbPath: path.join(root, "host-policies.db"),
    });
    const registry = new McpServerRegistry({
      dbPath: path.join(root, "registry.db"),
      publicHostPolicyRegistry: hostPolicyRegistry,
    });

    expect(() =>
      registry.upsertServer({
        server_id: "notes_http_public",
        transport: "streamable_http",
        url: "https://api.example.com/mcp",
        network_scope: "public_https",
        auth: {
          type: "bearer_env",
          bearer_env_var: "AGENTGIT_PUBLIC_MCP_TOKEN",
        },
        tools: [
          {
            tool_name: "echo_note",
            side_effect_level: "read_only",
            approval_mode: "allow",
          },
        ],
      }),
    ).toThrow("requires an explicit operator-managed host allowlist policy");

    hostPolicyRegistry.upsertPolicy({
      host: "api.example.com",
      display_name: "Example API",
      allow_subdomains: false,
      allowed_ports: [443],
    });

    expect(() =>
      registry.upsertServer({
        server_id: "notes_http_public",
        transport: "streamable_http",
        url: "https://api.example.com/mcp",
        network_scope: "public_https",
        auth: {
          type: "bearer_env",
          bearer_env_var: "AGENTGIT_PUBLIC_MCP_TOKEN",
        },
        tools: [
          {
            tool_name: "echo_note",
            side_effect_level: "read_only",
            approval_mode: "allow",
          },
        ],
      }),
    ).not.toThrow();

    registry.close();
    hostPolicyRegistry.close();
  });

  it("bootstraps env-provided servers without overwriting operator-managed records", () => {
    const root = dirs.make();
    const registry = new McpServerRegistry({ dbPath: path.join(root, "registry.db") });

    registry.upsertServer({
      server_id: "notes_stdio",
      display_name: "Operator owned",
      transport: "stdio",
      command: process.execPath,
      sandbox: {
        type: "oci_container",
        image: TEST_PINNED_OCI_IMAGE,
        allowed_registries: ["docker.io"],
        signature_verification: {
          mode: "cosign_keyless",
          certificate_identity: "https://github.com/agentgit/agentgit/.github/workflows/release.yml@refs/heads/main",
          certificate_oidc_issuer: "https://token.actions.githubusercontent.com",
        },
      },
      tools: [
        {
          tool_name: "echo_note",
          side_effect_level: "read_only",
          approval_mode: "allow",
        },
      ],
    });

    const summary = registry.bootstrapServers([
      {
        server_id: "notes_stdio",
        display_name: "Bootstrap owned",
        transport: "stdio",
        command: "/bin/false",
        sandbox: {
          type: "oci_container",
          image: TEST_PINNED_OCI_IMAGE,
          allowed_registries: ["docker.io"],
          signature_verification: {
            mode: "cosign_keyless",
            certificate_identity: "https://github.com/agentgit/agentgit/.github/workflows/release.yml@refs/heads/main",
            certificate_oidc_issuer: "https://token.actions.githubusercontent.com",
          },
        },
        tools: [
          {
            tool_name: "echo_note",
            side_effect_level: "read_only",
            approval_mode: "allow",
          },
        ],
      },
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
    ]);

    expect(summary).toEqual({
      imported: 1,
      skipped: 1,
    });
    expect(
      registry.listServers().map((record) => ({ server_id: record.server.server_id, source: record.source })),
    ).toEqual([
      {
        server_id: "notes_http",
        source: "bootstrap_env",
      },
      {
        server_id: "notes_stdio",
        source: "operator_api",
      },
    ]);
    registry.close();
  });

  it("stores MCP server candidates durably", () => {
    const root = dirs.make();
    const dbPath = path.join(root, "registry.db");
    const registry = new McpServerRegistry({ dbPath });

    const stored = registry.submitCandidate({
      candidate_id: "mcpcand_123",
      source_kind: "user_input",
      raw_endpoint: "https://api.example.com/mcp",
      transport_hint: "streamable_http",
      workspace_id: "workspace_demo",
      submitted_by_session_id: "sess_demo",
      submitted_by_run_id: null,
      notes: "Initial candidate",
      resolution_state: "pending",
      resolution_error: null,
      submitted_at: "2026-04-01T10:00:00.000Z",
      updated_at: "2026-04-01T10:00:00.000Z",
    });

    expect(stored).toMatchObject({
      candidate_id: "mcpcand_123",
      source_kind: "user_input",
      raw_endpoint: "https://api.example.com/mcp",
    });

    registry.close();

    const reloaded = new McpServerRegistry({ dbPath });
    expect(reloaded.listCandidates()).toMatchObject([
      {
        candidate_id: "mcpcand_123",
        source_kind: "user_input",
        resolution_state: "pending",
        resolution_error: null,
      },
    ]);
    reloaded.close();
  });

  it("stores MCP server profiles durably", () => {
    const root = dirs.make();
    const dbPath = path.join(root, "registry.db");
    const registry = new McpServerRegistry({ dbPath });

    const result = registry.upsertProfile({
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
        tool_inventory_hash: null,
        fetched_at: "2026-04-01T10:00:00.000Z",
      },
      tool_inventory_version: null,
      active_credential_binding_id: null,
      imported_tools: [],
      last_resolved_at: "2026-04-01T10:00:00.000Z",
      created_at: "2026-04-01T10:00:00.000Z",
      updated_at: "2026-04-01T10:00:00.000Z",
    });

    expect(result.created).toBe(true);
    expect(result.profile.server_profile_id).toBe("mcpprof_123");

    registry.close();

    const reloaded = new McpServerRegistry({ dbPath });
    expect(reloaded.listProfiles()).toMatchObject([
      {
        server_profile_id: "mcpprof_123",
        trust_tier: "operator_approved_public",
        status: "draft",
        drift_state: "clean",
      },
    ]);
    reloaded.close();
  });

  it("stores MCP server trust decisions durably", () => {
    const root = dirs.make();
    const dbPath = path.join(root, "registry.db");
    const registry = new McpServerRegistry({ dbPath });

    const result = registry.upsertTrustDecision({
      trust_decision_id: "mcptrust_123",
      server_profile_id: "mcpprof_123",
      decision: "allow_policy_managed",
      trust_tier: "operator_approved_public",
      allowed_execution_modes: ["local_proxy"],
      max_side_effect_level_without_approval: "read_only",
      reason_codes: ["INITIAL_REVIEW_COMPLETE"],
      approved_by_session_id: "sess_demo",
      approved_at: "2026-04-01T10:00:00.000Z",
      valid_until: null,
      reapproval_triggers: ["tool_inventory_hash_changed"],
    });

    expect(result.created).toBe(true);
    expect(result.trust_decision.trust_decision_id).toBe("mcptrust_123");

    registry.close();

    const reloaded = new McpServerRegistry({ dbPath });
    expect(reloaded.listTrustDecisions("mcpprof_123")).toMatchObject([
      {
        trust_decision_id: "mcptrust_123",
        server_profile_id: "mcpprof_123",
        decision: "allow_policy_managed",
        trust_tier: "operator_approved_public",
      },
    ]);
    reloaded.close();
  });

  it("round-trips governed registry records across credential, lease, attestation, and job surfaces", () => {
    const root = dirs.make();
    const dbPath = path.join(root, "registry.db");
    const registry = new McpServerRegistry({ dbPath });

    registry.submitCandidate({
      candidate_id: "mcpcand_rel",
      source_kind: "user_input",
      raw_endpoint: "https://api.example.com/mcp",
      transport_hint: "streamable_http",
      workspace_id: "workspace_demo",
      submitted_by_session_id: "sess_demo",
      submitted_by_run_id: null,
      notes: "  Candidate note  ",
      resolution_state: "resolved",
      resolution_error: null,
      submitted_at: "2026-04-01T10:00:00.000Z",
      updated_at: "2026-04-01T10:00:00.000Z",
    });

    const trustDecision = registry.upsertTrustDecision({
      trust_decision_id: "mcptrust_rel",
      server_profile_id: "mcpprof_rel",
      decision: "allow_policy_managed",
      trust_tier: "operator_approved_public",
      allowed_execution_modes: ["local_proxy", "local_proxy"],
      max_side_effect_level_without_approval: "read_only",
      reason_codes: ["REVIEWED", "REVIEWED"],
      approved_by_session_id: "sess_demo",
      approved_at: "2026-04-01T10:00:00.000Z",
      valid_until: null,
      reapproval_triggers: ["tool_inventory_hash_changed", "tool_inventory_hash_changed"],
    });
    const credentialBinding = registry.upsertCredentialBinding({
      credential_binding_id: "mcpcred_rel",
      server_profile_id: "mcpprof_rel",
      binding_mode: "session_token",
      broker_profile_id: "broker_demo",
      scope_labels: ["scope:read", "scope:read"],
      audience: "https://api.example.com",
      status: "active",
      created_at: "2026-04-01T10:00:00.000Z",
      updated_at: "2026-04-01T10:00:00.000Z",
      revoked_at: null,
    });
    const profile = registry.upsertProfile({
      server_profile_id: "mcpprof_rel",
      candidate_id: "mcpcand_rel",
      display_name: " Example MCP ",
      transport: "streamable_http",
      canonical_endpoint: "https://api.example.com/mcp",
      network_scope: "public_https",
      trust_tier: "operator_approved_public",
      status: "active",
      drift_state: "clean",
      quarantine_reason_codes: ["REVIEW_PENDING", "REVIEW_PENDING"],
      allowed_execution_modes: ["local_proxy", "local_proxy"],
      active_trust_decision_id: trustDecision.trust_decision.trust_decision_id,
      auth_descriptor: {
        mode: "session_token",
        audience: " https://api.example.com ",
        scope_labels: ["scope:read", "scope:read"],
      },
      identity_baseline: {
        canonical_host: " api.example.com ",
        canonical_port: 443,
        tls_identity_summary: " tls ",
        auth_issuer: " issuer ",
        publisher_identity: " publisher ",
        tool_inventory_hash: " hash ",
        fetched_at: "2026-04-01T10:00:00.000Z",
      },
      tool_inventory_version: " v1 ",
      active_credential_binding_id: credentialBinding.credential_binding.credential_binding_id,
      imported_tools: [
        {
          tool_name: " echo_note ",
          side_effect_level: "read_only",
          approval_mode: "allow",
          input_schema_hash: " in ",
          output_schema_hash: " out ",
          annotations: {
            zeta: "last",
            alpha: "first",
          },
          imported_at: "2026-04-01T10:00:00.000Z",
        },
      ],
      last_resolved_at: "2026-04-01T10:00:00.000Z",
      created_at: "2026-04-01T10:00:00.000Z",
      updated_at: "2026-04-01T10:00:00.000Z",
    });
    const lease = registry.upsertHostedExecutionLease({
      lease_id: "mcplease_rel",
      run_id: "run_demo",
      action_id: "act_demo",
      server_profile_id: "mcpprof_rel",
      tool_name: " echo_note ",
      auth_context_ref: " auth_demo ",
      allowed_hosts: ["api.example.com", "api.example.com"],
      issued_at: "2026-04-01T10:00:00.000Z",
      expires_at: "2026-04-01T11:00:00.000Z",
      artifact_budget: {
        max_artifacts: 2,
        max_total_bytes: 4096,
      },
      single_use: true,
      status: "issued",
      consumed_at: null,
      revoked_at: null,
    });
    const attestation = registry.upsertHostedExecutionAttestation({
      attestation_id: "mcpatt_rel",
      lease_id: lease.lease.lease_id,
      worker_runtime_id: "worker_demo",
      worker_image_digest:
        "docker.io/agentgit/worker@sha256:1111111111111111111111111111111111111111111111111111111111111111",
      started_at: "2026-04-01T10:05:00.000Z",
      completed_at: "2026-04-01T10:06:00.000Z",
      result_hash: "result_hash",
      artifact_manifest_hash: "manifest_hash",
      signature: "signed_payload",
      verified_at: "2026-04-01T10:07:00.000Z",
    });
    const job = registry.upsertHostedExecutionJob({
      job_id: "mcpjob_rel",
      run_id: "run_demo",
      action_id: "act_demo",
      server_profile_id: "mcpprof_rel",
      tool_name: "echo_note",
      server_display_name: "Example MCP",
      canonical_endpoint: "https://api.example.com/mcp",
      network_scope: "public_https",
      allowed_hosts: ["api.example.com", "api.example.com"],
      auth_context_ref: "auth_demo",
      arguments: {
        note: "hello",
      },
      status: "succeeded",
      attempt_count: 1,
      max_attempts: 3,
      current_lease_id: lease.lease.lease_id,
      claimed_by: "worker_demo",
      claimed_at: "2026-04-01T10:05:00.000Z",
      last_heartbeat_at: "2026-04-01T10:05:30.000Z",
      cancel_requested_at: null,
      cancel_requested_by_session_id: null,
      cancel_reason: null,
      canceled_at: null,
      next_attempt_at: "2026-04-01T10:05:00.000Z",
      created_at: "2026-04-01T10:00:00.000Z",
      updated_at: "2026-04-01T10:06:00.000Z",
      completed_at: "2026-04-01T10:06:00.000Z",
      last_error: null,
      execution_result: {
        execution_id: "exec_demo",
        action_id: "act_demo",
        mode: "executed",
        success: true,
        output: {
          ok: true,
        },
        artifacts: [],
        started_at: "2026-04-01T10:05:00.000Z",
        completed_at: "2026-04-01T10:06:00.000Z",
      },
    });

    registry.upsertServer(
      {
        server_id: "notes_stdio_rel",
        display_name: "Operator owned",
        transport: "stdio",
        command: process.execPath,
        sandbox: {
          type: "oci_container",
          image: TEST_PINNED_OCI_IMAGE,
          allowed_registries: ["docker.io"],
          signature_verification: TEST_OCI_SIGNATURE_POLICY,
        },
        tools: [
          {
            tool_name: "echo_note",
            side_effect_level: "read_only",
            approval_mode: "allow",
          },
        ],
      },
      "operator_api",
    );

    expect(registry.getCandidate("mcpcand_rel")?.notes).toBe("Candidate note");
    expect(registry.getProfile("mcpprof_rel")?.display_name).toBe("Example MCP");
    expect(registry.getProfileByCandidateId("mcpcand_rel")?.server_profile_id).toBe("mcpprof_rel");
    expect(registry.getTrustDecision("mcptrust_rel")?.trust_decision_id).toBe("mcptrust_rel");
    expect(registry.getActiveTrustDecision("mcpprof_rel")?.trust_decision_id).toBe("mcptrust_rel");
    expect(registry.listTrustDecisions("mcpprof_rel")).toHaveLength(1);
    expect(registry.getCredentialBinding("mcpcred_rel")?.credential_binding_id).toBe("mcpcred_rel");
    expect(registry.getActiveCredentialBinding("mcpprof_rel")?.credential_binding_id).toBe("mcpcred_rel");
    expect(registry.listCredentialBindings("mcpprof_rel")).toHaveLength(1);
    expect(registry.getHostedExecutionLease("mcplease_rel")?.lease_id).toBe("mcplease_rel");
    expect(registry.listHostedExecutionLeases("mcpprof_rel")).toHaveLength(1);
    expect(registry.getHostedExecutionAttestation("mcpatt_rel")?.attestation_id).toBe("mcpatt_rel");
    expect(registry.listHostedExecutionAttestations("mcplease_rel")).toHaveLength(1);
    expect(registry.getHostedExecutionJob("mcpjob_rel")?.job_id).toBe("mcpjob_rel");
    expect(registry.listHostedExecutionJobs("mcpprof_rel")).toHaveLength(1);
    expect(registry.listDefinitions().map((server) => server.server_id)).toContain("notes_stdio_rel");
    expect(registry.removeServer("notes_stdio_rel")?.server.server_id).toBe("notes_stdio_rel");
    expect(registry.removeServer("notes_stdio_rel")).toBeNull();
    expect(registry.checkpointWal()).toEqual(
      expect.objectContaining({
        checkpointed: expect.any(Boolean),
        journal_mode: expect.any(String),
      }),
    );
    expect(profile.profile.auth_descriptor.scope_labels).toEqual(["scope:read"]);
    expect(attestation.created).toBe(true);
    expect(job.created).toBe(true);

    registry.close();
  });
});
