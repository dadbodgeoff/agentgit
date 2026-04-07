# 04. Application Guidance, Accessibility, Components, And Appendices

## Application Guidance

### Dark Mode

Dark mode is the product default.

Surface order:

- Void
- Charcoal
- Slate
- Steel

Examples:

- App shell: Void
- Sidebar and nav: Charcoal
- Cards and dropdowns: Slate
- Hover on Slate: Steel
- Modal backdrop: Void at 60% opacity

### Light Mode

Light mode inverts surfaces:

- White
- Snow
- Fog
- Cloud

Brand and semantic colors stay constant across themes.

### Layout Feel

- Information-dense
- 8px base grid
- all spacing is a multiple of 4px
- left sidebar navigation
- top bar for global actions and search
- max content width 1280px
- no full-bleed hero sections in product

### Density

- Table row: 40px
- Nav item: 32px
- Form field: 36px
- Buttons: 36px default, 32px small, 40px large
- Card padding: 16px, 20px, or 24px

### Component Styling Principles

- Every interactive element has at least default, hover, and focus states
- Destructive flows add confirmation
- Radius: 8px for inputs/buttons, 12px for cards/panels, 16px for modals
- Borders are 1px default and may promote to Strong on hover
- Do not use decorative or dashed borders except drop zones

## Accessibility

### Target

- WCAG 2.1 AA minimum
- AAA targeted for text contrast when practical

### Contrast Ratios On Void

| Element | Min ratio | Actual |
| --- | --- | --- |
| Primary text (`#F0F2F5`) | 4.5:1 | 14.8:1 |
| Secondary text (`#9BA3B0`) | 4.5:1 | 6.1:1 |
| Tertiary text (`#6B7280`) | 3:1 for large text | 4.0:1 |
| Agent Teal (`#0ACDCF`) | 3:1 for UI | 8.2:1 |
| Signal Lime (`#E8FF59`) | 3:1 for UI | 12.9:1 |
| Error Red (`#EF4444`) | 3:1 for UI | 4.6:1 |

Tertiary text only passes for large text. Limit it to captions, timestamps, and placeholders.

### Focus

- 2px solid teal with 2px offset
- use `:focus-visible`, not `:focus`
- on teal backgrounds, switch ring to Void
- include a skip-to-content link on every page

### Touch Targets

- Touch target minimum: 44x44px
- Pointer target minimum: 32x32px
- Expand hit areas with padding when visuals are smaller

### Keyboard

- `Tab` / `Shift+Tab`: sequential focus
- `Enter`: activate
- `Space`: toggle
- Arrows: composite widgets
- `Escape`: close modal, drawer, or popover and return focus to trigger

### Reduced Motion

Disable transform-based animations while preserving color and border state changes.

## Core Component Visual Guidance

### Buttons

| Variant | Background | Text | Border | Usage |
| --- | --- | --- | --- | --- |
| Primary | `#0ACDCF` | `#0B0F14` | none | Main action, one per visible area |
| Secondary | transparent | `#F0F2F5` | `1px #2D3748` | Alternative action |
| Ghost | transparent | `#9BA3B0` | none | Inline or toolbar tertiary action |
| Accent | `#E8FF59` | `#0B0F14` | none | Agent-recommended approvals only |
| Destructive | transparent | `#EF4444` | `1px #EF444440` | Delete or revoke, requires confirm |

Other rules:

- Height: 36px default, 32px small, 40px large
- Radius: 8px
- Label: 600 weight, 14px
- Hover darkens the background one step
- Disabled uses Charcoal background and Disabled text

### Inputs

- 36px height
- 8px radius
- 8px 12px padding
- Void background
- Default border
- Focus uses teal border and focus ring
- Error uses red border and caption error text
- Disabled uses Charcoal background and Disabled text

### Cards

- Slate background
- 1px Subtle border
- 12px radius
- 20px padding
- Interactive hover may use Default border and Steel background

### Badges

- 22px height
- 2px x 8px padding
- full radius
- caption size
- 500 weight
- monospace
- semantic backgrounds with 25% opacity semantic border

### Tables

- Header: Charcoal background, Secondary text, caption size, 600 weight, uppercase
- Rows: alternating dark surfaces, 40px height
- Horizontal borders only
- Hover: Hover background
- Selected: Selected background plus 2px teal left accent
- Numerics: right-aligned and monospace

### Tabs

- 40px height
- Inactive: Secondary text
- Hover: Primary text
- Active: Primary text plus 2px teal underline
- Tab bar uses 1px Subtle bottom border

### Modals

- Widths: 480px, 640px, 800px
- Max height: 80vh
- Internal scroll
- Slate background
- Default border
- 16px radius
- `shadow-xl`
- Backdrop: Void 60%
- Enter: opacity + scale from 0.95 to 1.0 in 200ms

### Toasts

- Bottom-right desktop placement
- 24px from edges
- 8px vertical gap
- 360px width
- Charcoal background
- Default border
- 8px radius
- `shadow-md`
- Left 3px semantic accent border

### Code Blocks

- Charcoal background
- Subtle border
- 8px radius
- 16px padding
- IBM Plex Mono 13px
- Syntax colors:
  - keywords teal
  - strings green
  - numbers amber
  - comments tertiary text
- Line numbers use tertiary text with a 48px gutter
- Horizontal scroll only, no word wrap

## Do / Don't Rules

### Color

- Do use lime only for agent-initiated actions and indicators.
- Do maintain elevation order.
- Do not use lime for generic success or decorative highlight.
- Do not reverse dark-surface elevation.

### Typography

- Do use monospace only for code and data contexts.
- Do use 600 for headings and 400 for body.
- Do not use monospace for headings or body.
- Do not use 700 bold in product UI.

### Logo

- Do use the primary lockup at 120px and above.
- Do switch to the logomark below 120px.

### Components

- Do limit one Primary button per visible section.
- Do use Accent only for agent-recommended approvals.
- Do not place two teal buttons side by side.
- Do not use Accent as a generic CTA.

### Motion

- Do gate animations behind `prefers-reduced-motion`.
- Do not use bounce, elastic, or spring-heavy easing.

## Competitive Positioning

| Brand | Primary color | Territory | AgentGit differentiation |
| --- | --- | --- | --- |
| GitHub | `#24292f` | Neutral mono | AgentGit's teal is ownable |
| GitLab | `#FC6D26` | Orange + purple | AgentGit is cooler and more infrastructural |
| Vercel | `#000 / #FFF` | Pure mono | AgentGit has a stronger color identity |
| Linear | `#5E6AD2` | Desaturated indigo | AgentGit differentiates on hue and lime secondary |
| Stripe | `#635BFF` | Indigo + slate | AgentGit reads DevOps rather than fintech |

## Implementation Appendix

### Complete CSS Token Block

```css
:root {
  --ag-color-brand: #0ACDCF;
  --ag-color-brand-hover: #089496;
  --ag-color-brand-subtle: #B3F0F1;
  --ag-color-accent: #E8FF59;
  --ag-color-accent-hover: #B8CC47;
  --ag-bg-base: #0B0F14;
  --ag-bg-elevated: #121820;
  --ag-bg-card: #1A2230;
  --ag-bg-card-hover: #222D3D;
  --ag-bg-hover: #1F2937;
  --ag-bg-active: #283548;
  --ag-bg-selected: #0F2F30;
  --ag-text-primary: #F0F2F5;
  --ag-text-secondary: #9BA3B0;
  --ag-text-tertiary: #6B7280;
  --ag-text-disabled: #454E5C;
  --ag-border-subtle: #1F2937;
  --ag-border-default: #2D3748;
  --ag-border-strong: #3D4654;
  --ag-color-error: #EF4444;
  --ag-bg-error: #2A1215;
  --ag-color-warning: #F59E0B;
  --ag-bg-warning: #2A2010;
  --ag-color-success: #10B981;
  --ag-bg-success: #0D2818;
  --ag-color-info: #3B82F6;
  --ag-bg-info: #0F1A2E;
  --ag-color-focus: #0ACDCF;
  --ag-font-sans: 'IBM Plex Sans', -apple-system, system-ui, sans-serif;
  --ag-font-mono: 'IBM Plex Mono', 'SFMono-Regular', Consolas, monospace;
  --ag-space-0: 0;
  --ag-space-1: 4px;
  --ag-space-2: 8px;
  --ag-space-3: 12px;
  --ag-space-4: 16px;
  --ag-space-5: 20px;
  --ag-space-6: 24px;
  --ag-space-8: 32px;
  --ag-space-10: 40px;
  --ag-space-12: 48px;
  --ag-space-16: 64px;
  --ag-radius-sm: 4px;
  --ag-radius-md: 8px;
  --ag-radius-lg: 12px;
  --ag-radius-xl: 16px;
  --ag-radius-full: 9999px;
  --ag-shadow-xs: 0 1px 2px rgba(0, 0, 0, 0.24);
  --ag-shadow-sm: 0 2px 4px rgba(0, 0, 0, 0.28);
  --ag-shadow-md: 0 4px 12px rgba(0, 0, 0, 0.36);
  --ag-shadow-lg: 0 8px 24px rgba(0, 0, 0, 0.48);
  --ag-shadow-xl: 0 16px 48px rgba(0, 0, 0, 0.56);
  --ag-z-dropdown: 100;
  --ag-z-sticky: 200;
  --ag-z-modal-backdrop: 300;
  --ag-z-modal: 400;
  --ag-z-popover: 500;
  --ag-z-toast: 600;
  --ag-z-tooltip: 700;
  --ag-ease-default: cubic-bezier(0.16, 1, 0.3, 1);
  --ag-ease-in: cubic-bezier(0.4, 0, 1, 1);
  --ag-ease-out: cubic-bezier(0, 0, 0.2, 1);
  --ag-duration-instant: 80ms;
  --ag-duration-fast: 120ms;
  --ag-duration-normal: 200ms;
  --ag-duration-slow: 350ms;
  --ag-duration-deliberate: 500ms;
}
```

### Figma Style Naming

| Figma style name | CSS token | Category |
| --- | --- | --- |
| `Color/Brand/Default` | `--ag-color-brand` | Fill |
| `Color/Brand/Hover` | `--ag-color-brand-hover` | Fill |
| `Color/Bg/Base` | `--ag-bg-base` | Fill |
| `Color/Text/Primary` | `--ag-text-primary` | Fill |
| `Color/Border/Default` | `--ag-border-default` | Fill |
| `Color/Semantic/Error` | `--ag-color-error` | Fill |
| `Type/H1` | `--ag-text-h1` | Text style |
| `Type/Body` | `--ag-text-body` | Text style |
| `Type/Code` | `--ag-text-code` | Text style |
| `Effect/Shadow/MD` | `--ag-shadow-md` | Effect |

### Engineering Handoff Notes

- Token prefix is `--ag-`.
- Theme switching happens through `[data-theme]` on `<html>`.
- Dark theme is the default.
- Fonts: IBM Plex Sans (400/500/600/700) and Plex Mono (400/500/600).
- Icons: `lucide-react`, default 20px with 1.5 stroke.
- Motion must honor `prefers-reduced-motion`.
- Focus uses `:focus-visible`.
- Z-index and spacing must come from tokens only.

## Appendices

### What Changed From v1.0

- Expanded palette from 12 to 28 colors
- Explicitly separated lime from success semantics
- Added Info semantic color
- Overhauled token naming to category-role-modifier
- Expanded type scale from 8 to 12 steps
- Added voice, iconography, motion, data viz, and do/don't sections
- Added 9 core component visual specs and a larger z-index/shadow scale
- Verified and documented contrast ratios

### Remaining Gaps

- Component library spec with ARIA, keyboard, state machines, and prop APIs
- Layout system spec with grid, shell dimensions, breakpoints, and panel rules
- Dark-to-light token mapping table
- Form pattern spec beyond the visual layer
- Illustration and empty-state art guide
- Print/PDF stylesheet spec

### Immediate Next Docs

1. Component Library Spec
2. Layout And Responsive System
3. Dark/Light Token Map
4. Content Design Guide
5. Figma Component Library
