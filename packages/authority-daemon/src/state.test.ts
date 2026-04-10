import { describe, expect, it, vi } from "vitest";
import type { RunJournal, RunJournalRunRecord } from "@agentgit/run-journal";

import { AuthorityState } from "./state.js";
import { rehydrateState } from "./app/authority-service.js";

describe("AuthorityState", () => {
  it("creates sessions and runs", () => {
    const state = new AuthorityState();
    const session = state.createSession({
      client_type: "cli",
      client_version: "0.1.0",
      requested_api_version: "authority.v1",
      workspace_roots: ["/workspace/project"],
    });
    const run = state.createRun(session.session_id, {
      workflow_name: "workflow",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: ["/workspace/project"],
      client_metadata: {
        source: "test",
      },
      budget_config: {
        max_mutating_actions: 2,
        max_destructive_actions: 1,
      },
    });

    expect(state.getSession(session.session_id)).toEqual(session);
    expect(state.getRun(run.run_id)).toEqual(run);
    expect(state.getSessionCount()).toBe(1);
    expect(state.getRunCount()).toBe(1);
    expect(run.budget_config.max_mutating_actions).toBe(2);
  });

  it("rehydrates sessions and runs idempotently", () => {
    const state = new AuthorityState();
    const session = state.rehydrateSession("sess_rehydrated", ["/workspace/project"]);
    const run = state.rehydrateRun({
      run_id: "run_rehydrated",
      session_id: "sess_rehydrated",
      workflow_name: "workflow",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: ["/workspace/project"],
      event_count: 3,
      latest_event: {
        sequence: 3,
        event_type: "action.normalized",
        occurred_at: "2026-03-29T12:00:02.000Z",
        recorded_at: "2026-03-29T12:00:02.000Z",
      },
      budget_config: {
        max_mutating_actions: 5,
        max_destructive_actions: 2,
      },
      budget_usage: {
        mutating_actions: 1,
        destructive_actions: 0,
      },
      maintenance_status: {
        projection_status: "fresh",
        projection_lag_events: 0,
        degraded_artifact_capture_actions: 0,
        low_disk_pressure_signals: 0,
        artifact_health: {
          total: 0,
          available: 0,
          missing: 0,
          expired: 0,
          corrupted: 0,
          tampered: 0,
        },
      },
      created_at: "2026-03-29T12:00:00.000Z",
      started_at: "2026-03-29T12:00:00.000Z",
    });

    expect(session.client_type).toBe("rehydrated");
    expect(run.rehydrated).toBe(true);
    expect(state.rehydrateSession("sess_rehydrated", ["/workspace/project"])).toBe(session);
    expect(
      state.rehydrateRun({
        run_id: "run_rehydrated",
        session_id: "sess_rehydrated",
        workflow_name: "workflow",
        agent_framework: "cli",
        agent_name: "agentgit-cli",
        workspace_roots: ["/workspace/project"],
        event_count: 3,
        latest_event: null,
        budget_config: {
          max_mutating_actions: 5,
          max_destructive_actions: 2,
        },
        budget_usage: {
          mutating_actions: 1,
          destructive_actions: 0,
        },
        maintenance_status: {
          projection_status: "fresh",
          projection_lag_events: 0,
          degraded_artifact_capture_actions: 0,
          low_disk_pressure_signals: 0,
          artifact_health: {
            total: 0,
            available: 0,
            missing: 0,
            expired: 0,
            corrupted: 0,
            tampered: 0,
          },
        },
        created_at: "2026-03-29T12:00:00.000Z",
        started_at: "2026-03-29T12:00:00.000Z",
      }),
    ).toBe(run);
    expect(state.getSessionCount()).toBe(1);
    expect(state.getRunCount()).toBe(1);
  });

  it("rehydrates persisted runs without writing to stdout", () => {
    const state = new AuthorityState();
    const stdoutWriteSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const run: RunJournalRunRecord = {
      run_id: "run_from_journal",
      session_id: "sess_from_journal",
      workflow_name: "workflow",
      agent_framework: "cli",
      agent_name: "agentgit-cli",
      workspace_roots: ["/workspace/project"],
      event_count: 0,
      latest_event: null,
      budget_config: {},
      budget_usage: {
        mutating_actions: 0,
        destructive_actions: 0,
      },
      maintenance_status: {
        projection_status: "fresh",
        projection_lag_events: 0,
        degraded_artifact_capture_actions: 0,
        low_disk_pressure_signals: 0,
        artifact_health: {
          total: 0,
          available: 0,
          missing: 0,
          expired: 0,
          corrupted: 0,
          tampered: 0,
        },
      },
      created_at: "2026-03-29T12:00:00.000Z",
      started_at: "2026-03-29T12:00:00.000Z",
    };
    const journal = {
      listAllRuns: () => [run],
    } as Pick<RunJournal, "listAllRuns"> as RunJournal;

    try {
      rehydrateState(state, journal);
    } finally {
      stdoutWriteSpy.mockRestore();
    }

    expect(stdoutWriteSpy).not.toHaveBeenCalled();
    expect(state.getSessionCount()).toBe(1);
    expect(state.getRunCount()).toBe(1);
    expect(state.getRun("run_from_journal")?.rehydrated).toBe(true);
  });
});
