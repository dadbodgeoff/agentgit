/**
 * Canonical status → badge tone mapping.
 *
 * Implements Product Design System §7.2: "Status-to-UI Mapping. Canonical
 * mapping. No screen may override." Every screen that renders a badge for a
 * Pipeline / Step / Deployment / Approval / Environment / Repository / User
 * should consume `canonicalStatusTone` instead of duplicating a local
 * switch — drift on `escalated` (lime, agent identity) or `failed` (error,
 * not warning) is exactly the kind of bug centralization eliminates.
 *
 * For domain-specific status enums that aren't in the canonical §7.2 list
 * (e.g. connector "stale" / "revoked", delivery "acked"), compose:
 * fall back to a local switch for the non-canonical cases and call
 * `canonicalStatusTone` for the canonical ones. Or pass a synonym map to
 * `statusToneWithSynonyms` if your domain words map cleanly to canonical
 * states (e.g. "completed" → "passed", "verified" → "passed").
 */

import type { BadgeTone } from "@/components/primitives/badge";

/** The exhaustive set of canonical statuses defined in Design System §7.2. */
export type CanonicalStatus =
  | "queued"
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "deployed"
  | "approved"
  | "rejected"
  | "escalated"
  | "healthy"
  | "degraded"
  | "down"
  | "canceled"
  | "skipped"
  | "expired"
  | "active"
  | "archived";

/**
 * Frozen canonical map. Spec §7.2 says no screen may override these
 * values; the `as const` + `Object.freeze` enforces it at runtime as
 * well as at compile time.
 *
 * `escalated` is the ONLY canonical status that uses `accent` (lime).
 * Per Brand Identity v2 §5.1, lime is reserved for agent-initiated
 * actions; `escalated` is the agent identity signal, not a system state.
 */
export const CANONICAL_STATUS_TONE: Readonly<Record<CanonicalStatus, BadgeTone>> = Object.freeze({
  queued: "neutral",
  pending: "warning",
  running: "warning",
  passed: "success",
  failed: "error",
  deployed: "success",
  approved: "success",
  rejected: "error",
  escalated: "accent",
  healthy: "success",
  degraded: "warning",
  down: "error",
  canceled: "neutral",
  skipped: "neutral",
  expired: "neutral",
  active: "success",
  archived: "neutral",
});

/** Returns true if `status` is one of the canonical Design System §7.2 statuses. */
export function isCanonicalStatus(status: string): status is CanonicalStatus {
  return Object.prototype.hasOwnProperty.call(CANONICAL_STATUS_TONE, status);
}

/**
 * Returns the canonical badge tone for a status string.
 *
 * If `status` is not in the canonical §7.2 list, returns `fallback`
 * (default: `"neutral"`). Callers that need to render domain-specific
 * statuses with their own tones should use `statusToneWithSynonyms` or
 * keep a thin local helper that delegates here for the canonical cases.
 */
export function canonicalStatusTone(status: string, fallback: BadgeTone = "neutral"): BadgeTone {
  if (isCanonicalStatus(status)) {
    return CANONICAL_STATUS_TONE[status];
  }
  return fallback;
}

/**
 * Resolves a status string against a synonyms map first, then falls back
 * to the canonical map. Useful for pages whose API returns words like
 * "completed" or "verified" that mean the same thing as a canonical
 * status. Example:
 *
 * ```ts
 * statusToneWithSynonyms(status, {
 *   completed: "passed",
 *   verified: "passed",
 *   drifted: "degraded",
 *   unreachable: "down",
 * });
 * ```
 *
 * Synonyms must point at canonical statuses, not at raw badge tones —
 * that keeps every page expressing intent in canonical-status terms even
 * when the API speaks a different vocabulary.
 */
export function statusToneWithSynonyms(
  status: string,
  synonyms: Readonly<Record<string, CanonicalStatus>>,
  fallback: BadgeTone = "neutral",
): BadgeTone {
  const synonym = synonyms[status];
  if (synonym) {
    return CANONICAL_STATUS_TONE[synonym];
  }
  return canonicalStatusTone(status, fallback);
}
