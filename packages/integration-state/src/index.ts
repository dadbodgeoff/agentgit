import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { AgentGitError, InternalError } from "@agentgit/schemas";

const require = createRequire(import.meta.url);
type BetterSqlite3Constructor = typeof import("better-sqlite3") extends { default: infer T } ? T : never;
const Database = require("better-sqlite3") as BetterSqlite3Constructor;

type BetterSqliteDatabase = InstanceType<BetterSqlite3Constructor>;
type SqliteJournalMode = "WAL" | "DELETE";

function isSqliteBusyError(error: unknown): boolean {
  const code = storageErrorCode(error);
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return true;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes("database is locked") || message.includes("database table is locked");
}

function resolveSqliteBusyTimeoutMs(): number {
  const configured = process.env.AGENTGIT_SQLITE_BUSY_TIMEOUT_MS?.trim();
  if (!configured) {
    return 5_000;
  }

  const parsed = Number.parseInt(configured, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new InternalError("Unsupported SQLite busy timeout.", {
      configured_timeout_ms: configured,
    });
  }

  return parsed;
}

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
  const busy = isSqliteBusyError(error);
  return new AgentGitError(
    message,
    "STORAGE_UNAVAILABLE",
    {
      ...details,
      cause: error instanceof Error ? error.message : String(error),
      storage_error_code: storageErrorCode(error),
      sqlite_busy: busy,
      low_disk_pressure: lowDiskPressure,
      retry_hint: lowDiskPressure
        ? "Free disk space, then retry."
        : busy
          ? "The SQLite database is busy. Retry once the concurrent writer finishes."
          : undefined,
    },
    lowDiskPressure || busy,
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

function loadOrCreateIntegrityKey(keyPath: string): Buffer {
  try {
    const existing = fs.readFileSync(keyPath, "utf8").trim();
    const decoded = Buffer.from(existing, "base64");
    if (decoded.length !== 32) {
      throw new InternalError("Integration state integrity key is malformed.", {
        key_path: keyPath,
      });
    }
    return decoded;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : null;
    if (code && code !== "ENOENT") {
      throw error;
    }
  }

  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  const created = randomBytes(32);
  const tempPath = `${keyPath}.${process.pid}.${Date.now()}.tmp`;
  const handle = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(handle, created.toString("base64"), "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(tempPath, keyPath);
  fs.chmodSync(keyPath, 0o600);
  return created;
}

export interface IntegrationStateCollection<TDocument> {
  parse(key: string, value: unknown): TDocument;
}

export interface IntegrationStateOptions<TCollections extends Record<string, unknown>> {
  dbPath: string;
  integrityKeyPath?: string;
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
  private readonly integrityKey: Buffer;

  constructor(options: IntegrationStateOptions<TCollections>) {
    this.collections = new Map(Object.entries(options.collections));

    try {
      fs.mkdirSync(path.dirname(options.dbPath), { recursive: true, mode: 0o700 });
      this.integrityKey = loadOrCreateIntegrityKey(
        options.integrityKeyPath ?? path.join(path.dirname(options.dbPath), ".state-integrity.key"),
      );
      this.db = new Database(options.dbPath);
      this.db.pragma(`journal_mode = ${resolveSqliteJournalMode()}`);
      this.db.pragma(`busy_timeout = ${resolveSqliteBusyTimeoutMs()}`);
      this.db.pragma("foreign_keys = ON");
      this.migrate();
      this.backfillDocumentIntegrity();
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
        body_hmac TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (collection, key)
      );

      CREATE INDEX IF NOT EXISTS idx_documents_collection_updated
        ON documents (collection, updated_at);
    `);
    const columns = this.db.prepare("PRAGMA table_info(documents)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "body_hmac")) {
      this.db.exec("ALTER TABLE documents ADD COLUMN body_hmac TEXT NOT NULL DEFAULT ''");
    }
  }

  private computeDocumentHmac(collection: string, key: string, bodyJson: string): string {
    return createHmac("sha256", this.integrityKey).update(collection, "utf8").update("\0", "utf8").update(key, "utf8").update("\0", "utf8").update(bodyJson, "utf8").digest("hex");
  }

  private verifyDocumentIntegrity(collection: string, key: string, bodyJson: string, bodyHmac: string): void {
    const expected = this.computeDocumentHmac(collection, key, bodyJson);
    if (bodyHmac !== expected) {
      throw new AgentGitError("Integration state document failed integrity verification.", "STORAGE_UNAVAILABLE", {
        collection,
        key,
      });
    }
  }

  private backfillDocumentIntegrity(): void {
    try {
      const rows = this.db
        .prepare("SELECT collection, key, body_json FROM documents WHERE body_hmac = '' OR body_hmac IS NULL")
        .all() as Array<{ collection: string; key: string; body_json: string }>;
      if (rows.length === 0) {
        return;
      }

      const update = this.db.prepare("UPDATE documents SET body_hmac = ? WHERE collection = ? AND key = ?");
      this.withImmediateTransaction(() => {
        for (const row of rows) {
          update.run(this.computeDocumentHmac(row.collection, row.key, row.body_json), row.collection, row.key);
        }
      });
    } catch (error) {
      throw storageUnavailableError("Integration state integrity backfill failed.", error);
    }
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
    bodyHmac: string,
  ): TCollections[K] {
    this.verifyDocumentIntegrity(collection, key, bodyJson, bodyHmac);
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
    const bodyHmac = this.computeDocumentHmac(collection, key, bodyJson);
    const now = new Date().toISOString();

    try {
      this.db
        .prepare(
          `INSERT INTO documents (collection, key, body_json, body_hmac, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(collection, key) DO UPDATE SET
             body_json = excluded.body_json,
             body_hmac = excluded.body_hmac,
             updated_at = excluded.updated_at`,
        )
        .run(collection, key, bodyJson, bodyHmac, now, now);
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
    const bodyHmac = this.computeDocumentHmac(collection, key, bodyJson);
    const now = new Date().toISOString();

    try {
      const result = this.db
        .prepare(
          `INSERT OR IGNORE INTO documents (collection, key, body_json, body_hmac, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(collection, key, bodyJson, bodyHmac, now, now);
      return result.changes > 0;
    } catch (error) {
      throw storageUnavailableError("Integration state document could not be written.", error, {
        collection,
        key,
      });
    }
  }

  get<K extends CollectionName<TCollections>>(collection: K, key: string): TCollections[K] | null {
    let row: { body_json: string; body_hmac: string } | undefined;
    try {
      row = this.db
        .prepare("SELECT body_json, body_hmac FROM documents WHERE collection = ? AND key = ?")
        .get(collection, key) as
        | { body_json: string; body_hmac: string }
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

    return this.deserializeRow(collection, key, row.body_json, row.body_hmac);
  }

  list<K extends CollectionName<TCollections>>(collection: K, filter?: Partial<TCollections[K]>): TCollections[K][] {
    let rows: Array<{ key: string; body_json: string; body_hmac: string }>;
    try {
      rows = this.db
        .prepare("SELECT key, body_json, body_hmac FROM documents WHERE collection = ? ORDER BY key ASC")
        .all(collection) as Array<{ key: string; body_json: string; body_hmac: string }>;
    } catch (error) {
      throw storageUnavailableError("Integration state documents could not be listed.", error, {
        collection,
      });
    }

    const documents = rows.map((row) => this.deserializeRow(collection, row.key, row.body_json, row.body_hmac));
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
      if (result.changes > 0) {
        this.checkpointWal();
      }
      return result.changes > 0;
    } catch (error) {
      throw storageUnavailableError("Integration state document could not be deleted.", error, {
        collection,
        key,
      });
    }
  }

  withImmediateTransaction<T>(run: () => T): T {
    try {
      this.db.prepare("BEGIN IMMEDIATE").run();
    } catch (error) {
      throw storageUnavailableError("Integration state transaction failed.", error);
    }

    try {
      const result = run();
      this.db.prepare("COMMIT").run();
      return result;
    } catch (error) {
      try {
        this.db.prepare("ROLLBACK").run();
      } catch (rollbackError) {
        throw storageUnavailableError("Integration state transaction rollback failed.", rollbackError);
      }
      throw error;
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
