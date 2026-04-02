import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IntegrationState } from "./index.js";

interface DraftDoc {
  draft_id: string;
  status: "active" | "archived";
  action_id: string;
}

let tempDir: string | null = null;
const TEST_TMP_ROOT = path.join(process.cwd(), ".dt");
let tempSequence = 0;

function makeTempDir(): string {
  fs.mkdirSync(TEST_TMP_ROOT, { recursive: true });
  tempSequence += 1;
  const root = path.join(TEST_TMP_ROOT, `integration-state-${tempSequence}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function createDraftState(dbPath: string): IntegrationState<{ drafts: DraftDoc }> {
  return new IntegrationState({
    dbPath,
    collections: {
      drafts: {
        parse(key, value) {
          if (value === null || typeof value !== "object") {
            throw new Error(`invalid draft ${key}`);
          }

          const record = value as Record<string, unknown>;
          if (
            typeof record.draft_id !== "string" ||
            (record.status !== "active" && record.status !== "archived") ||
            typeof record.action_id !== "string"
          ) {
            throw new Error(`invalid draft ${key}`);
          }

          return {
            draft_id: record.draft_id,
            status: record.status,
            action_id: record.action_id,
          };
        },
      },
    },
  });
}

afterEach(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("IntegrationState", () => {
  it("puts and gets a typed document", () => {
    tempDir = makeTempDir();
    const state = createDraftState(path.join(tempDir, "state.db"));

    const written = state.put("drafts", "draft_1", {
      draft_id: "draft_1",
      status: "active",
      action_id: "act_1",
    });

    expect(written.status).toBe("active");
    expect(state.get("drafts", "draft_1")).toEqual(written);
    state.close();
  });

  it("supports putIfAbsent for idempotent inserts", () => {
    tempDir = makeTempDir();
    const state = createDraftState(path.join(tempDir, "state.db"));

    expect(
      state.putIfAbsent("drafts", "draft_1", {
        draft_id: "draft_1",
        status: "active",
        action_id: "act_1",
      }),
    ).toBe(true);
    expect(
      state.putIfAbsent("drafts", "draft_1", {
        draft_id: "draft_1",
        status: "archived",
        action_id: "act_2",
      }),
    ).toBe(false);
    expect(state.get("drafts", "draft_1")?.status).toBe("active");
    state.close();
  });

  it("marks low-disk writes as retryable storage failures", () => {
    tempDir = makeTempDir();
    const state = createDraftState(path.join(tempDir, "state.db"));
    const db = state as unknown as {
      db: {
        prepare(sql: string): { run(...args: unknown[]): unknown };
      };
    };
    const prepareSpy = vi.spyOn(db.db, "prepare").mockImplementation((_sql: string) => {
      const statement = {
        run() {
          const error = new Error("database or disk is full") as Error & { code: string };
          error.code = "SQLITE_FULL";
          throw error;
        },
      };
      return statement;
    });

    try {
      state.put("drafts", "draft_1", {
        draft_id: "draft_1",
        status: "active",
        action_id: "act_1",
      });
      throw new Error("expected low-disk state write to throw");
    } catch (error) {
      expect(error).toMatchObject({
        code: "STORAGE_UNAVAILABLE",
        retryable: true,
        details: {
          low_disk_pressure: true,
          storage_error_code: "SQLITE_FULL",
        },
      });
    } finally {
      prepareSpy.mockRestore();
      state.close();
    }
  });

  it("lists documents with optional shallow filters", () => {
    tempDir = makeTempDir();
    const state = createDraftState(path.join(tempDir, "state.db"));

    state.put("drafts", "draft_1", {
      draft_id: "draft_1",
      status: "active",
      action_id: "act_1",
    });
    state.put("drafts", "draft_2", {
      draft_id: "draft_2",
      status: "archived",
      action_id: "act_2",
    });

    expect(state.list("drafts")).toHaveLength(2);
    expect(state.list("drafts", { status: "active" })).toEqual([
      {
        draft_id: "draft_1",
        status: "active",
        action_id: "act_1",
      },
    ]);
    state.close();
  });

  it("deletes documents by collection and key", () => {
    tempDir = makeTempDir();
    const state = createDraftState(path.join(tempDir, "state.db"));

    state.put("drafts", "draft_1", {
      draft_id: "draft_1",
      status: "active",
      action_id: "act_1",
    });

    expect(state.delete("drafts", "draft_1")).toBe(true);
    expect(state.delete("drafts", "draft_1")).toBe(false);
    expect(state.get("drafts", "draft_1")).toBeNull();
    state.close();
  });

  it("rejects invalid stored JSON as storage unavailable", () => {
    tempDir = makeTempDir();
    const dbPath = path.join(tempDir, "state.db");
    const state = createDraftState(dbPath);
    const rawDb = new Database(dbPath);

    rawDb
      .prepare("INSERT INTO documents (collection, key, body_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("drafts", "draft_1", "{broken-json", "2026-03-30T00:00:00.000Z", "2026-03-30T00:00:00.000Z");

    try {
      state.get("drafts", "draft_1");
      throw new Error("expected storage failure");
    } catch (error) {
      expect(error).toMatchObject({
        code: "STORAGE_UNAVAILABLE",
      });
    }

    rawDb.close();
    state.close();
  });

  it("rejects invalid stored document shapes as storage unavailable", () => {
    tempDir = makeTempDir();
    const dbPath = path.join(tempDir, "state.db");
    const state = createDraftState(dbPath);
    const rawDb = new Database(dbPath);

    rawDb
      .prepare("INSERT INTO documents (collection, key, body_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(
        "drafts",
        "draft_1",
        JSON.stringify({ draft_id: "draft_1", status: "active" }),
        "2026-03-30T00:00:00.000Z",
        "2026-03-30T00:00:00.000Z",
      );

    try {
      state.get("drafts", "draft_1");
      throw new Error("expected storage failure");
    } catch (error) {
      expect(error).toMatchObject({
        code: "STORAGE_UNAVAILABLE",
      });
    }

    rawDb.close();
    state.close();
  });
});
