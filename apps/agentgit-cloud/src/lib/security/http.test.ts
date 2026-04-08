import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

import { buildApiCorsResponse, buildContentSecurityPolicy } from "@/lib/security/http";

describe("security http helpers", () => {
  it("allows same-origin API preflight requests", () => {
    const request = new NextRequest("https://cloud.agentgit.dev/api/v1/dashboard", {
      method: "OPTIONS",
      headers: {
        origin: "https://cloud.agentgit.dev",
        "access-control-request-headers": "authorization,content-type",
      },
    });

    const response = buildApiCorsResponse(request);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://cloud.agentgit.dev");
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("rejects cross-origin API requests that are not allowlisted", () => {
    const request = new NextRequest("https://cloud.agentgit.dev/api/v1/dashboard", {
      method: "OPTIONS",
      headers: {
        origin: "https://evil.example",
      },
    });

    const response = buildApiCorsResponse(request);

    expect(response.status).toBe(403);
  });

  it("includes the expected CSP directives for Sentry and Vercel analytics", () => {
    const csp = buildContentSecurityPolicy();

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("https://va.vercel-scripts.com");
    expect(csp).toContain("https://vitals.vercel-insights.com");
    expect(csp).toContain("https://*.ingest.sentry.io");
  });
});
