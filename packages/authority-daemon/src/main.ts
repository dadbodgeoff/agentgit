import fs from "node:fs";
import path from "node:path";

import { startServer } from "./server.js";

const projectRoot = process.env.AGENTGIT_ROOT ?? process.env.INIT_CWD ?? process.cwd();
const socketPath = process.env.AGENTGIT_SOCKET_PATH ?? path.resolve(projectRoot, ".agentgit", "authority.sock");
const journalPath = process.env.AGENTGIT_JOURNAL_PATH ?? path.resolve(projectRoot, ".agentgit", "state", "authority.db");
const snapshotRootPath =
  process.env.AGENTGIT_SNAPSHOT_ROOT ?? path.resolve(projectRoot, ".agentgit", "state", "snapshots");
const artifactRetentionMs =
  process.env.AGENTGIT_ARTIFACT_RETENTION_MS === undefined
    ? null
    : Number.parseInt(process.env.AGENTGIT_ARTIFACT_RETENTION_MS, 10);

if (process.env.AGENTGIT_ARTIFACT_RETENTION_MS !== undefined && Number.isNaN(artifactRetentionMs)) {
  throw new Error("AGENTGIT_ARTIFACT_RETENTION_MS must be an integer number of milliseconds when provided.");
}

const server = await startServer({ socketPath, journalPath, snapshotRootPath, artifactRetentionMs });

console.log(
  JSON.stringify({
    status: "listening",
    socket_path: socketPath,
    journal_path: journalPath,
    snapshot_root_path: snapshotRootPath,
    artifact_retention_ms: artifactRetentionMs,
  }),
);

const shutdown = () => {
  server.close(() => {
    if (fs.existsSync(socketPath)) {
      fs.rmSync(socketPath, { force: true });
    }
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
