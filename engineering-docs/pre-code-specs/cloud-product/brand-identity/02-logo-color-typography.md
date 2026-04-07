# 02. Logo, Color, And Typography

## Logo System

### Construction

The AgentGit mark combines a git branch graph with an autonomous-agent signal. It is composed of:

- Main trunk: two connected nodes representing repository timeline
- Agent branch: teal branch line with lime terminal dot
- Human branch: secondary gray branch in the opposite direction

Construction rules:

- 48x48 unit grid
- 2.5 unit stroke for primary elements
- 2 unit stroke for the secondary branch

### Variants

| Variant | Contents | Usage |
| --- | --- | --- |
| Primary lockup | Mark + wordmark, horizontal | Default where space allows |
| Stacked lockup | Mark above wordmark | Square containers |
| Logomark only | Mark only | Favicons, avatars, toolbar icons, spaces under 32px |
| Wordmark only | Text only | Co-branding or constrained horizontal layouts |

### Wordmark Specification

- Typeface: IBM Plex Sans SemiBold (600)
- Letter spacing: `-0.02em`
- `Agent` uses primary text color for the surface
- `Git` uses Agent Teal `#0ACDCF`
- No space between `Agent` and `Git`

### Minimum Sizes

| Variant | Min height | Min width |
| --- | --- | --- |
| Primary lockup | 24px | 120px |
| Stacked lockup | 48px | 48px |
| Logomark only | 16px | 16px |
| Wordmark only | 12px | 80px |

### Clear Space

Maintain clear space equal to one branch node height, roughly `17%` of mark height, on all sides.

### Background Usage

| Surface | Mark color | Agent text | Git text |
| --- | --- | --- | --- |
| Dark (`#0B0F14` to `#1A2230`) | `#F0F2F5` | `#F0F2F5` | `#0ACDCF` |
| Light (`#F0F2F5` to `#FFFFFF`) | `#0B0F14` | `#0B0F14` | `#0ACDCF` |
| Teal (`#0ACDCF`) | `#0B0F14` | `#0B0F14` | `#0B0F14` |
| Photo / busy background | Void scrim at 80% | — | — |

### Misuse Rules

- Do not rotate, skew, stretch, or distort the logo.
- Do not recolor `Git` away from teal except on teal backgrounds.
- Do not add shadows, glows, outlines, or gradients.
- Do not place it on busy backgrounds without a scrim.
- Do not recreate the wordmark in another typeface.
- Do not animate the logo without explicit approval.
- Do not use lime in the logo.

## Color System

The palette is organized into seven functional groups.

### Brand Colors

| Name | Hex | Usage |
| --- | --- | --- |
| Agent Teal | `#0ACDCF` | Primary brand, links, focus rings, primary buttons, selected states |
| Deep Teal | `#089496` | Hover/active state for teal elements |
| Teal Light | `#B3F0F1` | Selected background tint in light mode, 10-15% opacity on dark |
| Signal Lime | `#E8FF59` | Agent-initiated actions only |
| Lime Dark | `#B8CC47` | Hover for lime elements, text on lime backgrounds |

Critical rule:

- Signal Lime is not success green
- Lime means an agent did or recommends this
- Green means the operation succeeded

### Surfaces: Dark Mode

| Name | Hex | Usage |
| --- | --- | --- |
| Void | `#0B0F14` | App background, lowest layer |
| Charcoal | `#121820` | Sidebar, header, elevated panels |
| Slate | `#1A2230` | Cards, dropdowns, popovers, modal overlays |
| Steel | `#222D3D` | Nested cards, hover background on Slate surfaces |

### Surfaces: Light Mode

| Name | Hex | Usage |
| --- | --- | --- |
| White | `#FFFFFF` | Page background, lowest layer |
| Snow | `#F8F9FB` | Sidebar, header, elevated panels |
| Fog | `#F0F2F5` | Cards, dropdowns, code blocks |
| Cloud | `#E4E7EC` | Nested cards, hover background on Fog surfaces |

### Semantic Palette

| Name | Hex | Usage |
| --- | --- | --- |
| Error | `#EF4444` | Failures, destructive actions, validation errors |
| Error Bg (dark) | `#2A1215` | Error badge/banner background in dark mode |
| Error Bg (light) | `#FEF2F2` | Error badge/banner background in light mode |
| Warning | `#F59E0B` | Advisories, deprecation, non-blocking issues |
| Warning Bg (dark) | `#2A2010` | Warning background in dark mode |
| Warning Bg (light) | `#FFFBEB` | Warning background in light mode |
| Success | `#10B981` | Completed, deployed, passing, connected |
| Success Bg (dark) | `#0D2818` | Success background in dark mode |
| Success Bg (light) | `#ECFDF5` | Success background in light mode |
| Info | `#3B82F6` | Informational tips, docs links, guidance |
| Info Bg (dark) | `#0F1A2E` | Info background in dark mode |
| Info Bg (light) | `#EFF6FF` | Info background in light mode |

### Text Palette

| Role | Dark mode | Light mode | Usage |
| --- | --- | --- | --- |
| Primary | `#F0F2F5` | `#0B0F14` | Headings, body, labels |
| Secondary | `#9BA3B0` | `#4B5563` | Descriptions, helper text, metadata |
| Tertiary | `#6B7280` | `#7A8494` | Placeholders, timestamps, captions |
| Disabled | `#454E5C` | `#B0B7C3` | Disabled controls, inactive labels |

### Border Palette

| Role | Dark mode | Light mode | Usage |
| --- | --- | --- | --- |
| Subtle | `#1F2937` | `#E4E7EC` | Dividers, separators |
| Default | `#2D3748` | `#D1D5DB` | Input borders, card borders, table rows |
| Strong | `#3D4654` | `#9BA3B0` | Hover borders, active input borders |

### Interactive States

| State | Dark mode | Description |
| --- | --- | --- |
| Hover | `#1F2937` | Background tint for rows, list items, menu items |
| Active/Pressed | `#283548` | Momentary press feedback |
| Selected | `#0F2F30` | Selected row, nav item, tab |
| Focus ring | `#0ACDCF` | 2px solid, 2px offset on all focusable elements |
| Disabled bg | `#121820` | Disabled surface plus disabled text plus default border |

### Focus And Disabled Rules

- Focus ring is 2px solid Agent Teal with 2px offset.
- On teal backgrounds, use Void as the ring color.
- Disabled styles must not rely on opacity alone.
- Disabled inputs use Charcoal background, Disabled text, and Default border.

## Typography

### Type Families

| Family | Role | Weights | Fallback |
| --- | --- | --- | --- |
| IBM Plex Sans | UI, headings, body, labels, buttons | 400, 500, 600, 700 | `-apple-system, system-ui, sans-serif` |
| IBM Plex Mono | Code, data, timestamps, CLI, diffs | 400, 500, 600 | `'SFMono-Regular', Consolas, monospace` |

Both are open source and may be loaded from Google Fonts or self-hosted `woff2`.

### Type Scale

| Token | Size | Line height | Weight | Tracking | Usage |
| --- | --- | --- | --- | --- | --- |
| display | 48px | 1.10 | 700 | `-0.03em` | Marketing hero headlines only |
| h1 | 32px | 1.25 | 600 | `-0.02em` | Page titles |
| h2 | 24px | 1.30 | 600 | `-0.02em` | Section headings |
| h3 | 18px | 1.40 | 600 | `-0.01em` | Subsection headings, card titles |
| body-lg | 15px | 1.60 | 400/500 | `-0.01em` | Intros, feature descriptions |
| body | 14px | 1.60 | 400 | `-0.006em` | Default body, form labels |
| body-sm | 13px | 1.50 | 400 | `0` | Helper text, table cells |
| caption | 12px | 1.40 | 400/500 | `0` | Timestamps, footnotes, badge labels |
| overline | 11px | 1.40 | 600 | `0.06em` | Section labels, uppercase |
| code | 13px | 1.60 | 400 | `0` | Inline code, terminal, diffs |
| code-sm | 12px | 1.50 | 400 | `0` | Log lines, status bar values |
| data | 14px | 1.40 | 500 | `0` | Numeric values, metrics, KPIs |

### Weight Rules

- 400: body text, descriptions, helper text
- 500: labels, data values, emphasized body, nav items
- 600: headings, button labels, selected nav, card titles
- 700: display headlines only, never product UI
- Never use 300 or 800

### Numeral Rules

- Use tabular numerals in tables, data grids, and metrics
- Use proportional numerals in body text and headings
- Right-align numeric table columns

### Truncation

- Single line: `text-overflow: ellipsis` plus title/full-value affordance
- Multi-line: `-webkit-line-clamp`, max 3 visible lines
- Never truncate status labels, error messages, or destructive confirmations

### Content Width

- Body text max width: 680px
- Marketing copy max width: 580px
- Code blocks have no max width and scroll horizontally
