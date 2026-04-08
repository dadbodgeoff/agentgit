import { fetchJson } from "@/lib/api/client";
import { appendCursorPagination, type CursorPaginationRequest } from "@/lib/api/endpoints/pagination";
import { ActivityFeedResponseSchema, type ActivityFeedResponse } from "@/schemas/cloud";

export async function getWorkspaceActivity(params: CursorPaginationRequest = {}): Promise<ActivityFeedResponse> {
  const url = appendCursorPagination(new URL("/api/v1/activity", "http://localhost"), params);
  const response = await fetchJson<unknown>(url.pathname + url.search);
  return ActivityFeedResponseSchema.parse(response);
}
