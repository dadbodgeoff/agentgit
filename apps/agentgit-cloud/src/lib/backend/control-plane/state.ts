import "server-only";

import fs from "node:fs";
import path from "node:path";

import { ControlPlaneStateStore } from "@agentgit/control-plane-state";

function getControlPlaneStateDbPath(): string {
  const root = process.env.AGENTGIT_ROOT ?? process.cwd();
  return path.join(root, ".agentgit", "state", "cloud", "control-plane.db");
}

export function ensureLocalControlPlaneStateInitialized(): void {
  const dbPath = getControlPlaneStateDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const store = new ControlPlaneStateStore(dbPath);
  store.close();
}

export function withControlPlaneState<T>(run: (store: ControlPlaneStateStore) => T): T {
  const dbPath = getControlPlaneStateDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const store = new ControlPlaneStateStore(dbPath);
  try {
    return run(store);
  } finally {
    store.close();
  }
}
