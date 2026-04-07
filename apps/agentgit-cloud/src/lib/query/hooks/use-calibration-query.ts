import { useQuery } from "@tanstack/react-query";

import { getCalibrationReport } from "@/lib/api/endpoints/calibration";
import { queryKeys } from "@/lib/query/keys";
import type { PreviewState } from "@/schemas/cloud";

export function useCalibrationQuery(repoId: string | null, previewState: PreviewState, enabled = true) {
  return useQuery({
    enabled: enabled && Boolean(repoId),
    queryKey: [...queryKeys.calibration(repoId ?? "unselected"), previewState],
    queryFn: () => getCalibrationReport(repoId ?? "", previewState),
  });
}
