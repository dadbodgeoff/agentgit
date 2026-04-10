# Agent Runtime Integration

Productized runtime integration layer and `agentgit` CLI for AgentGit.

This package implements the launch product surface defined in the agent runtime integration TDD:

- `agentgit setup`
- `agentgit run`
- `agentgit demo`
- `agentgit inspect`
- `agentgit restore`

## V1 decisions

- Reuse the existing authority daemon and authority SDK directly.
- Store product-facing integration metadata in the AgentGit config root under `runtime-integration/`.
- Use a short central daemon runtime directory for product flows so Unix socket paths stay valid on macOS.
- Generate governed launch assets under `.agentgit/runtime-integration/`, including a standalone daemon-speaking helper and PATH shims for common shell entrypoints.
- OpenClaw v1 uses reversible config mutation for workspace, tool policy, and local plugin loading so governed file and shell actions route through AgentGit-owned surfaces instead of trusted native mutators.
- Generic fallback stores a launch command, generates governed launch assets, and runs through `agentgit run` with shimmed PATH interception for common subprocesses.
- Read-only shimmed subprocesses can continue automatically, but mutating local shell subprocesses pause for explicit approval instead of silently executing outside containment.
- Generic contained launch uses Docker with a projected writable workspace, governed publish-back through the real authority daemon, and explicit network and credential policy fields.
- Contained credentials support `none`, direct host env passthrough for explicitly selected keys, and brokered runtime bindings resolved from AgentGit's encrypted secret store.
- Brokered runtime bindings are distinct from MCP registry credential bindings and now support `env`, `file`, `header_template`, `runtime_ticket`, and `tool_scoped_ref` delivery shapes.
- Contained direct host env passthrough is now explicit-only: AgentGit will not inherit ambient host API keys into a contained run unless the profile was configured with `--credential-env <ENV_KEY>`.
- Contained Docker runs persist explicit egress mode and assurance truth: `inherit`, `none`, `proxy_http_https`, and a fail-closed `backend_enforced_allowlist` expectation that Docker currently reports honestly as unsupported.
- Contained Docker runs can also route proxy-aware HTTP(S) traffic through an AgentGit-managed allowlist proxy via repeated `--egress-host host[:port]` entries; this remains a degraded egress control rather than a universal raw-socket guarantee.
- Contained setup and inspect now surface Docker capability truth explicitly, including projected-workspace enforcement, read-only rootfs, egress mode and assurance, credential brokering state, raw-socket truth, and Docker host mode hints like Docker Desktop vs rootless Docker.
- The contained path now runs through a shared backend interface with normalized capability snapshots, so Docker is an implementation behind the seam instead of containment architecture leaking through the service layer.
- Contained inspect and repair re-verify live Docker availability instead of trusting only the setup-time snapshot, so a missing or stopped Docker backend is surfaced as a degraded contained state immediately.
- `agentgit run` now preflights the saved integration before registering a new governed run, so Docker outages and OpenClaw config drift fail cleanly without creating stale launch records.
- `agentgit run` also supports deliberate checkpoint controls without adding a new top-level verb: `--checkpoint`, `--hard-checkpoint`, `--checkpoint-kind`, and `--checkpoint-reason` all map onto the existing authority run-checkpoint machinery and surface restore commands back to the operator.
- Runtime profiles now persist checkpoint defaults, checkpoint intent, and checkpoint reason templates, and `inspect` surfaces the latest explicit vs automatic checkpoint boundary before restore.
- That same run preflight now re-validates brokered contained secret bindings, so removed or expired workspace secrets fail before launch instead of half-starting a contained run.
- `agentgit inspect` also surfaces missing brokered runtime bindings as degraded state, so setup-time secret references do not look healthy after the underlying secret has been removed or expired.
- Startup failures now avoid persisting misleading `last_run_id` or orphaned contained projection state, so launch bookkeeping only advances once the runtime actually starts cleanly.
- Every saved runtime profile now records a governance mode plus explicit guarantees so setup and inspect can describe exactly what AgentGit is protecting.
- Demo, inspect, and restore are driven by the real authority timeline and recovery APIs.

## Current boundary

- AgentGit governs runtimes it launches and supported runtime surfaces it can integrate with.
- OpenClaw receives the deepest day-one integration through a generated local plugin plus denied native mutator tools.
- The generic fallback governs common shell and file flows that resolve through the generated shim PATH.
- The contained Docker lane protects the real workspace by running against a projection and publishing changes back through governed actions.
- Direct host credential passthrough and unrestricted container network egress are surfaced as degraded contained states instead of hidden implementation details.
- Brokered runtime bindings avoid passing durable host env secrets straight into the contained runtime when the workspace already has an AgentGit-managed encrypted secret.
- Backend-enforced host allowlists are modeled explicitly, but Docker currently fails closed on that stronger expectation instead of pretending proxy-aware HTTP(S) controls are equivalent.
- Absolute-path binaries, arbitrary in-process syscalls, and unsupported foreign-native tool surfaces are not claimed as semantically intercepted in v1.

## Testing

The package ships with:

- migrate-on-read state tests
- fixture-based OpenClaw setup/remove coverage
- generic-command setup/run coverage
- governed shim launch coverage
- Docker-contained policy and publish-back coverage
- OpenClaw plugin asset and rollback coverage
- demo/inspect/restore integration coverage
- conflict-safe restore coverage
- restart resilience coverage

For a real local smoke run across the product surface, use:

```bash
pnpm smoke:agent-runtime
pnpm smoke:agent-runtime-install
```

`pnpm smoke:agent-runtime` exercises the repo-built product CLI. `pnpm smoke:agent-runtime-install` goes one step further by packing the release tarballs, installing the shipped `agentgit` binary into a temp project, and running the same MVP flows against the installed artifact.
