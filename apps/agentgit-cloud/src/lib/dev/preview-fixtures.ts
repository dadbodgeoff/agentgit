import "server-only";

import type {
  ApprovalListResponse,
  CalibrationReport,
  DashboardSummary,
  OnboardingBootstrap,
  PreviewState,
  RepositoryListResponse,
  RunDetail,
} from "@/schemas/cloud";
import { PreviewStateSchema } from "@/schemas/cloud";

const API_FIXTURE_PREVIEW_ENABLED =
  process.env.NODE_ENV !== "production" && process.env.AGENTGIT_ENABLE_API_FIXTURES !== "false";

type PreviewFixtureMap = {
  approvals: ApprovalListResponse;
  calibration: CalibrationReport;
  dashboard: DashboardSummary;
  onboarding: OnboardingBootstrap;
  repositories: RepositoryListResponse;
  runDetail: RunDetail;
};

export function isApiFixturePreviewEnabled(): boolean {
  return API_FIXTURE_PREVIEW_ENABLED;
}

export function resolvePreviewState(request: Request): PreviewState {
  if (!API_FIXTURE_PREVIEW_ENABLED) {
    return "ready";
  }

  const url = new URL(request.url);
  const parsed = PreviewStateSchema.safeParse(url.searchParams.get("state") ?? "ready");
  return parsed.success ? parsed.data : "ready";
}

export async function loadPreviewFixture(
  kind: "approvals",
  previewState: PreviewState,
): Promise<PreviewFixtureMap["approvals"] | null>;
export async function loadPreviewFixture(
  kind: "calibration",
  previewState: PreviewState,
): Promise<PreviewFixtureMap["calibration"] | null>;
export async function loadPreviewFixture(
  kind: "dashboard",
  previewState: PreviewState,
): Promise<PreviewFixtureMap["dashboard"] | null>;
export async function loadPreviewFixture(
  kind: "onboarding",
  previewState: PreviewState,
): Promise<PreviewFixtureMap["onboarding"] | null>;
export async function loadPreviewFixture(
  kind: "repositories",
  previewState: PreviewState,
): Promise<PreviewFixtureMap["repositories"] | null>;
export async function loadPreviewFixture(
  kind: "runDetail",
  previewState: PreviewState,
  runId: string,
): Promise<PreviewFixtureMap["runDetail"] | null>;
export async function loadPreviewFixture(
  kind: keyof PreviewFixtureMap,
  previewState: PreviewState,
  runId?: string,
): Promise<PreviewFixtureMap[keyof PreviewFixtureMap] | null> {
  if (!API_FIXTURE_PREVIEW_ENABLED || previewState === "ready") {
    return null;
  }

  switch (kind) {
    case "approvals": {
      const { getApprovalsFixture } = await import("@/mocks/fixtures/approvals");
      return getApprovalsFixture(previewState);
    }
    case "calibration": {
      const { getCalibrationFixture } = await import("@/mocks/fixtures/calibration");
      return getCalibrationFixture(previewState);
    }
    case "dashboard": {
      const { getDashboardFixture } = await import("@/mocks/fixtures/dashboard");
      return getDashboardFixture(previewState);
    }
    case "onboarding": {
      const { getOnboardingBootstrapFixture } = await import("@/mocks/fixtures/onboarding");
      return getOnboardingBootstrapFixture(previewState);
    }
    case "repositories": {
      const { getRepositoriesFixture } = await import("@/mocks/fixtures/repositories");
      return getRepositoriesFixture(previewState);
    }
    case "runDetail": {
      const { getRunFixture } = await import("@/mocks/fixtures/runs");
      return getRunFixture(runId ?? "run_preview", previewState);
    }
    default:
      return null;
  }
}
