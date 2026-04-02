# @agentgit/authority-daemon

Local authority daemon runtime for `agentgit`.

## Install

```bash
npm install -g @agentgit/authority-daemon
agentgit-authorityd
```

For most users, the recommended path is to install [`@agentgit/authority-cli`](https://www.npmjs.com/package/@agentgit/authority-cli), which now includes the daemon package and a guided `setup` flow.

## Compatibility

- Node.js `24.14.0+`
- local daemon API `authority.v1`

## Environment

The daemon reads its runtime paths from `AGENTGIT_*` environment variables and otherwise defaults to a local-first workspace layout under `.agentgit/`.

Common overrides:

- `AGENTGIT_ROOT`
- `AGENTGIT_SOCKET_PATH`
- `AGENTGIT_JOURNAL_PATH`
- `AGENTGIT_SNAPSHOT_ROOT`
- `AGENTGIT_MCP_REGISTRY_PATH`
- `AGENTGIT_MCP_SECRET_STORE_PATH`
- `AGENTGIT_MCP_HOST_POLICY_PATH`

## Recommended Path

```bash
npm install -g @agentgit/authority-cli
agentgit-authority setup
agentgit-authority daemon start
```
