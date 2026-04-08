import { fetchJson } from "@/lib/api/client";
import {
  ActionDetailSchema,
  RunDetailSchema,
  type ActionDetail,
  type PreviewState,
  type RunDetail,
} from "@/schemas/cloud";

export async function getRunDetail(runId: string, previewState: PreviewState = "ready"): Promise<RunDetail> {
  const url = new URL(`/api/v1/runs/${runId}`, "http://localhost");
  if (previewState !== "ready") {
    url.searchParams.set("state", previewState);
  }

  const response = await fetchJson<unknown>(url.pathname + url.search);
  return RunDetailSchema.parse(response);
}

export async function getActionDetail(
  owner: string,
  name: string,
  runId: string,
  actionId: string,
): Promise<ActionDetail> {
  const url = new URL(`/api/v1/runs/${runId}/actions/${actionId}`, "http://localhost");
  url.searchParams.set("owner", owner);
  url.searchParams.set("name", name);

  const response = await fetchJson<unknown>(url.pathname + url.search);
  return ActionDetailSchema.parse(response);
}
