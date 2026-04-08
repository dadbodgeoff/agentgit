import type { PreviewState } from "@/schemas/cloud";

export type CursorPaginationRequest = {
  cursor?: string | null;
  limit?: number;
  previewState?: PreviewState;
};

export function appendCursorPagination(url: URL, params: CursorPaginationRequest = {}) {
  if (params.previewState && params.previewState !== "ready") {
    url.searchParams.set("state", params.previewState);
  }

  if (params.cursor) {
    url.searchParams.set("cursor", params.cursor);
  }

  if (typeof params.limit === "number") {
    url.searchParams.set("limit", String(params.limit));
  }

  return url;
}
