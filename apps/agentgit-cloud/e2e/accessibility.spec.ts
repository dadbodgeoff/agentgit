/**
 * Public-route accessibility regression suite.
 *
 * Implements the "axe-playwright CI gate" tracked in the Phase 1 frontend
 * UX gap audit (engineering-docs/pre-code-specs/cloud-product/
 * 09-frontend-ux-gap-audit.md). Brand Identity v2 §12 sets the bar at
 * WCAG 2.1 Level AA, with AAA targeted for text contrast; this spec
 * runs the canonical Deque axe ruleset against every public route in
 * the cloud surface.
 *
 * ## Mode
 *
 * `ACCESSIBILITY_MODE` env var controls behavior:
 *
 *   "enforce" — DEFAULT. Fails the test on any serious or critical
 *               violation. All 4 public routes are currently green
 *               under this mode, and regressions block CI.
 *
 *   "report"  — Logs every violation but never fails the test.
 *               Temporary escape hatch when baselining a new surface
 *               (e.g., adding authenticated routes for the first time
 *               before their violations are cleaned up). DO NOT set
 *               this in production CI.
 *
 * ## History
 *
 * When the gate first landed, the public surface had 4 baseline
 * violations. All 4 were cleaned up in the same commit that flipped
 * this default to enforce:
 *
 *   1. "a { color: inherit }" was escaping @layer base, so every
 *      arbitrary-value text utility on an <a> was losing the cascade.
 *      Moving the base rules into @layer base fixed marketing header
 *      buttons site-wide.
 *
 *   2. `--color-base: var(--ag-bg-base)` in @theme was shadowing
 *      Tailwind v4's built-in `.text-base` font-size utility with a
 *      text color, making every `text-base` body copy render as dark
 *      void text (invisible on dark backgrounds). Removing that one
 *      token entry fixed the sign-in section headings and every
 *      `text-base` usage across the codebase.
 *
 *   3. Tertiary text (#6B7280) at 12px was failing AA contrast on
 *      Slate card backgrounds. Per spec §12.2 tertiary only passes
 *      AA at 18px+ or 14px bold. 85 occurrences across 17 files were
 *      migrated to secondary text (#9BA3B0) which passes AA at 6.1:1.
 *
 *   4. A plain-color link inside a paragraph failed link-in-text-block
 *      because color alone isn't a sufficient differentiator. Adding
 *      underline + underline-offset fixed it.
 *
 * ## Auth
 *
 * Authenticated routes are intentionally NOT covered here yet because
 * they require the daemon + dev sign-in plumbing already exercised by
 * authenticated-smoke.spec.ts. A follow-up commit will add an
 * authenticated accessibility sweep that piggybacks on that spec's
 * sign-in helpers so we don't double the smoke suite's setup cost.
 *
 * Adding a new public route? Add it to PUBLIC_ROUTES below — the test
 * matrix is generated from that list.
 */

const ACCESSIBILITY_MODE: "report" | "enforce" =
  process.env.ACCESSIBILITY_MODE === "report" ? "report" : "enforce";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

type PublicRoute = {
  path: string;
  name: string;
  /**
   * Optional CSS selector(s) to exclude from the axe run. Use sparingly
   * and document the reason inline. The dev-mode Next.js error overlay
   * indicator is the most common reason — it ships with its own a11y
   * baseline that we don't enforce.
   */
  exclude?: string[];
};

const PUBLIC_ROUTES: ReadonlyArray<PublicRoute> = [
  { path: "/", name: "landing" },
  { path: "/pricing", name: "pricing" },
  { path: "/docs", name: "docs" },
  {
    path: "/sign-in",
    name: "sign in",
    // The dev sign-in form exposes a development-only credentials path
    // hidden behind feature flags. The form itself is covered by
    // authenticated-smoke.spec.ts; here we only assert the marketing
    // shell around it is accessible.
    exclude: [],
  },
];

// WCAG 2.1 Level AA per Brand Identity v2 §12.1. axe rule tags map to
// "wcag2a", "wcag2aa", "wcag21a", "wcag21aa". Excluded: "best-practice"
// (advisory only), "experimental" (unstable), "wcag2aaa" (Level AAA is
// only targeted for text contrast, not site-wide).
const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

/**
 * Filter axe violations down to "serious" or "critical". Minor and
 * moderate violations are surfaced in the test output but don't fail
 * the suite — we'd like to fix them but they're not regressions worth
 * blocking a deploy over. Tighten this to include "moderate" once the
 * baseline is clean.
 */
function isBlockingViolation(impact: string | null | undefined): boolean {
  return impact === "serious" || impact === "critical";
}

function summariseViolations(
  violations: Array<{
    id: string;
    impact: string | null | undefined;
    help: string;
    helpUrl: string;
    nodes: Array<{ target: unknown }>;
  }>,
): string {
  return violations
    .map((violation) => {
      const firstNode = violation.nodes[0];
      const target = Array.isArray(firstNode?.target) ? firstNode!.target.join(" ") : "(unknown)";
      return [
        `  • ${violation.id} (${violation.impact ?? "minor"})`,
        `      ${violation.help}`,
        `      help: ${violation.helpUrl}`,
        `      example: ${target}`,
      ].join("\n");
    })
    .join("\n");
}

async function runAxe(page: Page, route: PublicRoute) {
  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);

  for (const selector of route.exclude ?? []) {
    builder = builder.exclude(selector);
  }

  const result = await builder.analyze();

  const blocking = result.violations.filter((violation) => isBlockingViolation(violation.impact));
  const advisory = result.violations.filter((violation) => !isBlockingViolation(violation.impact));

  // Always log advisory + blocking findings so every CI run produces a
  // violation report we can review before flipping to enforce mode.
  // eslint already allows console in e2e specs.
  if (advisory.length > 0) {
    console.log(
      `[axe ${route.name}] ${advisory.length} advisory finding(s):\n${summariseViolations(advisory)}`,
    );
  }
  if (blocking.length > 0) {
    console.log(
      `[axe ${route.name}] ${blocking.length} BLOCKING finding(s) (${ACCESSIBILITY_MODE} mode):\n${summariseViolations(blocking)}`,
    );
  }

  // Only fail the test in enforce mode. See the file header for the
  // rationale — the gate is wired up unconditionally, the assertion is
  // toggled so we can baseline before flipping to enforce.
  if (ACCESSIBILITY_MODE === "enforce") {
    expect(
      blocking,
      `axe found ${blocking.length} blocking violation(s) on ${route.name}:\n${summariseViolations(blocking)}`,
    ).toEqual([]);
  }
}

test.describe("public route accessibility", () => {
  for (const route of PUBLIC_ROUTES) {
    test(`${route.name} (${route.path}) has no serious or critical axe violations`, async ({ page }) => {
      await page.goto(route.path);

      // Wait for the route to be reasonably stable before scanning. The
      // marketing pages are statically rendered so the load event is
      // sufficient — there's no client-side data fetching to wait on.
      await page.waitForLoadState("networkidle");

      await runAxe(page, route);
    });
  }
});
