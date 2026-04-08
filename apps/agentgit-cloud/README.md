# @agentgit/cloud-ui

Hosted AgentGit Cloud frontend scaffold.

This workspace is intentionally foundation-first. It exists to lock in the app structure, token system, shell, route map, primitives, query layer, and schema boundaries before feature implementation starts.

## Production Readiness

AgentGit Cloud is a hosted control plane, not a Git replacement. In production it should be deployed with:

- a real `AUTH_SECRET` or `NEXTAUTH_SECRET`
- GitHub OAuth configured through `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET`
- development credentials disabled
- a workspace root configured through `AGENTGIT_ROOT` and, when needed, `AGENTGIT_CLOUD_WORKSPACE_ROOTS`
- Sentry configured for runtime reporting and source map upload
- an admin or owner identity that can sign in and generate connector bootstrap tokens

The step-by-step deployment, bootstrap, health, and first-run checklist lives in:

- `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/pre-code-specs/cloud-product/07-production-readiness-runbook.md`

## Structure

- `src/app/`
  - Next.js App Router entrypoints and route skeletons
- `src/components/primitives/`
  - shared token-backed building blocks
- `src/components/composites/`
  - reusable product patterns built from primitives
- `src/components/shell/`
  - app shell, header, sidebar, and mounts
- `src/components/feedback/`
  - loading, empty, error, and stale-state building blocks
- `src/features/`
  - route-level feature placeholders
- `src/lib/`
  - API, query, navigation, RBAC, and utility helpers
- `src/schemas/`
  - cloud-frontend Zod schemas and enums
- `src/styles/`
  - tokens and global styles

## Source Of Truth

Implementation in this app should follow:

- `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/pre-code-specs/cloud-product/README.md`
- `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/pre-code-specs/cloud-product/brand-identity/README.md`
- `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/pre-code-specs/cloud-product/product-design-system/README.md`
- `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/pre-code-specs/cloud-product/cloud-implementation/README.md`
- `/Users/geoffreyfernald/Documents/agentgit/engineering-docs/pre-code-specs/cloud-product/07-production-readiness-runbook.md`
