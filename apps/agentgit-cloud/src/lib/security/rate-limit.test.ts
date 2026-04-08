import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  enforceApiRateLimits,
  enforceConnectorRegistrationRateLimits,
} from "@/lib/security/rate-limit";

describe("rate limit enforcement", () => {
  const originalAgentGitRoot = process.env.AGENTGIT_ROOT;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();

    if (originalAgentGitRoot === undefined) {
      delete process.env.AGENTGIT_ROOT;
    } else {
      process.env.AGENTGIT_ROOT = originalAgentGitRoot;
    }

    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }

    for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns 429 after the per-IP API write budget is exhausted and resets on the next window", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-rate-limit-"));
    tempDirs.push(tempDir);
    process.env.AGENTGIT_ROOT = tempDir;
    delete process.env.DATABASE_URL;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T19:00:00Z"));

    const request = new Request("http://localhost/api/v1/approvals", {
      method: "POST",
      headers: {
        "x-forwarded-for": "203.0.113.10",
      },
    });

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await expect(enforceApiRateLimits(request, "ws_acme_01")).resolves.toBeNull();
    }

    const limited = await enforceApiRateLimits(request, "ws_acme_01");

    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("retry-after")).toBe("60");
    expect(limited?.headers.get("x-ratelimit-limit")).toBe("120");
    expect(limited?.headers.get("x-ratelimit-remaining")).toBe("0");

    vi.setSystemTime(new Date("2026-04-07T19:01:01Z"));

    await expect(enforceApiRateLimits(request, "ws_acme_01")).resolves.toBeNull();
  });

  it("enforces workspace-scoped connector registration quotas independently from source IP", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-cloud-rate-limit-"));
    tempDirs.push(tempDir);
    process.env.AGENTGIT_ROOT = tempDir;
    delete process.env.DATABASE_URL;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T19:10:00Z"));

    for (let attempt = 0; attempt < 40; attempt += 1) {
      const request = new Request("http://localhost/api/v1/sync/register", {
        method: "POST",
        headers: {
          "x-forwarded-for": `198.51.100.${attempt + 1}`,
        },
      });
      await expect(enforceConnectorRegistrationRateLimits(request, "ws_acme_01")).resolves.toBeNull();
    }

    const limited = await enforceConnectorRegistrationRateLimits(
      new Request("http://localhost/api/v1/sync/register", {
        method: "POST",
        headers: {
          "x-forwarded-for": "198.51.100.99",
        },
      }),
      "ws_acme_01",
    );

    expect(limited?.status).toBe(429);
    expect(limited?.headers.get("x-ratelimit-limit")).toBe("40");
    expect(limited?.headers.get("x-ratelimit-remaining")).toBe("0");
  });
});
