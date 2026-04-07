# 03. Tokens, Iconography, Motion, And Data Visualization

## Design Tokens

### Naming Convention

All tokens follow:

- `--ag-{category}-{role}-{modifier}`

| Segment | Values | Example |
| --- | --- | --- |
| Category | `color`, `text`, `bg`, `border`, `radius`, `shadow`, `space`, `font`, `ease`, `duration`, `z` | `--ag-bg-` |
| Role | `brand`, `primary`, `card`, `error`, etc. | `--ag-bg-card` |
| Modifier | `hover`, `active`, `disabled`, `subtle`, `strong` | `--ag-bg-card-hover` |

### Color Tokens: Dark Mode

| Token | Value |
| --- | --- |
| `--ag-color-brand` | `#0ACDCF` |
| `--ag-color-brand-hover` | `#089496` |
| `--ag-color-brand-subtle` | `#B3F0F1` |
| `--ag-color-accent` | `#E8FF59` |
| `--ag-color-accent-hover` | `#B8CC47` |
| `--ag-bg-base` | `#0B0F14` |
| `--ag-bg-elevated` | `#121820` |
| `--ag-bg-card` | `#1A2230` |
| `--ag-bg-card-hover` | `#222D3D` |
| `--ag-bg-hover` | `#1F2937` |
| `--ag-bg-active` | `#283548` |
| `--ag-bg-selected` | `#0F2F30` |
| `--ag-text-primary` | `#F0F2F5` |
| `--ag-text-secondary` | `#9BA3B0` |
| `--ag-text-tertiary` | `#6B7280` |
| `--ag-text-disabled` | `#454E5C` |
| `--ag-border-subtle` | `#1F2937` |
| `--ag-border-default` | `#2D3748` |
| `--ag-border-strong` | `#3D4654` |
| `--ag-color-error` | `#EF4444` |
| `--ag-bg-error` | `#2A1215` |
| `--ag-color-warning` | `#F59E0B` |
| `--ag-bg-warning` | `#2A2010` |
| `--ag-color-success` | `#10B981` |
| `--ag-bg-success` | `#0D2818` |
| `--ag-color-info` | `#3B82F6` |
| `--ag-bg-info` | `#0F1A2E` |
| `--ag-color-focus` | `#0ACDCF` |

### Typography Tokens

| Token | Value |
| --- | --- |
| `--ag-font-sans` | `'IBM Plex Sans', -apple-system, system-ui, sans-serif` |
| `--ag-font-mono` | `'IBM Plex Mono', 'SFMono-Regular', Consolas, monospace` |
| `--ag-text-display` | `48px / 1.10 / 700` |
| `--ag-text-h1` | `32px / 1.25 / 600` |
| `--ag-text-h2` | `24px / 1.30 / 600` |
| `--ag-text-h3` | `18px / 1.40 / 600` |
| `--ag-text-body-lg` | `15px / 1.60 / 400` |
| `--ag-text-body` | `14px / 1.60 / 400` |
| `--ag-text-body-sm` | `13px / 1.50 / 400` |
| `--ag-text-caption` | `12px / 1.40 / 400` |
| `--ag-text-overline` | `11px / 1.40 / 600 / uppercase / 0.06em` |
| `--ag-text-code` | `13px / 1.60 / 400 / mono` |
| `--ag-text-data` | `14px / 1.40 / 500 / mono` |

### Spacing, Radius, Shadow, And Z-Index Tokens

| Token | Value |
| --- | --- |
| `--ag-space-0` | `0` |
| `--ag-space-1` | `4px` |
| `--ag-space-2` | `8px` |
| `--ag-space-3` | `12px` |
| `--ag-space-4` | `16px` |
| `--ag-space-5` | `20px` |
| `--ag-space-6` | `24px` |
| `--ag-space-8` | `32px` |
| `--ag-space-10` | `40px` |
| `--ag-space-12` | `48px` |
| `--ag-space-16` | `64px` |
| `--ag-radius-sm` | `4px` |
| `--ag-radius-md` | `8px` |
| `--ag-radius-lg` | `12px` |
| `--ag-radius-xl` | `16px` |
| `--ag-radius-full` | `9999px` |
| `--ag-shadow-xs` | `0 1px 2px rgba(0,0,0,0.24)` |
| `--ag-shadow-sm` | `0 2px 4px rgba(0,0,0,0.28)` |
| `--ag-shadow-md` | `0 4px 12px rgba(0,0,0,0.36)` |
| `--ag-shadow-lg` | `0 8px 24px rgba(0,0,0,0.48)` |
| `--ag-shadow-xl` | `0 16px 48px rgba(0,0,0,0.56)` |
| `--ag-z-dropdown` | `100` |
| `--ag-z-sticky` | `200` |
| `--ag-z-modal-backdrop` | `300` |
| `--ag-z-modal` | `400` |
| `--ag-z-popover` | `500` |
| `--ag-z-toast` | `600` |
| `--ag-z-tooltip` | `700` |

## Iconography

### Style

- Outline icons only
- 1.5px stroke at 20px
- 2px stroke at 24px
- Rounded caps and joins
- Geometric construction
- Use `lucide-react` unless a custom icon is required

### Sizing

| Context | Size | Stroke |
| --- | --- | --- |
| Inline with body text | 16px | 1.5px |
| Buttons, inputs, nav | 20px | 1.5px |
| Page headers, empty states | 24px | 2px |
| Feature illustrations | 32-48px | 2px |

### Color Rules

- Default icon color follows adjacent text
- Interactive icons inherit parent interactive color
- Semantic icons may use Error, Success, Warning, or Info
- Do not use teal decoratively

## Motion

All motion exists for:

- spatial context
- action confirmation
- latency reduction

No decorative motion.

### Durations

| Token | Duration | Usage |
| --- | --- | --- |
| `--ag-duration-instant` | 80ms | Opacity, color, icon swaps |
| `--ag-duration-fast` | 120ms | Button press, toggle, tooltip |
| `--ag-duration-normal` | 200ms | Dropdown, panel expand, tab switch |
| `--ag-duration-slow` | 350ms | Modal, drawer, page transition |
| `--ag-duration-deliberate` | 500ms | Skeleton fade, onboarding step |

### Easing

| Token | Curve | Usage |
| --- | --- | --- |
| `--ag-ease-default` | `cubic-bezier(0.16, 1, 0.3, 1)` | Most transitions |
| `--ag-ease-in` | `cubic-bezier(0.4, 0, 1, 1)` | Exiting elements |
| `--ag-ease-out` | `cubic-bezier(0, 0, 0.2, 1)` | Entering elements |
| `--ag-ease-linear` | `linear` | Progress bars, spinners |

### Allowed Animations

- opacity fades
- `translateY` for dropdowns, popovers, toasts
- `translateX` for drawers and side panels
- slight `scale` for modals
- accordion expansion via max-height or grid rows
- skeleton shimmer

### Prohibited Motion

- bounce
- elastic or spring-heavy easing
- rotation except spinners
- parallax
- autoplaying motion that cannot be paused

### Reduced Motion

Wrap all animations in `@media (prefers-reduced-motion: no-preference)`.

Reduced motion behavior:

- duration `0ms`
- no transform-based animation
- skeleton becomes static gray

## Data Visualization

### Chart Palette

| Name | Hex | Usage |
| --- | --- | --- |
| Series 1 | `#0ACDCF` | Primary series |
| Series 2 | `#3B82F6` | Secondary series |
| Series 3 | `#8B5CF6` | Tertiary series |
| Series 4 | `#F59E0B` | Quaternary series |
| Series 5 | `#EF4444` | Only when data does not mean errors |
| Series 6 | `#10B981` | Only when data does not mean success |

If more than six series are needed, use grouping or small multiples.

### Status Colors In Charts

- Pipeline status uses semantic colors, not generic data series
- Agent vs human uses lime for agent and Secondary text for human
- Never mix series color meaning with semantic status meaning in a single chart

### Chart Rules

- Y-axis starts at zero for bars and areas
- Every chart has a text alternative
- Axis labels use caption size and Secondary text
- Grid lines use Subtle border, 1px, dashed
- No 3D charts
- No pie charts with more than five slices
- Prefer horizontal bars for categorical comparisons
