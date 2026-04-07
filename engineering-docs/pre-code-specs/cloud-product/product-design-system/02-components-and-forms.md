# 02. Components And Forms

## Buttons

### State Matrix

| State | Visual change | Cursor | ARIA |
| --- | --- | --- | --- |
| Resting | Default styling | pointer | — |
| Hover | Background one layer lighter | pointer | — |
| Focus-visible | 2px teal focus ring, 2px offset | pointer | — |
| Active/pressed | Background darkens 10% | pointer | — |
| Loading | Label replaced by 16px spinner, width locked | default | `aria-busy="true"` |
| Disabled | Opacity 0.4, no pointer events | `not-allowed` | `aria-disabled="true"` |

### Keyboard And Rules

- `Enter` or `Space` activates
- `Tab` moves focus out
- Arrow keys navigate button groups
- Loading state must not change width
- Disabled buttons leave tab order unless an explanatory tooltip is required
- Destructive buttons require confirmation before execution

## Text Inputs

### State Matrix

| State | Border | Background | ARIA |
| --- | --- | --- | --- |
| Resting | `--ag-border-default` | `--ag-surface-overlay` | — |
| Hover | `--ag-border-strong` | `--ag-surface-overlay` | — |
| Focus | `--ag-brand-teal (2px)` | `--ag-surface-overlay` | — |
| Error | `--ag-error` | `--ag-error-bg` | `aria-invalid`, `aria-describedby` |
| Disabled | `--ag-border-subtle` | `--ag-surface-raised @50%` | `aria-disabled` |
| Read-only | none | `--ag-surface-base` | `aria-readonly` |

### Anatomy

- Label required
- Label size: 13px, weight 600, above input
- Label-to-input gap: 4px
- Help text optional, 12px secondary text below input
- Help/Error gap: 4px
- Error text replaces help text
- Error text announced via `aria-live`
- Validation happens on blur first, then on change after first error

## Select / Dropdown

- `Enter` or `Space` opens
- Arrow keys navigate
- `Enter` selects
- `Escape` closes
- Type-ahead jumps to first match
- Max dropdown height: 320px with internal scroll
- Dropdown flips above trigger when needed
- ARIA: `role="listbox"`, `role="option"`, `aria-expanded` on trigger

## Combobox / Autocomplete

- Text input plus filterable dropdown
- Filters on every keystroke locally or with 200ms debounce when remote
- Empty result state is visible in dropdown, not hidden
- ARIA: `role="combobox"`, `role="listbox"`, `aria-autocomplete="list"`

## Checkboxes And Switches

- Checkbox has unchecked, checked, and indeterminate states
- `Space` toggles checkbox
- ARIA: `role="checkbox"`, `aria-checked`
- Switch is two-state only
- `Space` or `Enter` toggles switch
- Switch is for immediate-effect settings
- Checkbox is for save-required settings

## Tabs

- Left/right arrows move between tabs with automatic activation
- `Home` and `End` jump to first/last
- `Tab` exits the tab list into panel content
- Active tab syncs to URL query param
- Overflow becomes horizontal scroll with fade indicators
- ARIA: `role="tablist"`, `role="tab"`, `aria-selected`, `role="tabpanel"`

## Tables / Data Grids

### Selection And Sorting

- First-column checkbox controls row selection
- Header checkbox selects all visible rows
- Selected rows use a light teal background tint
- Bulk action bar appears above when rows are selected
- Sort cycles `asc -> desc -> none`
- One sorted column at a time
- Use `aria-sort` on sortable headers

### Pagination

- Default page size: 25
- Options: 10, 25, 50, 100
- Controls live bottom-right
- Display format: `Showing 1-25 of 312`

### Mobile

- Mobile turns rows into cards
- Tablet may use horizontal scroll with sticky first column

## Toasts

- Bottom-right on desktop
- Full-width at top on mobile
- Maximum 3 visible at once
- 5 second auto-dismiss for success/info
- Errors persist
- Close button on all toasts
- Optional action link supported
- Use `role="status"` for info/success and `role="alert"` for error

## Modals

- Focus is trapped inside the modal
- On open, focus the first focusable element
- On close, return focus to the trigger

| Type | Width | Has form | Backdrop closes |
| --- | --- | --- | --- |
| Informational | 560px | No | Yes |
| Form | 560-720px | Yes | No when unsaved data is present |
| Confirmation | 400px | No | No |
| Destructive confirm | 400px | No, type-to-confirm only | No |

## Command Palette

- Opens with `Cmd+K` / `Ctrl+K`
- Layout: input plus categorized results
- Categories: Navigation, Actions, Recent, Settings
- Arrow keys navigate
- `Enter` executes
- `Escape` closes
- Max 8 visible results
- ARIA: combobox input plus listbox results

## Form Layout

- Single column by default
- Two columns only for short, closely related fields
- Labels are above inputs
- Max form width: 560px
- Label-to-input gap: 4px
- Field-to-field gap: 20px
- Section-to-section gap: 32px with H3 header

## Validation

### Timing

- First touch validates on blur
- After the first error, validate on every change
- On submit, validate all fields
- Scroll to and focus the first invalid field
- Never validate on page load or on focus

### Error Display

- Error text appears below the field and replaces help text
- Error text is 12px and uses `--ag-error`
- Use `aria-live`
- If 4 or more fields fail, show an error summary banner with anchors
- Error copy states the problem directly

### Required Vs Optional

- Optional fields are marked `(optional)` in secondary text
- No asterisks

## Save Model

| Pattern | Trigger | Feedback | Use when |
| --- | --- | --- | --- |
| Explicit save | Click `Save` | Toast: `Settings saved.` | Multi-field settings and profiles |
| Auto-save | On blur / 1s debounce | Inline `Saved` indicator | Single-field edits, text editors |
| Submit | Click `Create` / `Submit` | Navigate to created entity | Creation forms |

Other rules:

- Dirty state gates the Save button
- Navigating away with unsaved changes triggers confirmation

## Multi-Step Forms

- Horizontal stepper with numbered circles and connecting lines
- Active step: teal fill
- Completed step: teal outline plus check
- Upcoming step: default border color
- Each step validates before progression
- Back uses secondary styling
- Next uses primary styling
- Final button uses a real outcome verb like `Create` or `Submit`

## Inline Editing

- Click-to-edit transforms text into input
- Hover pencil indicates editability
- Save on blur or `Enter`
- Cancel on `Escape`
- Inline `Saved` indicator fades after 2s

## Destructive Patterns

- Level 1: modal with `Cancel` and `Delete`
- Level 2: modal plus typed `delete`
- Level 3: modal plus typed entity name
