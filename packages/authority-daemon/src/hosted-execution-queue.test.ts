import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { HostedMcpExecutionJobRecord } from "@agentgit/schemas";
import { McpServerRegistry } from "@agentgit/mcp-registry";

import { HostedExecutionQueue } from "./hosted-execution-queue.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

function createRegistry(): McpServerRegistry {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentgit-hosted-queue-"));
  tempRoots.push(tempRoot);
  return new McpServerRegistry({
    dbPath: path.join(tempRoot, "mcp-registry.db"),
  });
}

function makeJob(jobId: string): HostedMcpExecutionJobRecord {
  const now = new Date().toISOString();
  return {
    job_id: jobId,
    run_id: "run_test",
    action_id: "act_test",
    server_profile_id: "profile_test",
    tool_name: "test_tool",
    server_display_name: "Test Server",
    canonical_endpoint: "https://example.test/mcp",
    network_scope: "public_https",
    allowed_hosts: ["example.test"],
    auth_context_ref: "ctx_test",
    arguments: {
      note: "test",
    },
    status: "queued",
    attempt_count: 0,
    max_attempts: 1,
    current_lease_id: null,
    claimed_by: null,
    claimed_at: null,
    last_heartbeat_at: null,
    cancel_requested_at: null,
    cancel_requested_by_session_id: null,
    cancel_reason: null,
    canceled_at: null,
    next_attempt_at: now,
    created_at: now,
    updated_at: now,
    completed_at: null,
    last_error: null,
    execution_result: null,
  };
}

describe("HostedExecutionQueue", () => {
  it("rejects submitAndWait callers when the queue closes before terminal state", async () => {
    const registry = createRegistry();
    const queue = new HostedExecutionQueue({
      registry,
      instanceId: "queue_test_instance",
      heartbeatIntervalMs: 5,
      processor: async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const completedAt = new Date().toISOString();
        return {
          execution_id: "exec_test",
          action_id: "act_test",
          mode: "executed",
          success: true,
          output: {},
          artifacts: [],
          started_at: completedAt,
          completed_at: completedAt,
        };
      },
    });

    try {
      const pending = queue.submitAndWait(makeJob("job_close_early"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      queue.close();

      await expect(pending).rejects.toMatchObject({
        code: "CAPABILITY_UNAVAILABLE",
        retryable: true,
      });
    } finally {
      queue.close();
      await new Promise((resolve) => setTimeout(resolve, 250));
      registry.close();
    }
  });
});
