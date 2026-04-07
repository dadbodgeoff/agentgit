#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { CloudConnectorRuntime, CloudConnectorService, CloudConnectorStateStore, CloudSyncClient } from "./index.js";

function usage() {
  console.log(
    [
      "Usage: agentgit-cloud-connector <command> [options]",
      "",
      "Commands:",
      "  bootstrap --cloud-url <url> --workspace-id <id> --workspace-root <path> --bootstrap-token <token> [--state-db <path>] [--connector-name <name>]",
      "  sync-once --workspace-root <path> [--state-db <path>]",
    ].join("\n"),
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
        console.log(
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
    case "sync-once": {
      const workspaceRoot = path.resolve(required(flags, "workspace-root"));
      const stateDb = path.resolve(flags.get("state-db") ?? defaultStateDb(workspaceRoot));
      const registration = fs.existsSync(stateDb);
      if (!registration) {
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

      try {
        const result = await runtime.syncOnce();
        console.log(JSON.stringify(result, null, 2));
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
