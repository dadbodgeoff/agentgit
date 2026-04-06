#!/usr/bin/env node
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const controlRoot = path.join(os.tmpdir(), "agentgit-live-mvp-control");
const latestSessionPath = path.join(controlRoot, "latest.json");

function usage() {
  return [
    "Usage: node scripts/live-mvp-stop.mjs [options]",
    "",
    "Options:",
    "  --session <path>   Stop a specific session.json file instead of the latest session",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    sessionPath: latestSessionPath,
  };

  const rest = [...argv];
  while (rest.length > 0) {
    const current = rest.shift();
    switch (current) {
      case "--session":
        options.sessionPath = path.resolve(shiftValue(rest, "--session"));
        break;
      case "--help":
      case "-h":
        process.stdout.write(`${usage()}\n`);
        process.exit(0);
        return options;
      default:
        throw new Error(`Unknown argument: ${current}`);
    }
  }

  return options;
}

function shiftValue(args, flag) {
  const value = args.shift();
  if (!value) {
    throw new Error(`${flag} expects a value.`);
  }
  return value;
}

function stopPid(pid) {
  if (!pid || !Number.isInteger(pid)) {
    return { pid, stopped: false, reason: "missing" };
  }
  try {
    process.kill(pid, "SIGTERM");
    return { pid, stopped: true };
  } catch (error) {
    return {
      pid,
      stopped: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const raw = await fsp.readFile(options.sessionPath, "utf8");
  const session = JSON.parse(raw);

  const result = {
    session_path: options.sessionPath,
    daemon: stopPid(session.daemon_pid),
    inspector: stopPid(session.inspector_pid),
  };

  if (path.resolve(options.sessionPath) === path.resolve(latestSessionPath)) {
    try {
      await fsp.rm(latestSessionPath, { force: true });
    } catch {
      return;
    }
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

await main();
