import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalEncryptedSecretStore, SessionCredentialBroker } from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true });
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
    const broker = new SessionCredentialBroker({
      mcpSecretStore: new LocalEncryptedSecretStore({
        dbPath: path.join(root, "mcp-secrets.db"),
        keyPath: path.join(root, "mcp-secrets.key"),
      }),
    });

    const created = broker.upsertMcpBearerSecret({
      secret_id: "mcp_secret_notion",
      display_name: "Notion MCP",
      bearer_token: "secret-token-v1",
    });
    expect(created.created).toBe(true);
    expect(created.rotated).toBe(false);
    expect(created.secret.version).toBe(1);

    const rotated = broker.upsertMcpBearerSecret({
      secret_id: "mcp_secret_notion",
      display_name: "Notion MCP",
      bearer_token: "secret-token-v2",
    });
    expect(rotated.created).toBe(false);
    expect(rotated.rotated).toBe(true);
    expect(rotated.secret.version).toBe(2);

    const listed = broker.listMcpBearerSecrets();
    expect(listed).toEqual([
      expect.objectContaining({
        secret_id: "mcp_secret_notion",
        version: 2,
      }),
    ]);
    expect(JSON.stringify(listed)).not.toContain("secret-token-v2");

    const resolved = broker.resolveMcpBearerSecret("mcp_secret_notion");
    expect(resolved.authorization_header).toBe("Bearer secret-token-v2");
    expect(resolved.secret.last_used_at).toBeTruthy();
  });
});
