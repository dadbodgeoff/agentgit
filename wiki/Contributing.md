# Contributing

Contributions are welcome. This page covers the development setup, conventions, and pull request process.

---

## Prerequisites

- Node.js 24.14.0+
- pnpm 10.33.0+
- Python 3.11+ (for Python SDK tests)
- Git

---

## Development Setup

```bash
# Clone
git clone https://github.com/agentgit/agentgit
cd agentgit

# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run all tests
pnpm test

# Run Python SDK tests
pnpm py:test
```

---

## Repo Structure

```
packages/                # All packages (TypeScript monorepo)
  authority-cli/         # Operator CLI
  authority-daemon/      # Daemon runtime
  authority-sdk-ts/      # TypeScript SDK
  authority-sdk-py/      # Python SDK
  schemas/               # Canonical types
  action-normalizer/     # Action normalization
  policy-engine/         # Policy evaluation
  snapshot-engine/       # Snapshot capture
  execution-adapters/    # Execution adapters
  run-journal/           # SQLite journal
  recovery-engine/       # Recovery planning
  timeline-helper/       # Timeline projection
  credential-broker/     # OS-backed secrets
  mcp-registry/          # MCP server registry
  integration-state/     # Owned integration state
  workspace-index/       # Workspace metadata
  test-fixtures/         # Shared test utilities

apps/
  inspector-ui/          # Local operator UI

engineering-docs/        # Architecture, specs, runbooks
scripts/                 # Build and release automation
.github/workflows/       # CI and release workflows
```

---

## Common Commands

```bash
# Build
pnpm build                    # Build all packages
pnpm build --filter @agentgit/authority-cli  # Build one package

# Test
pnpm test                     # Run all TypeScript tests
pnpm py:test                  # Run Python SDK tests
pnpm test --filter @agentgit/policy-engine   # Test one package

# Lint and format
pnpm lint                     # ESLint
pnpm format                   # Prettier check
pnpm format:write             # Prettier fix

# Type check
pnpm typecheck

# Run daemon (foreground)
pnpm daemon:start

# CLI shortcut (uses local packages, not globally installed)
pnpm cli <command>
# e.g.
pnpm cli register-run test
pnpm cli --json timeline <run-id>

# Release
pnpm release:pack             # Pack publishable tarballs
pnpm smoke:cli-install        # End-to-end install smoke test
pnpm release:verify           # Verify artifact signatures
```

---

## Testing

### TypeScript tests
Tests are written with [Vitest](https://vitest.dev/). Each package has a `src/__tests__/` directory.

```bash
# Run a specific package's tests
pnpm --filter @agentgit/policy-engine test

# Watch mode
pnpm --filter @agentgit/policy-engine test --watch
```

Coverage gates: 50% lines/functions/statements, 40% branches (enforced in CI).

### Python SDK tests
```bash
PYTHONPATH=packages/authority-sdk-py \
python3 -m unittest discover -s packages/authority-sdk-py/tests -v
```

### Smoke tests (end-to-end)
```bash
pnpm smoke:cli-install    # Install packed tarballs, run setup, verify CLI works
pnpm smoke:cli-compat     # Compat and upgrade/rollback checks
pnpm smoke:py             # Python SDK end-to-end (requires daemon running)
```

---

## Code Conventions

### TypeScript
- Follow the existing ESLint config (see `.eslintrc` or `eslint.config.*`)
- Prettier for formatting — run `pnpm format:write` before committing
- Use explicit types; avoid `any`
- Keep packages focused on their single responsibility (see [Architecture](Architecture.md))

### Commit messages
Follow conventional commits:
```
feat(policy-engine): add budget enforcement for shell domain
fix(snapshot-engine): deduplicate anchors correctly on Windows paths
docs(wiki): add MCP onboarding guide
chore: bump better-sqlite3 to 12.9.0
```

### Package boundaries
Internal packages should not have cross-cutting concerns. The dependency graph flows in one direction:

```
schemas ← all other packages
action-normalizer ← policy-engine
policy-engine, snapshot-engine, execution-adapters ← run-journal
run-journal ← recovery-engine, timeline-helper
all of the above ← authority-daemon
```

Do not add circular dependencies. Do not add direct dependencies from internal packages to the CLI or SDK.

---

## Adding a Feature

1. **Identify which package it belongs to** — follow the existing subsystem boundaries
2. **Check engineering-docs/** for existing specs or design docs on the area
3. **Write the implementation** in the appropriate package
4. **Add tests** — aim for meaningful coverage of the new code paths
5. **Update the package README** if you're adding or changing public exports or behavior
6. **Add a changeset** if the package is public and the change is user-facing:
   ```bash
   pnpm changeset
   ```

---

## Pull Request Process

1. Fork the repo and create a branch
2. Make your changes
3. Ensure all tests pass: `pnpm test && pnpm py:test`
4. Ensure lint is clean: `pnpm lint && pnpm format`
5. Add a changeset if needed: `pnpm changeset`
6. Open a PR against `main`

### PR checklist
- [ ] Tests pass
- [ ] Lint and format clean
- [ ] Package README updated if exports/behavior changed
- [ ] Changeset added if public package change
- [ ] No new `any` types added
- [ ] No new cross-cutting dependencies between packages

---

## Release Process

Releases are driven by [Changesets](https://github.com/changesets/changesets):

1. Changes accumulate in `.changeset/*.md` files
2. Maintainer runs `pnpm changeset version` to bump versions and update changelogs
3. GitHub Actions `release.yml` workflow handles npm publish with provenance

The public packages are: `@agentgit/authority-cli`, `@agentgit/authority-daemon`, `@agentgit/authority-sdk`, `@agentgit/schemas`.

---

## Engineering Docs

Before making architectural changes, read the relevant engineering docs:

- `engineering-docs/system-architecture.md` — overall system design
- `engineering-docs/CURRENT-IMPLEMENTATION-STATE.md` — audited launch-day truth
- `engineering-docs/[01-08]/README.md` — per-subsystem design docs
- `engineering-docs/pre-code-specs/` — detailed feature specifications

---

## Getting Help

- Open an issue on GitHub for bugs and feature requests
- See the [FAQ](FAQ.md) for common questions
- Read the [Architecture Overview](Architecture.md) for a deep-dive into how the system works
