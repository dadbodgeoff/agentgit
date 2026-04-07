import { NextResponse } from "next/server";

import { getCalibrationFixture } from "@/mocks/fixtures";
import { PreviewStateSchema } from "@/schemas/cloud";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url);
  const parsed = PreviewStateSchema.safeParse(url.searchParams.get("state") ?? "ready");
  const previewState = parsed.success ? parsed.data : "ready";

  if (previewState === "loading") {
    await sleep(1200);
  }

  if (previewState === "error") {
    return NextResponse.json({ message: "Could not load calibration data. Retry." }, { status: 500 });
  }

  return NextResponse.json(getCalibrationFixture(previewState));
}
