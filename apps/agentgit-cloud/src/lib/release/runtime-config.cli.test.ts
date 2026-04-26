import { describe, expect, it } from "vitest";

import { getCloudRuntimeSummary } from "@/lib/release/runtime-config";

describe("cloud runtime config CLI surface", () => {
  it("can be imported outside Next server-only modules", () => {
    const summary = getCloudRuntimeSummary();

    expect(summary.checks.length).toBeGreaterThan(0);
    expect(["development", "production"]).toContain(summary.mode);
  });
});
