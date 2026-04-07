# Shell Trust Boundary Implementation Contract

Status date: 2026-04-06 (America/New_York)

## Purpose

Define the exact implementation contract for remediating the shell trust-boundary failures.

This document is written so an engineer or agent can execute the fix without ambiguity about:

- what must change
- what must not change
- which files are in each phase
- what verification is mandatory before moving on
- what counts as done

This contract is subordinate to:

- [Shell Trust Boundary Remediation Scope](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/SHELL-TRUST-BOUNDARY-REMEDIATION-SCOPE.md)
- [Pre-Launch Adversarial Audit Plan](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/PRE-LAUNCH-ADVERSARIAL-AUDIT-PLAN.md)

## Contract Summary

The fix must make shell behave under the same trust contract as filesystem.

That means every governed shell attempt must:

1. expose trustworthy path facts to policy when possible
2. fail closed when those path facts imply protected or external scope
3. be contained again at execution time as defense in depth
4. emit recovery metadata that matches actual restore capability

The implementation is not complete until all four are true at once.

## Non-Negotiable Engineering Rules

1. Do not treat command family as a substitute for target-path policy.
2. Do not use `allow_with_snapshot` to permit actions that should be denied or approved.
3. Do not weaken existing filesystem protections while fixing shell.
4. Do not hide uncertainty by relabeling opaque shell as workspace-safe.
5. Do not claim `recoverable_local` when actual recovery remains `review_only`.
6. Do not ship the fix without `Campaign 0` green.

## Phase Ownership

Implementation must proceed in the following order.

### Phase 1. Canonical Shell Target Facts

Goal:

- teach the normalizer to represent shell target scope honestly enough for policy to make correct decisions

Owned files:

- [packages/action-normalizer/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/action-normalizer/src/index.ts)
- [packages/action-normalizer/src/index.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/action-normalizer/src/index.test.ts)

Required work:

- identify explicit path operands in shell argv where reliably possible
- distinguish:
  - in-workspace paths
  - out-of-workspace paths
  - protected/control-surface paths
  - unresolved/opaque path scope
- stop representing shell target as just the workspace root when actual file targets are known
- keep uncertainty explicit when a command is still opaque

Required outcomes:

- `cat /workspace/.env` does not normalize as a generic workspace-safe read
- `cat /tmp/outside.txt` does not normalize as workspace-local read-only work
- interpreter commands carrying absolute or protected paths surface those paths to policy

Forbidden shortcuts:

- do not hardcode `.env`-specific shell logic only
- do not special-case only `cat`
- do not mark all interpreters as external by default if more precise path facts are available

Phase exit verification:

- action-normalizer tests pass
- new normalizer tests exist for protected read, outside read, protected write, outside write

### Phase 2. Policy Decision Alignment

Goal:

- make policy consume the corrected shell path facts and produce the right decision

Owned files:

- [packages/policy-engine/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/index.ts)
- [packages/policy-engine/src/default-policy-pack.ts](/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/default-policy-pack.ts)
- [packages/policy-engine/src/index.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/index.test.ts)

Required work:

- apply protected secret-path logic to shell actions where the effective target is a protected path
- apply control-surface mutation deny logic to shell actions where the effective target is a control surface
- fail closed on out-of-workspace shell path access
- prevent trusted read-only shell from bypassing path-based policy
- ensure opaque shell only auto-proceeds when that is still honest and safe

Required outcomes:

- shell protected reads are denied or escalated before execution
- shell protected writes are denied or escalated before execution
- shell outside-path reads are denied or escalated before execution
- shell outside-path writes are denied or escalated before execution
- policy matched rules and reasons reflect why the action was blocked

Forbidden shortcuts:

- do not lower shell confidence just to force `ask` everywhere
- do not make all shell read-only commands require approval if the real problem is path policy
- do not rely only on execution adapter rejection while leaving policy optimistic

Phase exit verification:

- policy-engine tests pass
- new policy tests exist for all confirmed shell `P0` repros

### Phase 3. Execution-Time Containment

Goal:

- make shell execution fail closed even if normalization or policy misses a case

Owned files:

- [packages/execution-adapters/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/execution-adapters/src/index.ts)
- [packages/execution-adapters/src/index.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/execution-adapters/src/index.test.ts)

Required work:

- inspect effective shell path operands before spawn where supported
- reject absolute out-of-root targets
- reject symlink-resolved outside targets
- reject protected/control-surface targets
- preserve existing `cwd` containment checks

Required outcomes:

- shell cannot execute outside-path reads or writes even if upstream policy incorrectly allowed them
- shell cannot reach protected paths via absolute path, relative path, or symlink-resolved path

Forbidden shortcuts:

- do not silently rewrite dangerous argv to “safer” values
- do not permit execution and rely on snapshots to undo it later
- do not loosen symlink containment to preserve old behavior

Phase exit verification:

- execution-adapter tests pass
- new adapter tests cover absolute outside read/write and symlink outside write

### Phase 4. Recovery And Operator Truthfulness

Goal:

- make policy, recovery planning, and operator evidence say the same truthful thing

Owned files:

- [packages/policy-engine/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/index.ts)
- [packages/recovery-engine/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/recovery-engine/src/index.ts)
- [packages/recovery-engine/src/index.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/recovery-engine/src/index.test.ts)
- [packages/authority-daemon/src/server.integration.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.integration.test.ts)
- [packages/authority-cli/src/main.integration.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/main.integration.test.ts)

Required work:

- stop emitting `recoverable_local` for shell actions whose real restore class is only `review_only`
- surface external effects or external-scope uncertainty where appropriate
- ensure run-summary, timeline, helper, and CLI-visible outputs do not overclaim recoverability

Required outcomes:

- policy-time recovery claims align with recovery-engine output
- no shell outside-path mutation looks locally restorable in operator surfaces

Forbidden shortcuts:

- do not patch only CLI text while leaving policy metadata wrong
- do not suppress recovery metadata entirely to avoid inconsistency

Phase exit verification:

- recovery-engine tests pass
- daemon/CLI integration tests cover corrected recovery semantics for shell outside-boundary cases

### Phase 5. Adversarial Gate Lock-In

Goal:

- make the fix durable and launch-gated

Owned files:

- [scripts/run-adversarial-campaign-0.mjs](/Users/geoffreyfernald/Documents/agentgit/scripts/run-adversarial-campaign-0.mjs)
- [scripts/stress-autonomous-governance.mjs](/Users/geoffreyfernald/Documents/agentgit/scripts/stress-autonomous-governance.mjs)
- relevant docs in `engineering-docs/release-signoff/adversarial-audit/`

Required work:

- rerun `Campaign 0` until green
- rerun shell-heavy adversarial autonomy stress
- archive new evidence

Required outcomes:

- `Campaign 0` passes
- shell-heavy adversarial stress no longer reports the current shell bypasses

Forbidden shortcuts:

- do not weaken the audit runner expectations to make it pass
- do not remove or skip failing probes instead of fixing behavior

## File Touch Matrix

The following file groups are expected to change.

Required:

- [packages/action-normalizer/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/action-normalizer/src/index.ts)
- [packages/action-normalizer/src/index.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/action-normalizer/src/index.test.ts)
- [packages/policy-engine/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/index.ts)
- [packages/policy-engine/src/default-policy-pack.ts](/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/default-policy-pack.ts)
- [packages/policy-engine/src/index.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/policy-engine/src/index.test.ts)
- [packages/execution-adapters/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/execution-adapters/src/index.ts)
- [packages/execution-adapters/src/index.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/execution-adapters/src/index.test.ts)

Likely:

- [packages/recovery-engine/src/index.ts](/Users/geoffreyfernald/Documents/agentgit/packages/recovery-engine/src/index.ts)
- [packages/recovery-engine/src/index.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/recovery-engine/src/index.test.ts)
- [packages/authority-daemon/src/server.integration.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-daemon/src/server.integration.test.ts)
- [packages/authority-cli/src/main.integration.test.ts](/Users/geoffreyfernald/Documents/agentgit/packages/authority-cli/src/main.integration.test.ts)

Support:

- [scripts/run-adversarial-campaign-0.mjs](/Users/geoffreyfernald/Documents/agentgit/scripts/run-adversarial-campaign-0.mjs)
- [scripts/stress-autonomous-governance.mjs](/Users/geoffreyfernald/Documents/agentgit/scripts/stress-autonomous-governance.mjs)

## Required Regression Cases

The implementation is incomplete unless these are automated:

1. shell protected read of `.env`
2. shell protected write of `.env`
3. shell control-surface write of `.agentgit/policy.toml`
4. shell outside absolute read
5. shell outside absolute write
6. shell outside symlink write
7. shell outside-path recovery metadata honesty
8. shell protected-path policy matched-rule coverage

## Verification Checklist By Phase

### After Phase 1

- `pnpm --filter @agentgit/action-normalizer test -- --runInBand`

### After Phase 2

- `pnpm --filter @agentgit/policy-engine test -- --runInBand`

### After Phase 3

- `pnpm --filter @agentgit/execution-adapters test -- --runInBand`

### After Phase 4

- `pnpm --filter @agentgit/recovery-engine test -- --runInBand`
- `pnpm --filter @agentgit/authority-daemon test -- --runInBand`
- `pnpm --filter @agentgit/authority-cli test -- --runInBand`

### Final adversarial verification

- `pnpm audit:campaign0`
- `pnpm stress:autonomy -- --profile adversarial --iterations 18 --recover-every 1 --delay-ms 0 --seed 42`

### Final production-confidence verification

- `pnpm typecheck`
- `pnpm release:verify`

## Definition Of Done

This remediation is done only when all of the following are true:

- the implementation contract phases have all been completed
- all required tests are present and green
- `Campaign 0` is green
- adversarial autonomy rerun is green for the targeted shell boundary cases
- production-confidence verification is green
- fresh evidence has been archived under `engineering-docs/release-signoff/adversarial-audit/`

## Closure Statement

If any shell path can still:

- read a protected file,
- read an outside-workspace file,
- mutate a protected/control-surface file,
- mutate an outside-workspace file,
- or be described as locally recoverable when it is not,

then this contract has not been satisfied.
