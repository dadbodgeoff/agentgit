# 01. Layout And Responsive Rules

## App Shell

The AgentGit product UI uses a fixed app shell:

- top header bar
- left sidebar
- main content area
- optional right inspector panel

Only the main content area scrolls.

### App Shell Regions

| Region | Position | Dimensions | Z-index | Background |
| --- | --- | --- | --- | --- |
| Header | Fixed top | 48px tall, full width | `--ag-z-sticky (200)` | `--ag-surface-raised` |
| Sidebar | Fixed left | 240px / 64px collapsed | `--ag-z-sticky (200)` | `--ag-surface-raised` |
| Main content | Static, scrollable | Remaining space | `--ag-z-base (0)` | `--ag-surface-base` |
| Inspector | Fixed right (optional) | 360px wide | `--ag-z-sticky (200)` | `--ag-surface-overlay` |
| Command palette | Centered overlay | 560px wide, max 480px tall | `--ag-z-modal (400)` | `--ag-surface-overlay` |

## Header Bar

- Height: 48px
- Left zone: 24px logo mark plus breadcrumb, max 3 segments
- Center zone: contextual search via `Cmd+K`
- Right zone: notification bell, 32px user avatar, settings icon
- Horizontal padding: 16px
- Bottom border: `1px --ag-border-subtle`

## Sidebar

### Expanded

- Width: 240px
- Workspace selector at top, 48px height
- Nav items: 20px icon plus label
- Row height: 36px
- Row gap: 2px
- Active item: `--ag-surface-hover` background plus 2px teal left indicator
- Section dividers: `1px --ag-border-subtle` with 12px vertical margin
- Bottom pinned user menu and help link

### Collapsed

- Width: 64px
- Icons centered with hover tooltips
- Toggle via `[` key or chevron button
- Width transition: 200ms ease-out

## Main Content

- Max width: 1200px
- Centered with auto margins
- Page padding: 32px horizontal, 32px top, 48px bottom
- Page header: H1, optional description, action buttons
- Bottom margin below page header: 24px

## Grid System

| Layout | Grid | Gap | Use case |
| --- | --- | --- | --- |
| Single column | `1fr` | 0 | Detail pages, settings, forms |
| Two equal | `1fr 1fr` | 24px | Comparison or side-by-side panels |
| Weighted | `2fr 1fr` | 24px | Main content plus summary sidebar |
| Three column | `1fr 1fr 1fr` | 24px | Dashboard metric cards |
| Master-detail | `320px 1fr` | 0 (border) | List plus detail split |

## Spacing Rules

| Context | Token | Value | Rule |
| --- | --- | --- | --- |
| Between page sections | `--ag-space-10` | 40px | Between H2-level sections |
| Card grid gap | `--ag-space-6` | 24px | Between cards in a grid |
| Form field gap | `--ag-space-5` | 20px | Between label and input groups |
| Card padding | `--ag-space-4` to `--ag-space-6` | 16-24px | 16px compact, 24px standard |
| Button group gap | `--ag-space-2` | 8px | Between adjacent buttons |
| Icon-to-label gap | `--ag-space-2` | 8px | All icon/text pairings |

## Overlay Rules

| Overlay | Width | Entry | Exit | Backdrop |
| --- | --- | --- | --- | --- |
| Drawer (right) | 480px | Slide in 350ms | Slide out 200ms | `rgba(0,0,0,0.5)` |
| Modal (default) | 560px | Fade + scale 350ms | Fade 200ms | `rgba(0,0,0,0.6)` |
| Modal (wide) | 720px | Fade + scale 350ms | Fade 200ms | `rgba(0,0,0,0.6)` |
| Modal (confirm) | 400px | Fade + scale 350ms | Fade 200ms | `rgba(0,0,0,0.6)` |
| Command palette | 560px | Fade + scale 200ms | Fade 120ms | `rgba(0,0,0,0.4)` |

Behavior:

- `Escape` closes the topmost overlay
- backdrop click closes modals/drawers except destructive confirms
- modals trap focus
- drawers and inspectors do not trap focus
- modal max height is `80vh`

## Breakpoints

| Name | Token | Range | Columns | Sidebar |
| --- | --- | --- | --- | --- |
| Mobile | `--ag-bp-mobile` | 0-639px | 1 | Hidden with hamburger |
| Tablet | `--ag-bp-tablet` | 640-1023px | 1-2 | Collapsed 64px |
| Desktop | `--ag-bp-desktop` | 1024-1439px | 1-3 | Expanded 240px |
| Wide | `--ag-bp-wide` | 1440px and above | 1-4 | Expanded, always visible |

Mobile-first rule:

- base styles target the smallest viewport
- larger viewports override upward with `min-width`

## Component Adaptation

| Component | Mobile | Tablet | Desktop+ |
| --- | --- | --- | --- |
| Data tables | Card-stack layout | Horizontal scroll | Full table |
| Modals | Full-screen sheet | Centered, `90vw` | Centered, fixed width |
| Drawers | Full-width sheet | Standard width | Standard width |
| Tabs | Scrollable, no wrap | Scrollable | Full tab bar |
| Filter bar | Filter icon + badge | Collapsed + chip count | Expanded inline |
| Page actions | Bottom fixed bar | Inline, right-aligned | Inline, right-aligned |
| Breadcrumbs | Back arrow only | 2 segments | 3 segments max |
| Toasts | Full-width, top | Bottom-right | Bottom-right |
| Inspector | Right drawer overlay | Right drawer overlay | Inline on wide breakpoint only |

## Touch Adaptation

- All interactive mobile targets are at least `44x44px`
- Mobile page padding drops to 16px horizontal
- Code blocks scroll horizontally and never wrap lines
- Charts require at least 280px width; below that, use a modal
