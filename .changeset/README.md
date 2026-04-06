# Changesets

This repo uses Changesets to version and publish the public npm package surface:

- `@agentgit/integration-state`
- `@agentgit/credential-broker`
- `@agentgit/authority-daemon`
- `@agentgit/schemas`
- `@agentgit/authority-sdk`
- `@agentgit/authority-cli`
- `@agentgit/agent-runtime-integration`

Use `pnpm changeset` to record a release note, `pnpm version:packages` to apply version bumps, and the GitHub release workflow to publish through npm trusted publishing.
