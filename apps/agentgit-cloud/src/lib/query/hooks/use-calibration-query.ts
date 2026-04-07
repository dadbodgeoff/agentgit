import { useQuery } from "@tanstack/react-query";

import { getCalibrationReport } from "@/lib/api/endpoints/calibration";
import { queryKeys } from "@/lib/query/keys";
import type { PreviewState } from "@/schemas/cloud";

export function useCalibrationQuery(repoId: string, previewState: PreviewState) {
  return useQuery({
    queryKey: [...queryKeys.calibration(repoId), previewState],
    queryFn: () => getCalibrationReport(repoId, previewState),
  });
}
