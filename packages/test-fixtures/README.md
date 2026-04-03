# @agentgit/test-fixtures

> **Internal package** — shared test utilities for the agentgit monorepo. Not published to npm.

Provides durable temp-directory fixtures and cleanup utilities for package tests that need real filesystem workspace layouts.

---

## What's In Here

### `TempWorkspace`
Creates a real temp directory that mimics an agentgit workspace, with automatic cleanup after each test.

```ts
import { TempWorkspace } from "@agentgit/test-fixtures";

describe("my adapter test", () => {
  let workspace: TempWorkspace;

  beforeEach(async () => {
    workspace = await TempWorkspace.create();
  });

  afterEach(async () => {
    await workspace.cleanup();
  });

  it("writes a file", async () => {
    const filePath = workspace.path("src/index.ts");
    // ... test using workspace.root as the workspace_root
  });
});
```

### `TempDb`
Creates a temporary SQLite database for journal/state tests, cleaned up after the test run.

```ts
import { TempDb } from "@agentgit/test-fixtures";

const db = await TempDb.create();
// db.path → "/tmp/agentgit-test-xyz/journal.db"
await db.cleanup();
```

---

## Used By

- `packages/execution-adapters` — filesystem and shell adapter tests
- `packages/snapshot-engine` — manifest capture and anchor tests
- `packages/run-journal` — journal write/query tests

---

## Adding Fixtures

Only add fixtures here if they are actively used by at least one package test. Keep this package minimal.
