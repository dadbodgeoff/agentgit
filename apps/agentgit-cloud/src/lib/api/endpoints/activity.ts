import { fetchJson } from "@/lib/api/client";
import { ActivityFeedResponseSchema, type ActivityFeedResponse } from "@/schemas/cloud";

export async function getWorkspaceActivity(): Promise<ActivityFeedResponse> {
  const response = await fetchJson<unknown>("/api/v1/activity");
  return ActivityFeedResponseSchema.parse(response);
}
