import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { AuthorityClient } from "@agentgit/authority-sdk";

const host = process.env.AGENTGIT_PLAYWRIGHT_HOST ?? "localhost";
const port = process.env.AGENTGIT_PLAYWRIGHT_PORT ?? "3112";
const appRoot = process.env.AGENTGIT_ROOT;
const authorityRoot = process.env.AGENTGIT_AUTHORITY_ROOT;
const socketPath = process.env.AGENTGIT_SOCKET_PATH;

if (!appRoot || !authorityRoot || !socketPath) {
  throw new Error("AGENTGIT_ROOT, AGENTGIT_AUTHORITY_ROOT, and AGENTGIT_SOCKET_PATH are required.");
}

fs.rmSync(appRoot, { recursive: true, force: true });
fs.mkdirSync(appRoot, { recursive: true });
fs.rmSync(socketPath, { force: true });
fs.mkdirSync(path.dirname(socketPath), { recursive: true });

const daemon = spawn("pnpm", ["--filter", "@agentgit/authority-daemon", "start"], {
  cwd: path.resolve(process.cwd(), "../.."),
  env: {
    ...process.env,
    AGENTGIT_ROOT: authorityRoot,
    AGENTGIT_SOCKET_PATH: socketPath,
    AGENTGIT_CLOUD_WORKSPACE_ROOTS: authorityRoot,
    AGENTGIT_CLOUD_LOG_LEVEL: process.env.AGENTGIT_CLOUD_LOG_LEVEL ?? "error",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

const daemonLog = fs.createWriteStream("/tmp/agentgit-authority-daemon.log", { flags: "w" });
daemon.stdout.pipe(daemonLog);
daemon.stderr.pipe(daemonLog);

let nextProcess = null;
let shuttingDown = false;
let nextStarted = false;

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  nextProcess?.kill(signal);
  daemon.kill(signal);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

daemon.on("exit", (code, signal) => {
  if (shuttingDown) {
    return;
  }
  console.error(
    `authority daemon exited ${nextStarted ? "while Playwright server was running" : "before Next.js startup completed"}: code=${
      code ?? "null"
    } signal=${signal ?? "null"}`,
  );
  process.exit(code ?? 1);
});

const authorityClient = new AuthorityClient({
  clientType: "ui",
  clientVersion: "0.1.0",
  defaultWorkspaceRoots: [authorityRoot],
  socketPath,
});

let authorityReady = false;
for (let attempt = 0; attempt < 150; attempt += 1) {
  if (fs.existsSync(socketPath)) {
    try {
      await authorityClient.hello([authorityRoot]);
      authorityReady = true;
      break;
    } catch {
      // The socket can appear before the daemon is ready to answer requests.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

if (!authorityReady) {
  shutdown("SIGTERM");
  throw new Error(`Authority daemon did not answer hello at ${socketPath}.`);
}

nextStarted = true;
nextProcess = spawn("pnpm", ["exec", "next", "start", "--hostname", host, "--port", port], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

nextProcess.on("exit", (code, signal) => {
  shutdown(signal ?? "SIGTERM");
  process.exit(code ?? (signal ? 1 : 0));
});
