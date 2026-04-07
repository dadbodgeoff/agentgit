# 04. Appendices

## Screen Inventory

| Screen | Route | Template | Min permission |
| --- | --- | --- | --- |
| Sign in | `/sign-in` | Auth | — |
| Dashboard | `/` | Dashboard | Member |
| Repo list | `/repos` | List | Member |
| Repo detail | `/repos/:org/:name` | Detail+tabs | Member |
| Pipeline detail | `/pipelines/:id` | Detail/Drawer | Member |
| Environments | `/environments` | List | Member |
| Env detail | `/environments/:id` | Detail | Member |
| Approvals | `/approvals` | Card list | Member |
| Agent activity | `/activity` | Timeline | Member |
| Audit log | `/audit` | Table (read-only) | Admin |
| Settings | `/settings/*` | Settings | Varies |
| Team | `/settings/team` | List+invite | Admin |
| Billing | `/settings/billing` | Settings | Owner |
| Onboarding | `/onboarding` | Stepper | Owner |
| 404 | `*` | Error | — |

## Token Cross-Reference

| Token | Used for |
| --- | --- |
| `--ag-surface-base` | Main content background, table body rows |
| `--ag-surface-raised` | Header, sidebar, table headers, code blocks |
| `--ag-surface-overlay` | Cards, modals, drawers, dropdowns, inputs |
| `--ag-surface-hover` | Table row hover, sidebar item hover |
| `--ag-border-subtle` | Card borders, dividers, header borders |
| `--ag-border-default` | Input resting borders |
| `--ag-border-strong` | Input hover borders |
| `--ag-brand-teal` | Focus rings, primary buttons, active indicators, links |
| `--ag-brand-lime` | Agent approve button, agent badge, escalated status |
| `--ag-error / -bg` | Failed status, error borders/banners, destructive buttons |
| `--ag-warning / -bg` | Running/pending status, warning banners |
| `--ag-success / -bg` | Passed/deployed/healthy status, success toasts |
| `--ag-z-sticky (200)` | Header, sidebar |
| `--ag-z-modal (400)` | Modals, command palette |
| `--ag-z-toast (500)` | Toast notifications |
| `--ag-duration-fast (120ms)` | Button press, tooltip appear |
| `--ag-duration-normal (200ms)` | Dropdown open, tab switch, sidebar collapse |
| `--ag-duration-slow (350ms)` | Modal/drawer open, page transitions |
| `--ag-radius-sm (4px)` | Buttons, inputs, badges |
| `--ag-radius-md (8px)` | Cards, code blocks, dropdowns |
| `--ag-radius-lg (12px)` | Modals, large panels |
