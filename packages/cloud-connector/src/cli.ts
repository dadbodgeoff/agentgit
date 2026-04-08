#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  CloudConnectorDaemon,
  CloudConnectorRuntime,
  CloudConnectorService,
  CloudConnectorStateStore,
  CloudSyncClient,
  type CloudConnectorDaemonEvent,
} from "./index.js";

function usage() {
  process.stdout.write(
    `${[
      "Usage: agentgit-cloud-connector <command> [options]",
      "",
      "Commands:",
      "  bootstrap --cloud-url <url> --workspace-id <id> --workspace-root <path> --bootstrap-token <token> [--state-db <path>] [--connector-name <name>]",
      "  run --workspace-root <path> [--state-db <path>] [--poll-interval-ms <ms>] [--heartbeat-interval-ms <ms>] [--backoff-initial-ms <ms>] [--backoff-max-ms <ms>]",
      "  sync-once --workspace-root <path> [--state-db <path>]",
    ].join("\n")}\n`,
  );
}

function parseFlags(argv: string[]) {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      flags.set(key, "true");
      continue;
    }

    flags.set(key, value);
    index += 1;
  }
  return flags;
}

function required(flags: Map<string, string>, key: string): string {
  const value = flags.get(key);
  if (!value) {
    throw new Error(`Missing required flag --${key}.`);
  }
  return value;
}

function defaultStateDb(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".agentgit", "state", "cloud", "connector.db");
}

function packageVersion(): string {
  const packageJsonPath = new URL("../package.json", import.meta.url);
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: string };
  return packageJson.version ?? "0.1.0";
}

function parseIntegerFlag(flags: Map<string, string>, key: string): number | undefined {
  const raw = flags.get(key);
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Flag --${key} must be a positive integer.`);
  }

  return parsed;
}

function formatDaemonEvent(event: CloudConnectorDaemonEvent) {
  switch (event.type) {
    case "started":
      return `[${event.occurredAt}] Cloud connector daemon started (poll=${event.pollIntervalMs}ms heartbeat=${event.heartbeatIntervalMs}ms backoff=${event.initialBackoffMs}-${event.maxBackoffMs}ms).`;
    case "iteration_succeeded":
      return `[${event.occurredAt}] Sync succeeded${event.heartbeatSent ? " with heartbeat" : ""}; next poll in ${event.nextDelayMs}ms.`;
    case "iteration_failed":
      return `[${event.occurredAt}] Sync failed (${event.error}); retry ${event.consecutiveFailures} in ${event.retryInMs}ms.`;
    case "stopped":
      return `[${event.occurredAt}] Cloud connector daemon stopped.`;
  }
}

function writeStdout(value: string) {
  process.stdout.write(`${value}\n`);
}

function openRegisteredConnector(flags: Map<string, string>) {
  const workspaceRoot = path.resolve(required(flags, "workspace-root"));
  const stateDb = path.resolve(flags.get("state-db") ?? defaultStateDb(workspaceRoot));
  if (!fs.existsSync(stateDb)) {
    throw new Error("Connector state database was not found. Run bootstrap first.");
  }

  const store = new CloudConnectorStateStore(stateDb);
  const existing = store.getRegistration();
  if (!existing) {
    store.close();
    throw new Error("Connector registration was not found in state. Run bootstrap first.");
  }

  const service = new CloudConnectorService(store, new CloudSyncClient(existing.cloudBaseUrl));
  const runtime = new CloudConnectorRuntime({
    stateStore: store,
    service,
    workspaceRoot,
    connectorVersion: packageVersion(),
  });

  return {
    workspaceRoot,
    stateDb,
    store,
    runtime,
  };
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }

  const flags = parseFlags(rest);

  switch (command) {
    case "bootstrap": {
      const workspaceRoot = path.resolve(required(flags, "workspace-root"));
      const stateDb = path.resolve(flags.get("state-db") ?? defaultStateDb(workspaceRoot));
      fs.mkdirSync(path.dirname(stateDb), { recursive: true });
      const store = new CloudConnectorStateStore(stateDb);
      const service = new CloudConnectorService(store, new CloudSyncClient(required(flags, "cloud-url")));
      const runtime = new CloudConnectorRuntime({
        stateStore: store,
        service,
        workspaceRoot,
        connectorVersion: packageVersion(),
      });

      try {
        const registration = await runtime.bootstrapRegister({
          cloudBaseUrl: required(flags, "cloud-url"),
          workspaceId: required(flags, "workspace-id"),
          bootstrapToken: required(flags, "bootstrap-token"),
          connectorName: flags.get("connector-name") ?? undefined,
          machineName: flags.get("machine-name") ?? undefined,
        });
        const sync = await runtime.syncOnce();
        writeStdout(
          JSON.stringify(
            {
              registration,
              sync,
              stateDb,
            },
            null,
            2,
          ),
        );
      } finally {
        store.close();
      }
      return;
    }
    case "run": {
      const { store, runtime } = openRegisteredConnector(flags);
      const abortController = new AbortController();
      const stop = () => abortController.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);

      const daemon = new CloudConnectorDaemon({
        runtime,
        pollIntervalMs: parseIntegerFlag(flags, "poll-interval-ms"),
        heartbeatIntervalMs: parseIntegerFlag(flags, "heartbeat-interval-ms"),
        initialBackoffMs: parseIntegerFlag(flags, "backoff-initial-ms"),
        maxBackoffMs: parseIntegerFlag(flags, "backoff-max-ms"),
        onEvent(event) {
          writeStdout(formatDaemonEvent(event));
        },
      });

      try {
        await daemon.run(abortController.signal);
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        store.close();
      }
      return;
    }
    case "sync-once": {
      const { store, runtime } = openRegisteredConnector(flags);

      try {
        const result = await runtime.syncOnce();
        writeStdout(JSON.stringify(result, null, 2));
      } finally {
        store.close();
      }
      return;
    }
    default:
      usage();
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
