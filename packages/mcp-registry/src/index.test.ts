import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createTempDirTracker } from "@agentgit/test-fixtures";

import { McpPublicHostPolicyRegistry, McpServerRegistry, validateMcpServerDefinitions } from "./index.js";

const dirs = createTempDirTracker("agentgit-mcp-registry-");

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
    ).toThrow("requires operator-managed bearer authentication backed by a secret reference or legacy env configuration");
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
    expect(registry.listServers().map((record) => ({ server_id: record.server.server_id, source: record.source }))).toEqual([
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
});
