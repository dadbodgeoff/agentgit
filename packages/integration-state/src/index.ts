import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { AgentGitError, InternalError } from "@agentgit/schemas";

type BetterSqliteDatabase = InstanceType<typeof Database>;
type SqliteJournalMode = "WAL" | "DELETE";

function storageErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const candidate = (error as { code?: unknown }).code;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function isLowDiskPressureError(error: unknown): boolean {
  const code = storageErrorCode(error);
  if (code === "ENOSPC" || code === "SQLITE_FULL") {
    return true;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("no space left on device") || message.includes("database or disk is full");
}

function storageUnavailableError(message: string, error: unknown, details?: Record<string, unknown>): AgentGitError {
  const lowDiskPressure = isLowDiskPressureError(error);
  return new AgentGitError(
    message,
    "STORAGE_UNAVAILABLE",
    {
      ...details,
      cause: error instanceof Error ? error.message : String(error),
      storage_error_code: storageErrorCode(error),
      low_disk_pressure: lowDiskPressure,
      retry_hint: lowDiskPressure ? "Free disk space, then retry." : undefined,
    },
    lowDiskPressure,
  );
}

function resolveSqliteJournalMode(): SqliteJournalMode {
  const configured = process.env.AGENTGIT_SQLITE_JOURNAL_MODE?.trim().toUpperCase();
  if (!configured) {
    return "WAL";
  }

  if (configured === "WAL" || configured === "DELETE") {
    return configured;
  }

  throw new InternalError("Unsupported SQLite journal mode.", {
    configured_mode: configured,
    supported_modes: ["WAL", "DELETE"],
  });
}

export interface IntegrationStateCollection<TDocument> {
  parse(key: string, value: unknown): TDocument;
}

export interface IntegrationStateOptions<TCollections extends Record<string, unknown>> {
  dbPath: string;
  collections: {
    [K in keyof TCollections & string]: IntegrationStateCollection<TCollections[K]>;
  };
}

type CollectionName<TCollections extends Record<string, unknown>> = keyof TCollections & string;

export interface SqliteCheckpointResult {
  journal_mode: SqliteJournalMode;
  checkpointed: boolean;
  busy: number;
  log_frames: number;
  checkpointed_frames: number;
}

export class IntegrationState<TCollections extends Record<string, unknown>> {
  private readonly db: BetterSqliteDatabase;
  private readonly collections: Map<string, IntegrationStateCollection<unknown>>;

  constructor(options: IntegrationStateOptions<TCollections>) {
    this.collections = new Map(Object.entries(options.collections));

    try {
      fs.mkdirSync(path.dirname(options.dbPath), { recursive: true });
      this.db = new Database(options.dbPath);
      this.db.pragma(`journal_mode = ${resolveSqliteJournalMode()}`);
      this.db.pragma("foreign_keys = ON");
      this.migrate();
    } catch (error) {
      throw new InternalError("Failed to initialize integration state.", {
        cause: error instanceof Error ? error.message : String(error),
        db_path: options.dbPath,
      });
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        collection TEXT NOT NULL,
        key TEXT NOT NULL,
        body_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (collection, key)
      );

      CREATE INDEX IF NOT EXISTS idx_documents_collection_updated
        ON documents (collection, updated_at);
    `);
  }

  private getCollection<K extends CollectionName<TCollections>>(
    collection: K,
  ): IntegrationStateCollection<TCollections[K]> {
    const registered = this.collections.get(collection) as IntegrationStateCollection<TCollections[K]> | undefined;
    if (!registered) {
      throw new InternalError("Integration state collection is not registered.", {
        collection,
      });
    }

    return registered;
  }

  private parseDocument<K extends CollectionName<TCollections>>(
    collection: K,
    key: string,
    value: unknown,
  ): TCollections[K] {
    try {
      return this.getCollection(collection).parse(key, value);
    } catch (error) {
      if (error instanceof AgentGitError) {
        throw error;
      }

      throw new AgentGitError("Integration state document failed schema validation.", "STORAGE_UNAVAILABLE", {
        collection,
        key,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private deserializeRow<K extends CollectionName<TCollections>>(
    collection: K,
    key: string,
    bodyJson: string,
  ): TCollections[K] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyJson);
    } catch (error) {
      throw new AgentGitError("Integration state document contains invalid JSON.", "STORAGE_UNAVAILABLE", {
        collection,
        key,
        cause: error instanceof Error ? error.message : String(error),
      });
    }

    return this.parseDocument(collection, key, parsed);
  }

  put<K extends CollectionName<TCollections>>(collection: K, key: string, document: TCollections[K]): TCollections[K] {
    const normalized = this.parseDocument(collection, key, document);
    const bodyJson = JSON.stringify(normalized);
    const now = new Date().toISOString();

    try {
      this.db
        .prepare(
          `INSERT INTO documents (collection, key, body_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(collection, key) DO UPDATE SET
             body_json = excluded.body_json,
             updated_at = excluded.updated_at`,
        )
        .run(collection, key, bodyJson, now, now);
    } catch (error) {
      throw storageUnavailableError("Integration state document could not be written.", error, {
        collection,
        key,
      });
    }

    return normalized;
  }

  putIfAbsent<K extends CollectionName<TCollections>>(collection: K, key: string, document: TCollections[K]): boolean {
    const normalized = this.parseDocument(collection, key, document);
    const bodyJson = JSON.stringify(normalized);
    const now = new Date().toISOString();

    try {
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO documents (collection, key, body_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(collection, key, bodyJson, now, now);
      return result.changes > 0;
    } catch (error) {
      throw storageUnavailableError("Integration state document could not be written.", error, {
        collection,
        key,
      });
    }
  }

  get<K extends CollectionName<TCollections>>(collection: K, key: string): TCollections[K] | null {
    let row: { body_json: string } | undefined;
    try {
      row = this.db.prepare("SELECT body_json FROM documents WHERE collection = ? AND key = ?").get(collection, key) as
        | { body_json: string }
        | undefined;
    } catch (error) {
      throw storageUnavailableError("Integration state document could not be read.", error, {
        collection,
        key,
      });
    }

    if (!row) {
      return null;
    }

    return this.deserializeRow(collection, key, row.body_json);
  }

  list<K extends CollectionName<TCollections>>(collection: K, filter?: Partial<TCollections[K]>): TCollections[K][] {
    let rows: Array<{ key: string; body_json: string }>;
    try {
      rows = this.db
        .prepare("SELECT key, body_json FROM documents WHERE collection = ? ORDER BY key ASC")
        .all(collection) as Array<{ key: string; body_json: string }>;
    } catch (error) {
      throw storageUnavailableError("Integration state documents could not be listed.", error, {
        collection,
      });
    }

    const documents = rows.map((row) => this.deserializeRow(collection, row.key, row.body_json));
    if (!filter) {
      return documents;
    }

    return documents.filter((document) =>
      Object.entries(filter).every(([filterKey, filterValue]) => {
        const candidate = document as Record<string, unknown>;
        return candidate[filterKey] === filterValue;
      }),
    );
  }

  delete<K extends CollectionName<TCollections>>(collection: K, key: string): boolean {
    try {
      const result = this.db.prepare("DELETE FROM documents WHERE collection = ? AND key = ?").run(collection, key);
      return result.changes > 0;
    } catch (error) {
      throw storageUnavailableError("Integration state document could not be deleted.", error, {
        collection,
        key,
      });
    }
  }

  checkpointWal(): SqliteCheckpointResult {
    try {
      const modeRow = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
      const journalMode = (modeRow?.journal_mode?.toUpperCase() ?? resolveSqliteJournalMode()) as SqliteJournalMode;

      if (journalMode !== "WAL") {
        return {
          journal_mode: journalMode,
          checkpointed: false,
          busy: 0,
          log_frames: 0,
          checkpointed_frames: 0,
        };
      }

      const row = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
        | { busy?: number; log?: number; checkpointed?: number }
        | undefined;

      return {
        journal_mode: "WAL",
        checkpointed: true,
        busy: row?.busy ?? 0,
        log_frames: row?.log ?? 0,
        checkpointed_frames: row?.checkpointed ?? 0,
      };
    } catch (error) {
      throw storageUnavailableError("Integration state WAL checkpoint failed.", error);
    }
  }

  close(): void {
    this.db.close();
  }
}
