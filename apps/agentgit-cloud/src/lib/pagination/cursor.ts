import { ZodError, z } from "zod";

import { CursorPaginationQuerySchema, type CursorPaginationQuery } from "@/schemas/cloud";

export type CursorPage<T> = {
  items: T[];
  total: number;
  page_size: number;
  next_cursor: string | null;
  has_more: boolean;
};

const CursorTokenSchema = z
  .object({
    offset: z.number().int().min(0),
  })
  .strict();

function encodeCursor(offset: number) {
  return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor?: string | null) {
  if (!cursor) {
    return 0;
  }

  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    return CursorTokenSchema.parse(parsed).offset;
  } catch {
    throw new Error("Cursor is invalid.");
  }
}

export function parseCursorPaginationQuery(request: Request, defaultLimit = 25): CursorPaginationQuery {
  const url = new URL(request.url);
  const raw = {
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: url.searchParams.get("limit") ?? defaultLimit,
  };

  return CursorPaginationQuerySchema.parse(raw);
}

export function paginateItems<T>(
  items: T[],
  params: { cursor?: string | null; limit: number } = { limit: 25 },
): CursorPage<T> {
  const offset = decodeCursor(params.cursor);
  const pageItems = items.slice(offset, offset + params.limit);
  const nextOffset = offset + pageItems.length;

  return {
    items: pageItems,
    total: items.length,
    page_size: params.limit,
    next_cursor: nextOffset < items.length ? encodeCursor(nextOffset) : null,
    has_more: nextOffset < items.length,
  };
}

export function isPaginationQueryError(error: unknown): boolean {
  return error instanceof ZodError || (error instanceof Error && error.message === "Cursor is invalid.");
}
