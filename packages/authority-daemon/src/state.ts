import type {
  ClientType,
  HelloRequestPayload,
  RegisterRunRequestPayload,
  RunSummary,
  RunHandle,
} from "@agentgit/schemas";

import { createPrefixedId } from "./ids.js";

export interface SessionRecord {
  session_id: string;
  client_type: ClientType | "rehydrated";
  client_version: string;
  workspace_roots: string[];
  created_at: string;
}

export interface RunRecord {
  run_id: string;
  session_id: string;
  workflow_name: string;
  agent_framework: string;
  agent_name: string;
  workspace_roots: string[];
  client_metadata: Record<string, unknown>;
  budget_config: {
    max_mutating_actions: number | null;
    max_destructive_actions: number | null;
  };
  created_at: string;
  rehydrated?: boolean;
}

export class AuthorityState {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly runs = new Map<string, RunRecord>();

  createSession(payload: HelloRequestPayload): SessionRecord {
    const session: SessionRecord = {
      session_id: createPrefixedId("sess_"),
      client_type: payload.client_type,
      client_version: payload.client_version,
      workspace_roots: payload.workspace_roots ?? [],
      created_at: new Date().toISOString(),
    };

    this.sessions.set(session.session_id, session);
    return session;
  }

  rehydrateSession(sessionId: string, workspaceRoots: string[]): SessionRecord {
    const existingSession = this.sessions.get(sessionId);
    if (existingSession) {
      return existingSession;
    }

    const session: SessionRecord = {
      session_id: sessionId,
      client_type: "rehydrated",
      client_version: "0.0.0",
      workspace_roots: workspaceRoots,
      created_at: new Date().toISOString(),
    };

    this.sessions.set(session.session_id, session);
    return session;
  }

  getSession(sessionId: string | undefined): SessionRecord | null {
    if (!sessionId) {
      return null;
    }

    return this.sessions.get(sessionId) ?? null;
  }

  createRun(sessionId: string, payload: RegisterRunRequestPayload): RunRecord {
    const run: RunRecord = {
      run_id: createPrefixedId("run_"),
      session_id: sessionId,
      workflow_name: payload.workflow_name,
      agent_framework: payload.agent_framework,
      agent_name: payload.agent_name,
      workspace_roots: payload.workspace_roots,
      client_metadata: payload.client_metadata ?? {},
      budget_config: {
        max_mutating_actions: payload.budget_config?.max_mutating_actions ?? null,
        max_destructive_actions: payload.budget_config?.max_destructive_actions ?? null,
      },
      created_at: new Date().toISOString(),
    };
    this.runs.set(run.run_id, run);
    return run;
  }

  rehydrateRun(run: RunSummary): RunRecord {
    const existingRun = this.runs.get(run.run_id);
    if (existingRun) {
      return existingRun;
    }

    const rehydratedRun: RunRecord = {
      run_id: run.run_id,
      session_id: run.session_id,
      workflow_name: run.workflow_name,
      agent_framework: run.agent_framework,
      agent_name: run.agent_name,
      workspace_roots: run.workspace_roots,
      client_metadata: {},
      budget_config: run.budget_config,
      created_at: run.created_at,
      rehydrated: true,
    };

    this.runs.set(rehydratedRun.run_id, rehydratedRun);
    return rehydratedRun;
  }

  getRun(runId: string | undefined): RunRecord | null {
    if (!runId) {
      return null;
    }

    return this.runs.get(runId) ?? null;
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  getRunCount(): number {
    return this.runs.size;
  }

  toRunHandle(run: RunRecord): RunHandle {
    return {
      run_id: run.run_id,
      session_id: run.session_id,
      workflow_name: run.workflow_name,
    };
  }
}
