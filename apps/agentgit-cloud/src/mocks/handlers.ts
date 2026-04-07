import { http, HttpResponse } from "msw";

import { getApprovalsFixture, getCalibrationFixture, getDashboardFixture, getRepositoriesFixture, getRunFixture } from "@/mocks/fixtures";
import { PreviewStateSchema } from "@/schemas/cloud";

function resolvePreviewState(request: Request) {
  const url = new URL(request.url);
  const parsed = PreviewStateSchema.safeParse(url.searchParams.get("state") ?? "ready");
  return parsed.success ? parsed.data : "ready";
}

function maybeError(previewState: string) {
  if (previewState === "error") {
    return HttpResponse.json({ message: "Mocked error state" }, { status: 500 });
  }
  return null;
}

export const cloudHandlers = [
  http.get("/api/v1/dashboard", ({ request }) => {
    const previewState = resolvePreviewState(request);
    return maybeError(previewState) ?? HttpResponse.json(getDashboardFixture(previewState));
  }),
  http.get("/api/v1/approvals", ({ request }) => {
    const previewState = resolvePreviewState(request);
    return maybeError(previewState) ?? HttpResponse.json(getApprovalsFixture(previewState));
  }),
  http.get("/api/v1/repos", ({ request }) => {
    const previewState = resolvePreviewState(request);
    return maybeError(previewState) ?? HttpResponse.json(getRepositoriesFixture(previewState));
  }),
  http.get("/api/v1/runs/:runId", ({ params, request }) => {
    const previewState = resolvePreviewState(request);
    return maybeError(previewState) ?? HttpResponse.json(getRunFixture(String(params.runId), previewState));
  }),
  http.get("/api/v1/repos/:repoId/calibration", ({ request }) => {
    const previewState = resolvePreviewState(request);
    return maybeError(previewState) ?? HttpResponse.json(getCalibrationFixture(previewState));
  }),
];
