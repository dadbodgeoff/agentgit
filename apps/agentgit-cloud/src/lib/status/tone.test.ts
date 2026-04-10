import { describe, expect, it } from "vitest";

import {
  CANONICAL_STATUS_TONE,
  canonicalStatusTone,
  isCanonicalStatus,
  statusToneWithSynonyms,
  type CanonicalStatus,
} from "@/lib/status/tone";

describe("canonicalStatusTone", () => {
  // Locked-in spec §7.2 expectations. If you change one of these, you are
  // changing a published design rule — update spec docs in lock-step.
  const expected: ReadonlyArray<readonly [CanonicalStatus, ReturnType<typeof canonicalStatusTone>]> = [
    ["queued", "neutral"],
    ["pending", "warning"],
    ["running", "warning"],
    ["passed", "success"],
    ["failed", "error"],
    ["deployed", "success"],
    ["approved", "success"],
    ["rejected", "error"],
    // §7.2 explicit: escalated is the only canonical status using lime/accent.
    ["escalated", "accent"],
    ["healthy", "success"],
    ["degraded", "warning"],
    ["down", "error"],
    ["canceled", "neutral"],
    ["skipped", "neutral"],
    ["expired", "neutral"],
    ["active", "success"],
    ["archived", "neutral"],
  ];

  it.each(expected)("maps %s to %s per Design System §7.2", (status, tone) => {
    expect(canonicalStatusTone(status)).toBe(tone);
    expect(CANONICAL_STATUS_TONE[status]).toBe(tone);
  });

  it("escalated is the only canonical status using accent", () => {
    const escalatedAccent = Object.entries(CANONICAL_STATUS_TONE).filter(([, tone]) => tone === "accent");
    expect(escalatedAccent).toEqual([["escalated", "accent"]]);
  });

  it("returns the supplied fallback for unknown statuses", () => {
    expect(canonicalStatusTone("nonsense")).toBe("neutral");
    expect(canonicalStatusTone("nonsense", "info")).toBe("info");
    expect(canonicalStatusTone("nonsense", "warning")).toBe("warning");
  });

  it("does not match prototype keys (e.g. 'toString') as canonical statuses", () => {
    expect(isCanonicalStatus("toString")).toBe(false);
    expect(isCanonicalStatus("hasOwnProperty")).toBe(false);
    expect(canonicalStatusTone("toString")).toBe("neutral");
  });

  it("CANONICAL_STATUS_TONE is frozen at runtime", () => {
    expect(Object.isFrozen(CANONICAL_STATUS_TONE)).toBe(true);
  });
});

describe("isCanonicalStatus", () => {
  it("recognises every canonical status", () => {
    const all: CanonicalStatus[] = [
      "queued",
      "pending",
      "running",
      "passed",
      "failed",
      "deployed",
      "approved",
      "rejected",
      "escalated",
      "healthy",
      "degraded",
      "down",
      "canceled",
      "skipped",
      "expired",
      "active",
      "archived",
    ];

    for (const status of all) {
      expect(isCanonicalStatus(status)).toBe(true);
    }
  });

  it("rejects unknown statuses", () => {
    expect(isCanonicalStatus("completed")).toBe(false);
    expect(isCanonicalStatus("verified")).toBe(false);
    expect(isCanonicalStatus("stale")).toBe(false);
    expect(isCanonicalStatus("")).toBe(false);
  });
});

describe("statusToneWithSynonyms", () => {
  it("resolves synonyms to canonical tones", () => {
    const synonyms = {
      completed: "passed",
      verified: "passed",
      drifted: "degraded",
      unreachable: "down",
    } as const;

    expect(statusToneWithSynonyms("completed", synonyms)).toBe("success");
    expect(statusToneWithSynonyms("verified", synonyms)).toBe("success");
    expect(statusToneWithSynonyms("drifted", synonyms)).toBe("warning");
    expect(statusToneWithSynonyms("unreachable", synonyms)).toBe("error");
  });

  it("falls through to the canonical map for canonical inputs", () => {
    const synonyms = { completed: "passed" } as const;
    expect(statusToneWithSynonyms("escalated", synonyms)).toBe("accent");
    expect(statusToneWithSynonyms("failed", synonyms)).toBe("error");
  });

  it("uses the supplied fallback for genuinely unknown inputs", () => {
    const synonyms = { completed: "passed" } as const;
    expect(statusToneWithSynonyms("mystery", synonyms)).toBe("neutral");
    expect(statusToneWithSynonyms("mystery", synonyms, "info")).toBe("info");
  });
});
