import "server-only";

import { getCloudRuntimeChecks, type RuntimeCheck } from "@/lib/release/runtime-config";

export type ReadinessCheck = RuntimeCheck;
export { summarizeReadiness } from "@/lib/release/runtime-config";

export function getCloudReadinessChecks(): ReadinessCheck[] {
  return getCloudRuntimeChecks();
}
