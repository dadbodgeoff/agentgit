# Component Catalog

The AgentGit Cloud component system follows the Brand Identity v2 and Product Design System specs.
All components use CSS custom properties prefixed `--ag-*` defined in `src/styles/tokens.css`.

## Primitives (`src/components/primitives/`)

| Component | File | Variants | Sizes | Usage |
|---|---|---|---|---|
| Button | `button.tsx` | primary, secondary, ghost, accent, destructive | sm, md, lg | Main actions. One primary per section. `accent` (lime) is ONLY for agent-recommended approvals. |
| Input | `input.tsx` | — | — | Text input with label, help text, and error display. |
| Select | `select.tsx` | — | — | Styled native select with label and error support. |
| Card | `card.tsx` | — | — | Container with subtle border, elevated background, 12px radius, 20px padding. |
| Badge | `badge.tsx` | neutral, success, warning, error, accent | — | Status indicators. Use canonical tone per status. |
| Modal | `modal.tsx` | — | sm (400px), md (560px), lg (720px) | Dialog with focus trap, Escape to close, backdrop click. |
| Table | `table.tsx` | — | — | Data tables with optional `sortable` headers and `TablePagination`. |
| Tabs | `tabs.tsx` | — | — | Tab navigation. |
| Toast | `toast.tsx` | — | — | Notifications. Bottom-right desktop. Auto-dismiss info/success (5s), persist errors. |
| CodeBlock | `code-block.tsx` | — | — | Monospace code display. IBM Plex Mono 13px. |

## Composites (`src/components/composites/`)

| Component | File | Usage |
|---|---|---|
| Breadcrumbs | `breadcrumbs.tsx` | Page navigation hierarchy. Max 3 segments desktop, back arrow mobile. |
| PageHeader | `page-header.tsx` | Page title, description, breadcrumbs, stale indicator, actions. |
| MetricCard | `metric-card.tsx` | Dashboard KPI display. |
| ApprovalCard | `approval-card.tsx` | Approval review with approve/reject. |

## Feedback (`src/components/feedback/`)

| Component | Usage |
|---|---|
| LoadingSkeleton | Pulse-animated placeholder for loading states. |
| EmptyState | Zero-data state: heading + explanation + CTA. |
| ErrorState | Error display with retry button. |
| StaleIndicator | "Updated Xm ago" with refresh button. Accepts `lastUpdatedAt` + `onRefresh`. |
| PageStatePanel | Combined loading/empty/error panel for route pages. |
| AccessDeniedState | RBAC denial with explanation. |

## Shell (`src/components/shell/`)

| Component | Usage |
|---|---|
| AppShell | Layout wrapper: sidebar + header + command palette + toasts. |
| ShellHeader | Top bar: logo, Cmd+K search, notification bell, settings, sign out. |
| ShellSidebar | Collapsible navigation (240px ↔ 64px via `[` key). Active indicator + lucide icons. |
| SidebarProvider | Sidebar collapse state with localStorage persistence. |
| CommandPalette | Cmd+K navigation overlay with route search. |
| CommandPaletteProvider | Global Cmd+K keyboard handler. |
| NotificationBell | Bell icon with count badge and dropdown panel. |

## Hooks (`src/lib/hooks/`)

| Hook | Usage |
|---|---|
| `useUnsavedChangesGuard(isDirty)` | Warns user via beforeunload when form has unsaved changes. |

## Format Helpers (`src/lib/utils/format.ts`)

| Function | Purpose |
|---|---|
| `formatRelativeTimestamp(iso)` | "3m ago", "2h ago", "3d ago". |
| `formatAbsoluteDate(iso)` | "Apr 06, 2026". |
| `formatNumber(n)` | Comma separators for numbers ≥1,000. |
| `formatPercent(n)` | "99.2%" with one decimal max. |
| `formatDuration(ms)` | "2m 34s" or "1h 12m". |
| `formatBytes(bytes)` | "2.4 KB", "1.2 MB". |
| `formatCurrencyUsd(n)` | "$1,234". |
| `formatConfidence(n)` | 2-decimal confidence score. |
| `formatTimeRemaining(iso)` | "Xm left" or "expired". |

## Design Tokens (`src/styles/tokens.css`)

All tokens prefixed `--ag-*`. Never use hardcoded hex colors.

- **Colors**: `color-brand`, `color-accent`, `color-error`, `color-warning`, `color-success`, `color-info`, `color-focus`
- **Backgrounds**: `bg-base`, `bg-elevated`, `bg-card`, `bg-card-hover`, `bg-hover`, `bg-active`, `bg-selected`
- **Text**: `text-primary`, `text-secondary`, `text-tertiary`, `text-disabled`
- **Borders**: `border-subtle`, `border-default`, `border-strong`
- **Spacing**: `space-0` to `space-16` (multiples of 4px)
- **Radius**: `radius-sm` (4), `radius-md` (8), `radius-lg` (12), `radius-xl` (16), `radius-full`
- **Shadow**: `shadow-xs`, `shadow-sm`, `shadow-md`, `shadow-lg`, `shadow-xl`
- **Duration**: `duration-instant` (80ms), `duration-fast` (120ms), `duration-normal` (200ms), `duration-slow` (350ms), `duration-deliberate` (500ms)
- **Ease**: `ease-default`, `ease-in`, `ease-out`, `ease-linear`
- **Z-index**: `z-dropdown` (100), `z-sticky` (200), `z-modal-backdrop` (300), `z-modal` (400), `z-popover` (500), `z-toast` (600), `z-tooltip` (700)

## Status → UI Mapping (canonical)

| Status | Badge Tone |
|---|---|
| `pending` | warning |
| `approved`, `passed`, `deployed`, `healthy`, `active`, `connected` | success |
| `rejected`, `failed`, `down`, `revoked` | error |
| `expired`, `canceled`, `skipped`, `archived` | neutral |
| `escalated` | accent (lime — ONLY for agent-initiated) |
