import "server-only";

import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "@/lib/db/schema";

let dbInstance: PostgresJsDatabase<typeof schema> | null = null;
let sqlInstance: postgres.Sql | null = null;

export function getDatabaseUrl(): string | null {
  const value = process.env.DATABASE_URL?.trim() ?? "";
  return value.length > 0 ? value : null;
}

export function hasDatabaseUrl(): boolean {
  return getDatabaseUrl() !== null;
}

export function getCloudDatabase(): PostgresJsDatabase<typeof schema> {
  if (dbInstance) {
    return dbInstance;
  }

  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be configured to use cloud database persistence.");
  }

  sqlInstance = postgres(databaseUrl, {
    max: 1,
    prepare: false,
  });
  dbInstance = drizzle(sqlInstance, { schema });
  return dbInstance;
}

export async function pingCloudDatabase(): Promise<void> {
  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured.");
  }

  const sql = sqlInstance ?? postgres(databaseUrl, { max: 1, prepare: false });
  try {
    await sql`select 1`;
  } finally {
    if (!sqlInstance) {
      await sql.end({ timeout: 1 });
    }
  }
}
