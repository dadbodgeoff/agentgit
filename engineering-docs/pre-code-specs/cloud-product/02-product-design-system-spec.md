# 02. Product Design System Spec

## Scope

This document defines the structural and interaction rules for the AgentGit Cloud frontend.

Primary source:

- `/Users/geoffreyfernald/Downloads/AgentGit_Product_Design_System.docx`

## App Shell

The application uses a fixed shell:

- top header
- left sidebar
- main content area
- optional right inspector panel

Only the main content region should scroll during normal use.

## Layout Contracts

### Header

- Fixed 48px height
- Left: logo mark plus breadcrumb
- Center: contextual search / command access
- Right: notifications, avatar, settings

### Sidebar

- Expanded width: 240px
- Collapsed width: 64px
- Expanded state shows icon plus label
- Collapsed state shows icon-only with tooltip
- Active item uses selected surface plus teal left indicator

### Main Content

- Max width: 1200px
- Centered with consistent page padding
- Page header supports title, description, and actions

### Overlays

- Drawers, modals, and command palette use tokenized widths and z-indexes
- Escape closes the topmost overlay
- Focus is trapped in modals
- Backdrop click closes only when the action is non-destructive and there is no unsaved data risk

## Responsive Rules

Breakpoints:

- mobile: 0-639px
- tablet: 640-1023px
- desktop: 1024-1439px
- wide: 1440px and above

Behavioral rules:

- mobile-first styling
- minimum 44x44px touch targets
- sidebar hidden on mobile
- sidebar collapsed on tablet
- tables become card stacks on mobile
- drawers/modals may become full-width sheets on small screens
- breadcrumbs collapse to simpler navigation on smaller viewports

## Component Behavior Contracts

The component layer is not only visual. It must implement keyboard, focus, state, and ARIA behavior.

### Buttons

- Enter and Space activate
- Loading state must not change width
- Disabled buttons leave tab order unless there is an explanatory affordance
- Destructive actions require a confirmation pattern

### Text Inputs

- Label is required and sits above the field
- Help text appears below the field
- Error text replaces help text
- Validation timing:
  - first validation on blur
  - after first error, validate on change
  - never validate on focus or initial page load

### Select, Combobox, Tabs

- Keyboard navigation is required
- ARIA roles and selected/expanded state must be explicit
- Tabs sync active state into the URL
- Autocomplete filters on each keystroke locally or with a 200ms debounce when remote

### Tables And Data Grids

- Support selection, one-column-at-a-time sort, pagination, and status display
- Mobile treatment is not horizontal cram-first; it becomes a card stack when needed
- Bulk actions appear only when rows are selected

### Toasts And Modals

- Toasts have capped stack count and clear auto-dismiss rules
- Errors persist until dismissed
- Modals restore focus to the trigger on close

### Command Palette

- Opens via `Cmd+K` or `Ctrl+K`
- Supports categorized results and keyboard navigation

## Form Patterns

- Default form layout is single-column
- Two-column only for tightly related short fields
- Max form width is constrained
- Optional fields are labeled with `(optional)`, not an asterisk
- Four or more validation errors trigger an error summary with anchors
- Unsaved changes trigger navigation protection
- Multi-step flows validate before moving forward
- Inline editing supports save on blur/Enter and cancel on Escape
- Destructive confirmations scale in strictness by impact

## Screen Templates

The following templates are normative starting points for implementation:

- dashboard
- repository list
- repository detail
- run or pipeline detail
- environment detail
- settings
- approval queue
- audit log

Each page implementation should start from the template structure before adding page-specific nuance.

## Content Rules

- Sentence case everywhere in product UI
- Dates, times, durations, percentages, and SHAs use shared formatting rules
- Tooltips are short and non-critical
- Help text is short, one sentence, and below the relevant field
- Error messages are specific and action-oriented

## Data And State Contracts

### Entity And Status Mapping

- Shared entity shapes should be canonical across screens
- Status-to-color/icon/badge mappings are centralized and must not drift by page
- `escalated` is the only status that uses lime as a status signal

### Loading And Error States

- Use contextual skeletons instead of full-page spinners
- Skeletons should resemble the final content shape
- Errors must present actionable UI states rather than blank pages

### Real-Time Data

- Dashboard and run-related surfaces receive live updates where defined
- Background polling is allowed for lower-priority freshness
- Tab refocus triggers immediate refresh

### URL And Permissions

- Shareable UI state belongs in the URL
- Pages and controls should not render actions the current user cannot perform
- Restricted pages show explicit permission messaging, not blank states

## Implementation Consequence

Any frontend implementation that deviates from these rules should be treated as a design-system decision, not a one-off component shortcut.
