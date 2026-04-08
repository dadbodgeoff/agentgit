import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalEncryptedSecretStore, SessionCredentialBroker } from "./index.js";

const dirs: string[] = [];
const keychainCleanup: Array<{ serviceName: string; keyIdentifier: string }> = [];

afterEach(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  }

  while (keychainCleanup.length > 0) {
    const item = keychainCleanup.pop()!;
    if (process.platform === "darwin") {
      try {
        execFileSync("security", [
          "delete-generic-password",
          "-a",
          "mcp-envelope-key",
          "-s",
          `${item.serviceName}:${item.keyIdentifier}`,
        ]);
      } catch {
        // ignore cleanup failures
      }
    }
  }
});

describe("SessionCredentialBroker", () => {
  it("registers and resolves brokered bearer access without exposing token metadata", () => {
    const broker = new SessionCredentialBroker();

    const metadata = broker.registerBearerProfile({
      integration: "tickets",
      base_url: "http://127.0.0.1:3000/api",
      token: "super-secret-token",
      scopes: ["tickets:write"],
      profile_id: "credprof_tickets",
    });

    expect(metadata.token).toBe("[REDACTED]");
    const access = broker.resolveBearerAccess({
      integration: "tickets",
      required_scope: "tickets:write",
    });

    expect(access.base_url).toBe("http://127.0.0.1:3000/api/");
    expect(access.authorization_header).toBe("Bearer super-secret-token");
    expect(access.handle.profile_id).toBe("credprof_tickets");
    expect(access.handle.integration).toBe("tickets");
    expect(access.handle.scopes).toEqual(["tickets:write"]);
    expect(Object.values(access.handle)).not.toContain("super-secret-token");
  });

  it("fails closed when a brokered profile is missing", () => {
    const broker = new SessionCredentialBroker();

    expect(() =>
      broker.resolveBearerAccess({
        integration: "tickets",
        required_scope: "tickets:write",
      }),
    ).toThrow("Brokered credentials are not configured");
  });

  it("fails closed when the requested scope is unavailable", () => {
    const broker = new SessionCredentialBroker();
    broker.registerBearerProfile({
      integration: "tickets",
      base_url: "http://127.0.0.1:3000/api",
      token: "super-secret-token",
      scopes: ["tickets:read"],
    });

    expect(() =>
      broker.resolveBearerAccess({
        integration: "tickets",
        required_scope: "tickets:write",
      }),
    ).toThrow("required scope");
  });

  it("stores, rotates, and resolves MCP bearer secrets without listing the raw token", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-credential-broker-"));
    dirs.push(root);
    const serviceName = `com.agentgit.tests.credential-broker.${Date.now()}`;
    const broker = new SessionCredentialBroker({
      mcpSecretStore: new LocalEncryptedSecretStore({
        dbPath: path.join(root, "mcp-secrets.db"),
        keyPath: path.join(root, "mcp-secrets.key"),
        serviceName,
      }),
    });
    const durableDetails = broker.durableSecretStorageDetails();
    if (durableDetails) {
      keychainCleanup.push({
        serviceName,
        keyIdentifier: durableDetails.key_identifier,
      });
    }

    const created = broker.upsertMcpBearerSecret({
      secret_id: "mcp_secret_notion",
      display_name: "Notion MCP",
      bearer_token: "secret-token-v1",
      expires_at: "2099-01-01T00:00:00.000Z",
    });
    expect(created.created).toBe(true);
    expect(created.rotated).toBe(false);
    expect(created.secret.version).toBe(1);
    expect(created.secret.expires_at).toBe("2099-01-01T00:00:00.000Z");

    const rotated = broker.upsertMcpBearerSecret({
      secret_id: "mcp_secret_notion",
      display_name: "Notion MCP",
      bearer_token: "secret-token-v2",
      expires_at: "2099-06-01T00:00:00.000Z",
    });
    expect(rotated.created).toBe(false);
    expect(rotated.rotated).toBe(true);
    expect(rotated.secret.version).toBe(2);
    expect(rotated.secret.expires_at).toBe("2099-06-01T00:00:00.000Z");

    const listed = broker.listMcpBearerSecrets();
    expect(listed).toEqual([
      expect.objectContaining({
        secret_id: "mcp_secret_notion",
        version: 2,
        expires_at: "2099-06-01T00:00:00.000Z",
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain("secret-token-v2");
    expect(fs.existsSync(path.join(root, "mcp-secrets.key"))).toBe(false);

    const resolved = broker.resolveMcpBearerSecret("mcp_secret_notion");
    expect(resolved.authorization_header).toBe("Bearer secret-token-v2");
    expect(resolved.secret.last_used_at).toBeTruthy();
  });

  it("fails closed when an MCP bearer secret is expired", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-credential-broker-"));
    dirs.push(root);
    const serviceName = `com.agentgit.tests.credential-broker.expired.${Date.now()}`;
    const broker = new SessionCredentialBroker({
      mcpSecretStore: new LocalEncryptedSecretStore({
        dbPath: path.join(root, "mcp-secrets.db"),
        keyPath: path.join(root, "mcp-secrets.key"),
        serviceName,
      }),
    });
    const durableDetails = broker.durableSecretStorageDetails();
    if (durableDetails) {
      keychainCleanup.push({
        serviceName,
        keyIdentifier: durableDetails.key_identifier,
      });
    }

    broker.upsertMcpBearerSecret({
      secret_id: "mcp_secret_expired",
      bearer_token: "secret-token-expired",
      expires_at: "2000-01-01T00:00:00.000Z",
    });

    expect(() => broker.resolveMcpBearerSecret("mcp_secret_expired")).toThrow("expired");
  }, 20_000);

  it("resolves header-template and tool-scoped runtime bindings without leaking the source token", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-credential-broker-"));
    dirs.push(root);
    const serviceName = `com.agentgit.tests.credential-broker.runtime-bindings.${Date.now()}`;
    const broker = new SessionCredentialBroker({
      mcpSecretStore: new LocalEncryptedSecretStore({
        dbPath: path.join(root, "mcp-secrets.db"),
        keyPath: path.join(root, "mcp-secrets.key"),
        serviceName,
      }),
    });
    const durableDetails = broker.durableSecretStorageDetails();
    if (durableDetails) {
      keychainCleanup.push({
        serviceName,
        keyIdentifier: durableDetails.key_identifier,
      });
    }

    broker.upsertMcpBearerSecret({
      secret_id: "mcp_secret_runtime",
      bearer_token: "runtime-secret-token",
      expires_at: "2099-01-01T00:00:00.000Z",
    });

    const headerBinding = broker.resolveRuntimeCredentialBinding({
      binding_id: "rcb_header",
      kind: "header_template",
      target: {
        surface: "env",
        env_key: "OPENAI_AUTH_HEADER",
      },
      broker_source_ref: "mcp_secret_runtime",
      redacted_delivery_metadata: {
        template: "Bearer {{token}}",
      },
      rotates: true,
    });
    expect(headerBinding.resolved_value).toBe("Bearer runtime-secret-token");
    expect(JSON.stringify(headerBinding.binding)).not.toContain("runtime-secret-token");

    const toolBinding = broker.resolveRuntimeCredentialBinding({
      binding_id: "rcb_tool",
      kind: "tool_scoped_ref",
      target: {
        surface: "env",
        env_key: "OPENAI_TOOL_REF",
      },
      broker_source_ref: "mcp_secret_runtime",
      redacted_delivery_metadata: {
        tool_name: "github",
      },
      rotates: true,
    });
    expect(toolBinding.resolved_value).toBe("agentgit+tool-ref://github?binding=rcb_tool&source=mcp_secret_runtime");
    expect(toolBinding.expires_at).toBe("2099-01-01T00:00:00.000Z");
  });

  it("mints bounded runtime tickets from brokered bindings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-credential-broker-"));
    dirs.push(root);
    const serviceName = `com.agentgit.tests.credential-broker.runtime-ticket.${Date.now()}`;
    const broker = new SessionCredentialBroker({
      mcpSecretStore: new LocalEncryptedSecretStore({
        dbPath: path.join(root, "mcp-secrets.db"),
        keyPath: path.join(root, "mcp-secrets.key"),
        serviceName,
      }),
    });
    const durableDetails = broker.durableSecretStorageDetails();
    if (durableDetails) {
      keychainCleanup.push({
        serviceName,
        keyIdentifier: durableDetails.key_identifier,
      });
    }

    broker.upsertMcpBearerSecret({
      secret_id: "mcp_secret_ticket",
      bearer_token: "runtime-ticket-secret",
      expires_at: "2099-01-01T00:00:00.000Z",
    });

    const ticketBinding = broker.resolveRuntimeCredentialBinding({
      binding_id: "rcb_ticket",
      kind: "runtime_ticket",
      target: {
        surface: "file",
        relative_path: "auth/runtime.ticket",
      },
      broker_source_ref: "mcp_secret_ticket",
      redacted_delivery_metadata: {
        audience: "https://api.example.com",
        ticket_ttl_seconds: 120,
      },
      rotates: true,
    });

    expect(ticketBinding.resolved_value.startsWith("agtkt.")).toBe(true);
    expect(ticketBinding.expires_at).toBeTruthy();
    const [, encodedPayload] = ticketBinding.resolved_value.split(".");
    expect(encodedPayload).toBeTruthy();
    const payload = JSON.parse(Buffer.from(encodedPayload!, "base64url").toString("utf8")) as {
      audience?: string;
      binding_id: string;
      broker_source_ref: string;
      kind: string;
      exp: string;
    };
    expect(payload).toMatchObject({
      binding_id: "rcb_ticket",
      broker_source_ref: "mcp_secret_ticket",
      kind: "runtime_ticket",
      audience: "https://api.example.com",
    });
    expect(Date.parse(payload.exp)).toBeGreaterThan(Date.now());
  });
});
