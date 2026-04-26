import { describe, expect, it } from "vitest";

import { CSRF_COOKIE_NAME } from "@/lib/security/csrf";

describe("csrf route", () => {
  it("primes a readable csrf cookie for browser mutations", async () => {
    const { GET } = await import("./route");
    const response = await GET(new Request("http://localhost/api/v1/csrf"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("set-cookie")).toContain(`${CSRF_COOKIE_NAME}=`);
    expect(response.headers.get("set-cookie")?.toLowerCase()).toContain("samesite=strict");
  });
});
