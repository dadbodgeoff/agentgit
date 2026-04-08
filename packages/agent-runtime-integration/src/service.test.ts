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

    const result = await __testables.ensureAuthoritySession(tempDir, process.env, path.join(tempDir, "runtime"), {
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
    });

    expect(result.daemon_started).toBe(false);
    expect(buildCalls.length).toBe(2);
    expect(sleepCalls).toBe(0);
  });

  it("retries after a started daemon still fails its first hello and shuts that daemon down", async () => {
    tempDir = makeTempDir();
    let buildCalls = 0;
    let startCalls = 0;
    let shutdownCalls = 0;
    let sleepCalls = 0;

    const result = await __testables.ensureAuthoritySession(tempDir, process.env, path.join(tempDir, "runtime"), {
      build_client: () => {
        buildCalls += 1;
        if (buildCalls <= 3) {
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
    });

    expect(result.daemon_started).toBe(false);
    expect(startCalls).toBe(1);
    expect(shutdownCalls).toBe(1);
    expect(sleepCalls).toBe(1);
  });
});

describe("restore presentation helpers", () => {
  it("derives action-boundary restore targets for review-only steps without snapshots", () => {
    const target = __testables.deriveRestoreTargetFromStep({
      action_id: "act_review",
      reversibility_class: "review_only",
      related: {
        snapshot_id: null,
        recovery_target_type: null,
      },
    } as never);

    expect(target).toEqual({
      type: "action_boundary",
      action_id: "act_review",
    });
  });

  it("uses recorded path subsets when available", () => {
    const target = __testables.deriveRestoreTargetFromStep({
      action_id: "act_path",
      reversibility_class: "reversible",
      related: {
        snapshot_id: "snap_path",
        recovery_target_type: "path_subset",
        recovery_scope_paths: ["/workspace/project/src/index.ts"],
        target_locator: null,
      },
    } as never);

    expect(target).toEqual({
      type: "path_subset",
      snapshot_id: "snap_path",
      paths: ["/workspace/project/src/index.ts"],
    });
    expect(__testables.buildRestoreCommand(target)).toBe('agentgit restore --path "/workspace/project/src/index.ts"');
  });

  it("describes and summarizes review-only restore boundaries honestly", () => {
    const target = {
      type: "external_object",
      external_object_id: "ext_123",
    } as const;

    expect(__testables.summarizeRestoreTarget(target)).toBe("external object ext_123");
    expect(__testables.describeRestoreBoundary(target, "review_only")).toBe("review-only external object recovery");
    expect(__testables.explainRestoreBoundary(target, "review_only")).toContain("manual review");
  });

  it("plans restore presentation from the daemon recovery class", async () => {
    const presentation = await __testables.planRestorePresentation(
      {
        planRecovery: async () => ({
          recovery_plan: {
            recovery_class: "review_only",
          },
        }),
      } as never,
      {
        type: "snapshot_id",
        snapshot_id: "snap_review",
      },
    );

    expect(presentation).toEqual({
      restore_available: true,
      recovery_class: "review_only",
      restore_boundary: "review-only snapshot boundary",
      restore_guidance:
        "AgentGit can inspect the captured snapshot boundary, but this restore still requires manual review instead of exact automatic replay.",
    });
  });

  it("surfaces restore as unavailable when recovery planning fails", async () => {
    const presentation = await __testables.planRestorePresentation(
      {
        planRecovery: async () => {
          throw new Error("plan failed");
        },
      } as never,
      {
        type: "branch_point",
        run_id: "run_123",
        sequence: 7,
      },
    );

    expect(presentation).toEqual({
      restore_available: false,
      recovery_class: null,
      restore_boundary: null,
      restore_guidance: null,
    });
  });
});
