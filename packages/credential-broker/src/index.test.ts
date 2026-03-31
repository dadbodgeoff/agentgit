import { describe, expect, it } from "vitest";

import { SessionCredentialBroker } from "./index.js";

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
});
