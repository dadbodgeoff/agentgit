# @agentgit/cloud-ui

Hosted AgentGit Cloud frontend scaffold.

This workspace is intentionally foundation-first. It exists to lock in the app structure, token system, shell, route map, primitives, query layer, and schema boundaries before feature implementation starts.

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
