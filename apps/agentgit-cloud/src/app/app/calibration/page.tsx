import { parsePreviewStateValue } from "@/lib/navigation/search-params";
import { CalibrationPage } from "@/features/calibration/calibration-page";

export default async function CalibrationRoute({
  searchParams,
}: {
  searchParams?: Promise<{ repoId?: string | string[]; state?: string | string[] }>;
}) {
  const resolvedSearchParams = await searchParams;
  const previewState = parsePreviewStateValue(resolvedSearchParams?.state);
  const repoId = Array.isArray(resolvedSearchParams?.repoId)
    ? resolvedSearchParams?.repoId[0]
    : resolvedSearchParams?.repoId;

  return <CalibrationPage initialRepoId={repoId} previewState={previewState} />;
}
