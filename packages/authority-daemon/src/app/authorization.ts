import fs from "node:fs";
import path from "node:path";

import type { RunJournal } from "@agentgit/run-journal";
import { NotFoundError, PreconditionError } from "@agentgit/schemas";

import type { AuthorityState } from "../state.js";

type RunSummaryRecord = NonNullable<ReturnType<RunJournal["getRunSummary"]>>;

export function requireValidSession(state: AuthorityState, method: string, sessionId: string | undefined): string {
  const session = state.getSession(sessionId);
  if (!session) {
    throw new PreconditionError(`A valid session_id is required before ${method}.`, {
      session_id: sessionId,
    });
  }

  return session.session_id;
}

export function canonicalizeWorkspaceRootForAuthorization(rootPath: string): string {
  try {
    return fs.realpathSync(rootPath);
  } catch {
    return path.resolve(rootPath);
  }
}

export function sessionCanAccessRun(
  state: AuthorityState,
  sessionId: string,
  runSummary: { workspace_roots: string[] },
): boolean {
  const session = state.getSession(sessionId);
  if (!session) {
    return false;
  }

  const sessionRoots = new Set(session.workspace_roots.map((root) => canonicalizeWorkspaceRootForAuthorization(root)));
  return runSummary.workspace_roots
    .map((root) => canonicalizeWorkspaceRootForAuthorization(root))
    .some((root) => sessionRoots.has(root));
}

export function requireAuthorizedRunSummary(
  state: AuthorityState,
  journal: RunJournal,
  sessionId: string,
  runId: string,
  referenceField = "run_id",
): RunSummaryRecord {
  const runSummary = journal.getRunSummary(runId);

  if (!runSummary || !sessionCanAccessRun(state, sessionId, runSummary)) {
    throw new NotFoundError(`No run found for ${runId}.`, {
      [referenceField]: runId,
    });
  }

  return runSummary;
}
