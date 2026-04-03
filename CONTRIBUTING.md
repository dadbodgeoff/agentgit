# Contributing to agentgit

Thanks for wanting to contribute! agentgit is a local-first execution authority layer for autonomous agents, and every improvement — bug fix, doc clarification, new feature — matters.

## Quick links

| Resource | Where |
|----------|-------|
| Full contributing guide | [wiki/Contributing](https://github.com/dadbodgeoff/agentgit/wiki/Contributing) |
| Architecture overview | [wiki/Architecture](https://github.com/dadbodgeoff/agentgit/wiki/Architecture) |
| Filing a bug | [Bug report template](https://github.com/dadbodgeoff/agentgit/issues/new?template=bug_report.yml) |
| Proposing a feature | [Feature request template](https://github.com/dadbodgeoff/agentgit/issues/new?template=feature_request.yml) |

## In brief

```bash
# Clone and install
git clone https://github.com/dadbodgeoff/agentgit.git
cd agentgit
pnpm install

# Build everything
pnpm turbo build

# Run all tests
pnpm turbo test

# Lint
pnpm turbo lint
```

- **Branch from `main`**, name it `feat/...`, `fix/...`, or `docs/...`
- **Keep PRs focused** — one logical change per PR
- **Update docs** — if you change behavior, update the relevant package README and wiki page
- **Tests** — aim to maintain or improve coverage; CI gates at 50% lines/functions/statements, 40% branches

See the [full contributing guide](https://github.com/dadbodgeoff/agentgit/wiki/Contributing) for the complete checklist, commit message conventions, and release process.
