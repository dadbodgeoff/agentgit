# Support Architecture

This folder contains the supporting infrastructure docs that sit underneath the eight core subsystem docs.

These documents cover the runtime and operational structure required to make the control plane real in a local-first product.

## Included Docs

- `00-local-first-principles.md`
- `01-runtime-architecture.md`
- `02-local-storage-and-layout.md`
- `03-credential-broker.md`
- `04-background-jobs.md`
- `05-platform-capabilities.md`
- `06-config-and-policy-surface.md`
- `07-sync-and-hosted-boundary.md`
- `08-authority-daemon-api.md`
- `09-hosted-mcp-and-remote-trust.md`
- `10-policy-hardening-and-defaults.md`

## Why These Exist

The core subsystem docs describe:

- what the product does
- how actions flow
- how decisions, snapshots, execution, journaling, recovery, and timeline work

These support docs describe:

- what has to run
- where data lives
- how supporting services coordinate
- what platform features are required
- how the local-first system can later sync into a hosted control plane

## Guiding Rule

Start from:

- local canonical state
- local governed execution
- local recovery

Then add hosted sync as a derivative layer later.
