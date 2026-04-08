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
});
