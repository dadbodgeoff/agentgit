# Frontend UX Gap Audit — agentgit-cloud

**Date:** 2026-04-08 (initial), revised 2026-04-09
**Auditor:** UX engineering pass
**Sources of truth:** `01-brand-identity-spec.md`, `02-product-design-system-spec.md`, `03-cloud-implementation-spec.md`
**Target app:** `apps/agentgit-cloud` (Next.js 15, App Router)

> **2026-04-09 update** — A large parallel landing on `codex/cloud-surface-prod-readiness` (commits `772d62d` + `4e88037`) closed almost the entire P0 list and most of P1 in a single sweep. See **§Phase 1 verification** at the bottom for the post-landing diff. The body of the audit below is preserved as the original snapshot for traceability; do not treat its P0/P1 list as the current state.

## TL;DR

The frontend is roughly **80% complete and architecturally sound**. Layering matches the spec (`primitives → composites → features`), every spec route exists on disk, TanStack Query is wired, RBAC is enforced in the sidebar, and the approval queue already implements live updates, optimistic cache surgery, and confirm-before-destructive flows.

The work to take it to enterprise grade is **spec compliance, missing primitives, and polish** — not a rebuild. Findings are scored P0 (broken or spec-violating in production-visible ways) → P3 (polish).

---

## Phase 0 status

| | Status |
|---|---|
| Dev server unblocked (`.next` cache cleared, restarted from main repo path) | ✅ |
| Marketing surfaces clicked through (`/`, `/pricing`, `/docs`, `/sign-in`) | ✅ |
| Authenticated routes verified via source (browser blocked on dev sign-in flow) | ✅ |
| Source audit of `components/`, `features/`, `styles/` | ✅ |

---

## 1. Routes vs spec (§1 Cloud Implementation Spec)

Every spec route is implemented. **No missing routes.**

| Spec route | File | Notes |
|---|---|---|
| `/` | `src/app/page.tsx` | ✅ |
| `/pricing` | `src/app/pricing/page.tsx` | ✅ |
| `/docs` | `src/app/docs/page.tsx` | ✅ |
| `/sign-in`, `/sign-in/callback` | `src/app/sign-in/...` | ✅ |
| `/app` (dashboard) | `src/app/app/page.tsx` | ✅ |
| `/app/repos` | `src/app/app/repos/page.tsx` | ✅ |
| `/app/repos/[owner]/[name]` | implemented | ✅ |
| `/app/repos/[owner]/[name]/runs` | implemented | ✅ |
| `/app/repos/[owner]/[name]/runs/[runId]` | implemented | ✅ |
| `/app/repos/[owner]/[name]/runs/[runId]/actions/[actionId]` | implemented | ✅ |
| `/app/repos/[owner]/[name]/policy` | implemented | ✅ |
| `/app/repos/[owner]/[name]/snapshots` | implemented | ✅ |
| `/app/approvals` | implemented | ✅ |
| `/app/activity` | implemented | ✅ |
| `/app/audit` | implemented | ✅ |
| `/app/calibration` | implemented | ✅ |
| `/app/onboarding` | implemented | ✅ |
| `/app/settings` (+ team, billing, integrations, connectors) | all present | ✅ |

---

## 2. Tokens & theming (Brand Identity v2 §7, §16)

`src/styles/tokens.css` is **complete and matches spec §7 token-for-token**. Initial audit was based on a truncated read; corrected here.

### Already in place
- ✅ All typography tokens (`--ag-text-display`, `h1`, `h2`, `h3`, `body-lg`, `body`, `body-sm`, `caption`, `overline`, `code`, `data`) as CSS `font` shorthands.
- ✅ All shadows (`xs`, `sm`, `md`, `lg`, `xl`).
- ✅ All motion (`--ag-duration-instant/fast/normal/slow/deliberate`, `--ag-ease-default/in/out/linear`).
- ✅ Surface aliases (`--ag-surface-base/raised/overlay/hover/active/selected`).
- ✅ Spec breakpoint tokens (`--ag-bp-mobile/tablet/desktop/wide`).
- ✅ `font-variant-numeric: tabular-nums` global rule on `table`, `.ag-tabular-nums`, `.ag-metric-value`.
- ✅ `prefers-reduced-motion: no-preference` and `reduce` blocks in `globals.css`.
- ✅ `.ag-text-h1` … `.ag-text-overline` utility classes already exist as CSS.
- ✅ Tailwind v4 `@theme` block exists in `globals.css` with brand/card/text/font/radius/shadow bridges.

### P0 — Real gaps

- **`@theme` block is partial.** Bridges only brand/card/text/font/radius/shadow. Missing: `--color-accent` (lime), all semantic colors (`error`, `warning`, `success`, `info`) and their bgs, `--color-base`, `--color-text-disabled`, `--color-focus`, all `--spacing-*`, `--ease-*`, durations, breakpoints, and Tailwind v4 typography utility entries (`--text-h1: 32px;` etc). Without these, components still need `bg-[var(--ag-color-error)]` instead of `bg-error`.
- **Light mode semantic text colors missing.** `[data-theme="light"]` block has bg colors but no text colors for error/warning/success/info. Marketing pages stay dark so this hasn't surfaced, but it'll bite when /docs gets light treatment.

---

## 3. App shell & navigation (Design System §1)

`src/components/shell/app-shell.tsx`, `shell-header.tsx`, `shell-sidebar.tsx`.

### P0

- **Sidebar has no collapsed (64px) state.** Spec §1.3 requires icon-only collapsed mode toggled via `[` key or chevron. Currently fixed at 240px and `lg:block` (hidden entirely below lg). On mobile there is **no hamburger**, so authenticated routes are unusable on phones.
- **Sidebar has no nav icons.** Spec requires 20px Lucide icon + label per nav item. Today: text-only.
- **No workspace selector control.** Spec requires org name + chevron in 48px row at sidebar top. Today: static workspace name in a bordered div.
- **No bottom-pinned user menu / help link.** Spec §1.3.
- **No section dividers** between Operations / Governance / Settings nav groupings.

### P1

- **No breadcrumbs in header.** Spec §1.2 requires left-zone breadcrumb (max 3 segments).
- **No `Cmd+K` command palette.** Spec §1.1, §3.10 — required surface, not optional.
- **No notification bell.** Spec §1.2 — needed for live approval/run notifications.
- **No user avatar (32px) in header.** Spec §1.2.
- Header height — needs verification against spec's 48px.

---

## 4. Primitives library (Design System §3, Brand Identity §13)

`src/components/primitives/` exports: `badge`, `button`, `card`, `code-block`, `input`, `modal`, `table`, `tabs`, `toast`.

### P0 — Missing primitives that pages need today

| Primitive | Spec | Why P0 |
|---|---|---|
| `Select` / `Dropdown` | DS §3.3 | Needed by approval-queue, settings, calibration. Today: native `<select>` styled inline. |
| `Combobox` / `Autocomplete` | DS §3.4 | Needed for repo picker, member invite, workspace switcher. |
| `Checkbox` | DS §3.5 | Needed for table row selection (DS §3.7) and bulk actions. |
| `Switch` | DS §3.5 | Needed for settings toggles. |
| `Tooltip` | Brand §13 | Needed for status badges, truncated text, disabled-button reasons (DS §3.1 disabled rule). |
| `Drawer` | DS §1.7 | Spec defines as separate from Modal — used for inspector + 480px right detail panel. |
| `DataTable` (composite over `Table`) | DS §3.7 | Sort, row selection, pagination, sticky first column, mobile card-stack — none of these exist today. The current `TableRoot` is a styled `<table>` with no behavior. |
| `Skeleton` | DS §7.3 | Exists in `feedback/loading-skeleton.tsx` but should move into `primitives/` so composites can use it without crossing layer boundaries. |
| `Stepper` | DS §4.4 | Onboarding uses ad-hoc stepper markup; needs primitive. |

### P1 — Missing primitive features

- `Button` has **no loading state.** Spec §3.1 requires label-replaced-by-spinner with locked width and `aria-busy="true"`. Today: callers manually swap label text (e.g. "Approving...") which causes width jitter.
- `Button` accent (lime) variant exists, but **no `aria-disabled` tooltip pattern** when destructive buttons are disabled with reason.
- `Input` uses `--ag-bg-card` for the field surface; spec §3.2 says inputs should sit on `--ag-surface-overlay` (which we don't have a token for at all — needs to be added).
- `Input` does **not implement blur-first validation timing** (DS §4.2). That's currently a consumer responsibility, but the standard pattern should be encapsulated in a `Form` + `FormField` wrapper backed by RHF + Zod.
- `Modal` exists but **no focus trap** confirmed; needs verification + tested fix.
- `Modal` has **no destructive type-to-confirm variant** (DS §4.6 Level 2 / Level 3).
- `Tabs` — need to confirm arrow-key navigation, deep-link via `?tab=` query param.
- `Toast` exists as `ToastCard` + `ToastViewport`, but **no global toast manager**: every page declares local state and renders its own viewport (see `approval-queue-page.tsx:741`). Needs a `useToast()` hook + single root viewport.
- `CodeBlock` — need to verify Plex Mono, syntax highlight palette per Brand §13.9.

### P0 — Eyebrow / Overline component missing

Multiple files use `text-xs uppercase tracking-[0.12em]` inline (e.g. `approval-queue-page.tsx:525`, `544`, etc). The spec defines `--ag-text-overline` as **11px / 0.06em / weight 600**. Two problems: tracking is wrong (0.12 vs 0.06), and the value should be a token, not inlined. Need an `Overline` primitive.

---

## 5. Status → color mapping (Design System §7.2)

Spec §7.2 defines a canonical, **non-overridable** status→color map (queued, pending, running, passed, failed, deployed, approved, rejected, escalated, healthy, degraded, down, canceled, expired, active, archived).

Today this mapping is duplicated inline in pages (`approval-queue-page.tsx:50-86` `connectorTone` / `deliveryTone`). **P1 fix:** centralize as `lib/status/tone.ts` returning `{ tone, badge, icon }` per status, and consume from every screen.

---

## 6. Lime / accent misuse (Brand Identity §5.1, §14)

Spec is unambiguous: **Signal Lime is reserved for agent-initiated actions only.** Three current violations on production-visible marketing pages:

| Location | Element | Violation |
|---|---|---|
| `/` (landing) | "Hosted beta" pill in header | Lime used for general brand badge. |
| `/pricing` | "Recommended" badge on Team plan card | Lime used for marketing emphasis. |
| `/docs` | "Operator quickstart" pill | Lime used for section eyebrow. |

**Where lime IS correctly used:** `approval-queue-page.tsx:674` — `<Button variant="accent">` for "Approve action". This is the correct, sanctioned use.

**Fix:** these marketing badges should use Teal `--ag-color-brand` or a neutral chip. Lime stays exclusively on agent CTAs.

---

## 7. Wordmark & logo (Brand Identity §4)

Landing page renders `AGENTGIT CLOUD` in tracked uppercase. Spec §4.3 explicitly says:

> Typeface: IBM Plex Sans SemiBold (600). "Agent": primary text color of the surface. "Git": Agent Teal (#0ACDCF) on all surfaces. **No space between "Agent" and "Git." The color change provides the visual break.**

**P0 fix:** wordmark must render as `Agent` (Fog) + `Git` (Teal) in mixed case, not uppercase. The "Cloud" subtitle is acceptable but should be a separate eyebrow caption, not part of the wordmark.

The actual SVG mark (the "AG" monogram in a circle) does not match the spec's git-branch + agent-dot construction in §4.1. This is a **P2 logo redesign** task — flag and defer; we need a real SVG logomark from the brand team.

---

## 8. Content rules (Design System §6, Brand Identity §3)

### P0 — In-product dev notes leaking to users

`approval-queue-page.tsx:706-737` renders a `<CodeBlock>` titled **"Build loop backlog"** containing internal engineering paths, file references, and developer instructions ("start the daemon so /api/v1/approvals can resolve real contracts"). **This is visible to any signed-in user on /app/approvals.** Must be removed before any external user touches the app.

### P1 — Content sweep

- **Sentence case audit.** Spec §6.1: sentence case everywhere. Several headings on landing/pricing use Title Case ("Three operating bands for teams shipping agent-driven code." — actually OK; "Best for one team proving the operator loop in production-like conditions." — OK). Need a full pass through every static string.
- **No `!` anywhere.** Brand §3.1 calm voice rule. Search needed.
- **Error messages — two-part rule.** DS §6.3 requires "what happened + what to do." Several inline error strings ("Could not submit the decision. Try again.") comply. Audit needed for the rest.
- **Date/time formatting** — verify `formatRelativeTimestamp` matches DS §6.5 (relative <7d, absolute beyond, MMM DD YYYY).
- **Tooltip max 80 chars** — currently no tooltips at all, so deferred to when we add the primitive.

---

## 9. Five-state coverage (Design System §7.3, Implementation Spec §4)

Spec requires every screen to handle **loading, empty, error, stale, data**.

`approval-queue-page.tsx` is the gold standard:
- ✅ `LoadingSkeleton`
- ✅ `EmptyState` with description
- ✅ `PageStatePanel state="error"` with retry message
- ✅ `StaleIndicator` with live label
- ✅ Data render

**P1 task:** verify every other feature page hits all five states. Needed sweep targets:
- `dashboard-page.tsx`
- `repository-list-page.tsx`, `repository-detail-page.tsx`, `repository-runs-page.tsx`, `repository-policy-page.tsx`, `repository-snapshots-page.tsx`
- `run-detail-page.tsx`, `action-detail-page.tsx`
- `activity-page.tsx`, `audit-page.tsx`, `calibration-page.tsx`
- All settings pages
- `onboarding-page.tsx`

---

## 10. Accessibility (Brand Identity §12)

### Present
- ✅ Skip-to-content link in `app-shell.tsx`
- ✅ `.ag-focus-ring` class for `:focus-visible` Teal ring
- ✅ Inputs use `aria-describedby`, `aria-invalid`
- ✅ RBAC sidebar filters items the user lacks role for

### Missing / unverified
- **No `prefers-reduced-motion` media query.** Brand §9.5 mandates wrapping all animation. `globals.css` has no `@media (prefers-reduced-motion)` block.
- **Touch targets** — 44×44 minimum on mobile (Brand §12.4) unverified. Buttons at `h-9` (36px) fail this on mobile.
- **No `axe-playwright` test harness wired.** Implementation Spec §5.5 requires it on every E2E run.
- **No `lang` attribute audit** on `<html>`.
- **Focus return** on modal close (DS §3.9) — needs verification once Modal primitive is reviewed.
- **Tab key escapes tab list into panel** (DS §3.6) — needs verification.

---

## 11. URL state sync (Design System §7.7)

Spec mandates filters, sort, pagination, active tab, drawer-target all live in `searchParams`. Today: most state lives in component `useState`. Refresh kills it; sharing a URL doesn't preserve filters.

**P1 sweep:** every list/table/tab page needs to migrate state to `useSearchParams` + `router.replace`.

---

## 12. Performance & instrumentation (Implementation Spec §5.6, §5.7)

| Budget | Target | Status |
|---|---|---|
| LCP | <1.5s | Unmeasured |
| FID | <50ms | Unmeasured |
| CLS | <0.05 | Unmeasured |
| Initial JS | <150KB gz | Unmeasured |

- ✅ Sentry wired (`@sentry/nextjs`)
- ❌ No Bundlemon CI gate
- ❌ No Lighthouse CI
- ❌ No Web Vitals reporting hook

---

## 13. Testing (Implementation Spec §5.5)

| Layer | Target | Status |
|---|---|---|
| Unit (vitest) | ≥80% utils/hooks | Partial — `button.test.tsx`, `connector-bootstrap-panel.test.tsx` exist |
| Component | All primitives | Only `button` covered |
| Integration (MSW) | All API hooks | None |
| E2E (Playwright) | 5 priority journeys | Configured (`playwright.config.ts`, `e2e/`); coverage unknown |
| Visual regression | Key screens | None |
| Accessibility (axe-playwright) | All pages | None |

---

## Prioritized fix list

### P0 — Ship-blocking
1. Remove "Build loop backlog" `CodeBlock` from `approval-queue-page.tsx:706-737`.
2. Wordmark: "Agent" + "Git" mixed case, "Git" in Teal, no uppercase.
3. Lime misuse: replace lime on landing/pricing/docs marketing badges with Teal or neutral.
4. Add typography tokens (`--ag-text-h1...code`) and a Tailwind v4 `@theme` mapping so utility classes consume tokens.
5. Build missing primitives: `Select`, `Combobox`, `Checkbox`, `Switch`, `Tooltip`, `Drawer`, `Stepper`, `Overline`.
6. Build `DataTable` composite (sort, selection, pagination, sticky col, mobile card-stack).
7. Sidebar collapsed mode + icons + workspace selector + mobile hamburger.
8. Global toast manager (`useToast` + single `<ToastViewport>` at root).
9. `Button` loading state with locked width and `aria-busy`.
10. Add `prefers-reduced-motion` global guard.

### P1 — Enterprise-grade essentials
11. Header: breadcrumbs, `Cmd+K` command palette, notification bell, user avatar.
12. Centralize status→tone mapping; consume from every screen.
13. URL state sync sweep across list/table/tab pages.
14. Five-state audit and fixes for every feature page that isn't approval-queue.
15. RHF + Zod `Form`/`FormField` wrapper enforcing blur-first validation.
16. Modal: confirmed focus trap, destructive type-to-confirm variant.
17. `axe-playwright` wired into the existing Playwright config; CI gate.
18. Sentence-case + no-`!` content sweep.
19. Tabular numerals on every table cell and metric value.
20. Tailwind theme binding rollout — replace `bg-[var(--ag-bg-card)]` with `bg-card` everywhere.

### P2 — Polish
21. Logo redesign per Brand §4.1 (real branch + dot SVG, not "AG" monogram).
22. Visual regression baseline (Playwright screenshots).
23. Bundlemon + Lighthouse CI gates.
24. Component library Storybook (or equivalent inspector page).

### P3 — Long-tail
25. Remaining shadow / duration / easing tokens.
26. Light mode semantic text tokens (only needed when marketing pages light up).
27. Inspector right-panel composite (only needed by run-detail wide bp).

---

## Recommended Phase 1 sequence (next session)

The audit list is long but the order is tightly coupled. Suggested order:

1. **Tailwind v4 `@theme` token binding** — without this, every other primitive change is verbose and inconsistent. Once bound, `bg-card`/`text-secondary`/`text-h2` etc become available everywhere and a follow-up codemod can clean existing inline `var()` syntax.
2. **Typography tokens + Overline primitive** — needed by every other primitive.
3. **Missing primitives** in this order: `Tooltip` → `Select` → `Combobox` → `Checkbox` → `Switch` → `Drawer` → `Stepper` → `DataTable` (composite). Each gets a vitest component test from the start.
4. **Button loading state + global toast manager** — quick wins that unlock cleanup in approval queue and elsewhere.
5. **Sidebar rebuild** — collapsed mode, icons, workspace selector, mobile hamburger.
6. **Header rebuild** — breadcrumbs, `Cmd+K`, bell, avatar.
7. **P0 content fixes** — remove dev backlog block, fix wordmark, fix lime misuse.
8. **Reduced-motion guard + tabular-nums global rule.**

Anything not on this list is Phase 2+ (per-surface UX rebuild) or polish.

---

## Phase 1 verification — 2026-04-09 post-`772d62d`/`4e88037` landing

Verified by reading HEAD source on `codex/cloud-surface-prod-readiness` after the landing. Cross-references each P0/P1 item from the original list.

### P0 — closed

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Remove "Build loop backlog" `CodeBlock` from approval queue | ✅ | `grep -c 'Build loop backlog\|engineering-docs/pre-code-specs'` returns 0 in `approval-queue-page.tsx` |
| 2 | Wordmark: `Agent` (Fog) + `Git` (Teal), mixed case | ✅ | `shell-header.tsx`: `<span class="text-[var(--ag-text-primary)]">Agent</span><span class="text-[var(--ag-color-brand)]">Git</span>` |
| 3 | Lime misuse on landing/pricing/docs marketing badges | 🟡 mostly | Recommended pricing badge now `<Badge tone="brand">`. Landing/docs hits = 0. **One residual on `pricing/page.tsx:151`** — "When Stripe is enabled" callout uses `text-[var(--ag-color-accent)]` + `tracking-[0.18em]`. Spec violation; lime is not an agent action there, and tracking is wrong. P0 cleanup item below. |
| 4 | Typography tokens + Tailwind v4 `@theme` mapping | ✅ | `tokens.css` defines all spec font shorthands (`--ag-text-display..code`); `globals.css` `@theme` block now bridges brand/surface/text/border/semantic colors, spacing scale, full Tailwind-v4 typography utilities (`--text-h1..code` with line-height/weight/tracking), motion durations + easings. Light-mode semantic text tokens added in `tokens.css` `[data-theme="light"]` block. |
| 5 | Build missing primitives (Select, Combobox, Checkbox, Switch, Tooltip, Drawer, Stepper, Overline) | ✅ | All eight present in `src/components/primitives/` and exported from `index.ts`. Implementations reviewed below. |
| 6 | DataTable composite (sort, selection, pagination, sticky col, mobile card-stack, bulk actions) | ✅ | `src/components/composites/data-table.tsx` (270 lines). Implements every spec §3.7 contract: cycle sort none→asc→desc→none, header-checkbox-selects-all, bulk action bar on selection, 25/page default with 10/25/50/100 options, "Showing X-Y of Z", `md:hidden` mobile card-stack via `<dl>`, `sticky left-0` first column, `aria-sort` per column. |
| 7 | Sidebar collapsed mode + icons + workspace selector + mobile hamburger | ✅ | `shell-sidebar.tsx` accepts `collapsed`, `mobileOpen`, `onToggleCollapsed` props. 240px expanded / 64px collapsed (`w-60` / `w-16`). Workspace selector with avatar circle + `ChevronsUpDown`. Section grouping (`groupedItems`). Bottom-pinned help link + sign-out. Lucide icons per nav row. Tooltips wrap collapsed nav items. Mobile hamburger lives in `shell-header.tsx` (`<Button class="sm:hidden" onClick={onOpenMobileNav}>`). |
| 8 | Global toast manager | ✅ | `providers/toast-provider.tsx` exposes `useToast` + `useOptionalToast`, `pushToast` returns id, max 3 visible (`.slice(0, 3)`), 5s auto-dismiss for non-error toasts via `setTimeout`, errors persist (filtered out of dismiss timer). Tone enum matches spec: `success | info | warning | error`. Has `actionLabel` + `onAction` for action toasts. |
| 9 | `Button` loading state with locked width and `aria-busy` | ✅ | `button.tsx` accepts `loading` + `loadingLabel` props. Sets `aria-busy={loading || undefined}` and `disabled={disabled \|\| loading}`. Children are wrapped in `opacity-0` overlay so width is preserved; spinner overlay sits absolutely on top. |
| 10 | `prefers-reduced-motion` global guard | ✅ | `globals.css` has both `@media (prefers-reduced-motion: no-preference)` (gating animations) and `@media (prefers-reduced-motion: reduce)` (forcing 0.01ms durations on every animation/transition). |

### P1 — closed

| # | Item | Status | Evidence |
|---|---|---|---|
| 11 | Header: breadcrumbs, `Cmd+K`, bell, avatar | ✅ | `shell-header.tsx`: `deriveBreadcrumbs()` covers every authenticated route family (repos with owner/name/runs/policy/snapshots/actions detail, plus static labels for approvals/activity/audit/calibration/connectors/settings/team/billing/integrations/onboarding); breadcrumbs trim to last 3 segments per spec §1.2; `Cmd+K` wired via `onOpenCommandPalette` prop into `command-palette.tsx`; `Bell` and `Settings` icons imported; user avatar built from initials. |
| 19 | Tabular numerals | ✅ | `globals.css`: `table, .ag-tabular-nums, .ag-metric-value { font-variant-numeric: tabular-nums; }` |
| 20 | Tailwind theme binding rollout | 🟡 partial | `@theme` block bridges every spec token (color, semantic, spacing, typography, motion). **Adoption is partial** — primitives still use `bg-[var(--ag-surface-overlay)]` / `ag-text-body` legacy syntax. Functionally identical (same tokens), but the cleanup pass to `bg-overlay` / `text-body` utilities hasn't started. Tracked as P2 cosmetic; not blocking. |

### P0 / P1 — still open

| # | Item | Status | Notes |
|---|---|---|---|
| 3b | Lime misuse on `pricing/page.tsx:151` "When Stripe is enabled" callout | ❌ open | Single residual lime violation. Border + bg + text all use accent. Should be brand teal or neutral. Trivially fixable in a 1-line edit. Also fix `tracking-[0.18em]` → `tracking-[0.06em]` on the same line. |
| 12 | Centralize status→tone mapping in `lib/status/tone.ts` | ❌ open | Inline `tone` helpers (`connectorTone`, `deliveryTone`) still live inside `approval-queue-page.tsx`. Consolidate so every page imports the same map. |
| 13 | URL state sync sweep | ❌ open | Filters / sort / pagination / active-tab / drawer-open across list pages still in `useState`. Needs migration to `useSearchParams` + `router.replace`. |
| 14 | Five-state coverage audit per non-approval feature page | ❌ open | Approval queue is gold standard. Every other page (dashboard, repos list/detail, runs, activity, audit, calibration, settings tree, onboarding) needs a verification + fixes pass. |
| 15 | RHF + Zod `Form` / `FormField` wrapper enforcing blur-first validation | ❌ open | Inputs accept `errorText` but timing is consumer-managed. Centralize in a `<FormField>` wrapper. |
| 16 | Modal focus trap + destructive type-to-confirm variant | ❌ open | Need to read modal.tsx and verify trap; type-to-confirm Level 2/3 (DS §4.6) almost certainly missing. |
| 17 | `axe-playwright` CI gate | ❌ open | Playwright is configured but no axe step. Add to E2E run + CI. |
| 18 | Sentence-case + no-`!` content sweep | ❌ open | Mechanical pass across all static strings. |

### Primitive review notes (HEAD versions)

- **`select.tsx`** — Native `<select>` with custom chevron, label/help/error props, `aria-describedby`, `aria-invalid`, `aria-live="polite"` on error, focus ring, `--ag-surface-overlay` background, `min-h-11` (44px touch target). ⚠️ Native fallback — does not implement spec §3.3 listbox role / type-ahead jump / flip-above. Acceptable for v1; flag a `<Listbox>` upgrade as P2 if dropdown polish becomes a priority.
- **`combobox.tsx`** — `role="combobox"` + `role="listbox"` + `role="option"`, ArrowUp/Down nav with bounds, Enter selects, Escape closes, click-outside via `mousedown` listener, filter on description + keywords, empty state message, `max-h-80` (320px) per spec, surface-overlay background. ⚠️ No 200ms debounce path for API-backed sources (spec §3.4 — synchronous filter only). ⚠️ No flip-above when insufficient space below. Both P2.
- **`checkbox.tsx`** — `peer-checked` styling, indeterminate state via ref, label + description, focus ring on visual square, `min-h-11`. Redundant explicit `role="checkbox"` (implicit from native input) — harmless. Spec compliant.
- **`drawer.tsx`** — 480px max width per spec §1.7, slide from right, backdrop click closes (configurable), Escape closes, X close button, surface-overlay background. ⚠️ No transition animations (spec says slide-in 350ms / out 200ms). ⚠️ No `role="dialog"` / `aria-modal` on the aside. ⚠️ No focus return to trigger on close. P1 polish.
- **`stepper.tsx`** — Spec §4.4: numbered circles + connecting lines, current = teal fill at 12%, complete = teal outline + Check, upcoming = default border. Step description supported. Spec compliant.
- **`data-table.tsx`** — see P0 #6 above. ⚠️ Selected row uses `--ag-surface-selected` bg but lacks the spec §13.5 "2px Teal left accent" — easy 1-line add. Otherwise enterprise grade.
- **`command-palette.tsx`** — 560px max-w per spec §3.10, autoFocus search input, categorized + grouped results (Navigation / Quick Actions / Actions), Arrow nav, Enter executes, Escape closes, Sign-out action, RBAC-filtered nav items via `hasAtLeastRole`. ⚠️ Search input is wrapped in `<Input>` primitive, which means `role="combobox"` and `role="listbox"` semantics aren't on the right elements (spec §3.10). ⚠️ No "max 8 visible results" cap (spec §3.10) — currently shows all matches. P1.
- **`toast-provider.tsx`** — see P0 #8 above. Spec compliant.
- **`shell-sidebar.tsx`** — see P0 #7 above. Spec compliant.
- **`shell-header.tsx`** — see P1 #11 above. Spec compliant.

### Net Phase 1 status

- **P0:** 9 of 10 closed. 1 residual lime/tracking violation on `pricing/page.tsx:151`.
- **P1:** 3 of 10 closed (header rebuild, tabular numerals, theme binding partial). 7 still open: status mapping, URL state sync, five-state coverage sweep, RHF/Zod form wrapper, modal focus trap + type-to-confirm, axe-playwright CI gate, content sweep.
- **P2/P3:** unchanged.

### Recommended next moves

Highest leverage, lowest coordination risk first:

1. **Fix the 1 residual P0** — `pricing/page.tsx:151` lime + tracking. Single-line edit, isolated commit.
2. **Centralize status→tone mapping** — extract `lib/status/tone.ts` and migrate `connectorTone` / `deliveryTone` from `approval-queue-page.tsx`. New file + small page edits.
3. **Modal primitive audit** — read `modal.tsx`, verify focus trap, add destructive type-to-confirm variant. Single primitive + tests.
4. **`axe-playwright` CI gate** — wire `@axe-core/playwright` into existing Playwright config and add a test that visits each route. Adds CI floor for accessibility regressions.
5. **URL state sync sweep** — small `lib/url/use-url-state.ts` hook + migration of one list page (repos) to prove the pattern, then mechanical sweep across the rest.
6. **Five-state coverage sweep** — start with `dashboard-page.tsx` and `repository-list-page.tsx`, work outward. Adopt `PageStatePanel` + `LoadingSkeleton` everywhere.
7. **RHF + Zod `<FormField>` wrapper** — once the form pattern is locked, every settings page benefits.
8. **Content sweep** — automated where possible (`grep -nE '!\s*$' src` for exclamation marks; eyeball capitalization).
9. **Theme-binding adoption codemod** — replace `bg-[var(--ag-bg-card)]` → `bg-card`, `text-[var(--ag-text-secondary)]` → `text-text-secondary`, etc. Mechanical, large diff, low risk.

After these, Phase 1 fully closes and Phase 2 (per-surface UX rebuild) can begin against a clean primitive baseline.
