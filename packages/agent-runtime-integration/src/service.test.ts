import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { AuthorityClientTransportError } from "@agentgit/authority-sdk";

import { __testables } from "./service.js";

function makeTempDir(): string {
  const root = path.join(os.tmpdir(), `agent-runtime-service-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function connectFailure(message = "connect failed"): AuthorityClientTransportError {
  return new AuthorityClientTransportError(message, "SOCKET_CONNECT_FAILED", true, {
    errno: "ENOENT",
  });
}

function fakeClient(helloImpl: () => Promise<unknown>) {
  return {
    hello: helloImpl,
  } as never;
}

function fakeDaemon(onShutdown?: () => void) {
  return {
    shutdown: async () => {
      onShutdown?.();
    },
  } as never;
}

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("authority session hardening", () => {
  it("retries when daemon startup races on EADDRINUSE and then reuses the winner", async () => {
    tempDir = makeTempDir();
    const buildCalls: string[] = [];
    let sleepCalls = 0;

    const result = await __testables.ensureAuthoritySession(
      tempDir,
      process.env,
      path.join(tempDir, "runtime"),
      {
        build_client: () => {
          buildCalls.push("build");
          if (buildCalls.length === 1) {
            return fakeClient(async () => {
              throw connectFailure();
            });
          }
          return fakeClient(async () => ({ ok: true }));
        },
        start_daemon: async () => {
          const error = new Error("listen EADDRINUSE: address already in use /tmp/test.sock") as Error & {
            code?: string;
          };
          error.code = "EADDRINUSE";
          throw error;
        },
        sleep: async () => {
          sleepCalls += 1;
        },
      },
    );

    expect(result.daemon_started).toBe(false);
    expect(buildCalls.length).toBe(2);
    expect(sleepCalls).toBe(1);
  });

  it("retries after a started daemon still fails its first hello and shuts that daemon down", async () => {
    tempDir = makeTempDir();
    let buildCalls = 0;
    let startCalls = 0;
    let shutdownCalls = 0;
    let sleepCalls = 0;

    const result = await __testables.ensureAuthoritySession(
      tempDir,
      process.env,
      path.join(tempDir, "runtime"),
      {
        build_client: () => {
          buildCalls += 1;
          if (buildCalls <= 2) {
            return fakeClient(async () => {
              throw connectFailure();
            });
          }
          return fakeClient(async () => ({ ok: true }));
        },
        start_daemon: async () => {
          startCalls += 1;
          return fakeDaemon(() => {
            shutdownCalls += 1;
          });
        },
        sleep: async () => {
          sleepCalls += 1;
        },
      },
    );

    expect(result.daemon_started).toBe(false);
    expect(startCalls).toBe(1);
    expect(shutdownCalls).toBe(1);
    expect(sleepCalls).toBe(1);
  });
});
