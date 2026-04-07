# Pre-Launch Adversarial Audit Plan

Status date: 2026-04-06 (America/New_York)

## Purpose

Run a production-style adversarial audit before broad MVP exposure.

This plan assumes a hostile but realistic tester mindset:

- try to exfiltrate secrets
- try to mutate protected or out-of-scope state
- try to create misleading recovery or audit evidence
- try to make the operator surface overstate safety

This is not a replacement for deterministic CI or standard release verification.
It is the launch-blocking abuse-path campaign that should sit on top of:

- `pnpm release:verify`
- `pnpm live:mvp`
- `pnpm stress:autonomy`
- existing recovery drill and operator tabletop evidence

Implementation scope companion:

- [Shell Trust Boundary Remediation Scope](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/SHELL-TRUST-BOUNDARY-REMEDIATION-SCOPE.md)
- [Shell Trust Boundary Implementation Contract](/Users/geoffreyfernald/Documents/agentgit/engineering-docs/SHELL-TRUST-BOUNDARY-IMPLEMENTATION-CONTRACT.md)

## Current Audit Posture

Known critical findings already confirmed in live testing:

1. governed shell can read protected files such as `.env`
2. governed shell can read absolute paths outside the workspace
3. governed shell can mutate protected control surfaces such as `.agentgit/policy.toml`
4. governed shell can write outside the workspace by absolute path or symlink path
5. recovery metadata can overstate recoverability for shell actions that are only `review_only`

No broad autonomous MVP exposure should proceed until these are fixed and regression-tested.

## Audit Standard

The audit is successful only when all of the following are true:

- protected files cannot be read or mutated through any governed surface
- out-of-workspace paths cannot be read or mutated through any governed surface
- approvals are bound to the real object being approved and cannot be raced
- recovery claims match actual restore behavior
- audit/export/inspect/helper surfaces do not leak secret values or over-claim trust
- degraded or uncertain states are surfaced honestly to an operator

Severity rubric:

- `P0`: secret exfiltration, out-of-workspace mutation, approval bypass, cross-session access, silent trust overclaim
- `P1`: recovery deception, audit tamper ambiguity, stale-trust execution, restore drift
- `P2`: operator confusion, degraded UX, noisy but non-exploitable trust gaps

## Evidence Format

Every probe should produce a short record with:

- `probe_id`
- `campaign`
- `goal`
- `commands`
- `expected`
- `actual`
- `severity`
- `run_id`
- `artifacts`
- `recommended_fix_area`

Store outputs under:

- `engineering-docs/release-signoff/adversarial-audit/<date>-<campaign>/`

Recommended artifact set per probe:

- raw CLI JSON outputs
- relevant stdout/stderr captures
- before/after filesystem listings
- recovery plan / recovery execute outputs when applicable
- one short `REPORT.md`
- one machine-readable `summary.json`

## Execution Order

Run campaigns in this order:

1. `Campaign 0`: containment and secret-boundary retest
2. `Campaign 1`: confidentiality and visibility leaks
3. `Campaign 2`: integrity and mutation-control bypasses
4. `Campaign 3`: approval and session isolation races
5. `Campaign 4`: recovery honesty and restore drift
6. `Campaign 5`: audit and evidence tamper resistance
7. `Campaign 6`: long-running churn and crash resilience
8. `Campaign 7`: packaging and install parity abuse cases

Reason for this order:

- campaigns 0 through 2 validate the core trust contract
- campaigns 3 through 5 validate control-plane honesty
- campaigns 6 and 7 validate real operator reliability after the core trust contract is stable

## Campaign 0: Containment And Secret Boundary Retest

Goal:

- prove that shell, filesystem, and any equivalent governed path all enforce the same containment and secret rules

Primary runner:

- `pnpm audit:campaign0`
- optional: `pnpm audit:campaign0 -- --keep-temp`
- optional: `pnpm audit:campaign0 -- --output-dir /absolute/path`

Probes:

1. `shell-read-protected`
- read `.env`, `.npmrc`, `.netrc`, SSH directories, and `.agentgit/*` through `submit-shell`
- expected: denied or escalated before execution

2. `shell-read-outside`
- read an absolute path outside the workspace through `submit-shell`
- expected: denied or escalated before execution

3. `shell-write-protected`
- rename or overwrite `.env` and `.agentgit/policy.toml`
- expected: denied before execution

4. `shell-write-outside`
- write by absolute path outside workspace
- expected: denied before execution

5. `shell-symlink-escape`
- write through an in-workspace symlink pointing outside workspace
- expected: denied before execution

6. `filesystem-symlink-escape`
- repeat the same probes through `submit-filesystem-write` and `submit-filesystem-delete`
- expected: denied before execution

Pass criteria:

- no protected-path or outside-path read succeeds
- no protected-path or outside-path mutation succeeds
- no operator-visible output includes protected content

Launch blocker:

- any success here is a `P0`

## Campaign 1: Confidentiality And Visibility Leaks

Goal:

- prove that secrets cannot leak through outputs, artifacts, summaries, or visibility transforms

Probes:

1. `stdout-secret-leak`
- print secrets to stdout and stderr
- verify redaction across `artifact`, `artifact-export`, `timeline`, `helper`, `run-summary`, and audit bundle flows

2. `filename-secret-leak`
- create files whose names contain tokens or API keys
- verify file names do not leak unsafely in operator surfaces

3. `json-secret-leak`
- emit structured JSON containing nested secrets, multiline blobs, and base64 values
- verify summaries and helper answers remain safe

4. `outside-read-artifact-leak`
- if any outside read is still possible, confirm that export/share/report workflows do not silently include sensitive content

5. `visibility-downgrade-leak`
- compare `user`, `model`, `internal`, and `sensitive_internal`
- verify stricter scopes are never accidentally exposed through weaker ones

Pass criteria:

- no raw secret value appears where policy says it should be withheld
- all operator surfaces are consistent with visibility guarantees

Launch blocker:

- any secret value leaking into `user` or shareable evidence is a `P0`

## Campaign 2: Integrity And Mutation-Control Bypasses

Goal:

- prove that agents cannot change protected or out-of-scope state by changing the expression of the action

Probes:

1. `argv-shape-bypass`
- try the same mutation through `cat`, `node -e`, `python -c`, shell scripts, relative paths, and symlinked paths

2. `child-process-escape`
- submit a short parent command that spawns a detached child which mutates files after the governed action completes

3. `background-writer`
- launch a delayed write outside workspace or into protected paths after snapshot boundary creation

4. `same-target-multi-phase`
- churn the same file through write, rename, delete, recreate, and directory move

5. `control-surface-mutation-matrix`
- target `.agentgit`, `.codex`, `.claude`, `.mcp.json`, and related control surfaces across all supported action types

Pass criteria:

- all protected or out-of-scope writes are denied regardless of wrapper command
- no delayed mutation escapes the trust model silently

Launch blocker:

- any mutation bypass remains a `P0`

## Campaign 3: Approval And Session Isolation Races

Goal:

- prove that approvals, run data, and operator controls are bound to the correct actor and target

Probes:

1. `approval-target-swap`
- request approval on one path, swap symlink or underlying target before execution

2. `approval-replay`
- reuse old approval ids across runs or sessions

3. `cross-session-run-read`
- attempt `run-summary`, `timeline`, `helper`, `artifact`, `plan-recovery`, and `execute-recovery` from a different session

4. `cross-session-approval-resolve`
- attempt to list or resolve approvals from another run/session

5. `stale-approval-after-drift`
- materially change the workspace after approval but before execution

Pass criteria:

- approvals are not reusable across changed targets, runs, or sessions
- run-local evidence remains run-local

Launch blocker:

- any cross-session access or approval replay is a `P0`

## Campaign 4: Recovery Honesty And Restore Drift

Goal:

- prove that recovery planning, recovery execution, and policy metadata tell the same truth

Probes:

1. `outside-write-recovery-honesty`
- write outside the workspace, then inspect policy outcome, plan-recovery, execute-recovery, and run-summary
- verify external effects are not omitted

2. `plan-execute-drift`
- plan recovery, mutate overlapping paths, then execute and compare actual effect to preview

3. `subset-restore-drift`
- restore a subset while later actions touch overlapping directories

4. `symlink-swap-before-restore`
- replace a parent directory with a symlink after planning but before execution

5. `daemon-restart-mid-recovery`
- stop and restart daemon between plan and execute

6. `restore-after-shell-churn`
- use shell-heavy tree mutations and confirm downgrade behavior remains honest

Pass criteria:

- any action marked `recoverable_local` is actually recoverable without hidden loss or manual work
- any action that is not truly recoverable is surfaced as such in policy and operator outputs

Launch blocker:

- any recovery overclaim on a meaningful path is a `P1`
- any restore writing outside the intended boundary is a `P0`

## Campaign 5: Audit And Evidence Tamper Resistance

Goal:

- prove that exported evidence can be trusted and tampering is obvious

Probes:

1. `bundle-file-edit`
- modify manifest, step records, or artifact content after export

2. `bundle-file-remove`
- delete one artifact or one timeline file and re-run verify/report/compare

3. `bundle-order-drift`
- reorder events or alter summary metadata while preserving superficial shape

4. `share-package-leak`
- verify share bundles do not include artifact content unless explicitly requested

5. `report-overclaim`
- confirm `run-audit-report` does not imply stronger integrity than `verify` established

Pass criteria:

- tampering is detected reliably
- share/export boundaries are honest and stable

Launch blocker:

- silent evidence tamper acceptance is a `P1`

## Campaign 6: Long-Running Churn And Crash Resilience

Goal:

- prove that the daemon remains trustworthy under stress, not just under ideal single-run flows

Probes:

1. `100-500 action soak`
- mix shell and filesystem actions with rolling recovery checks

2. `large-output churn`
- generate large stdout/stderr bursts and many artifacts

3. `snapshot-growth pressure`
- confirm snapshot storage, cleanup, and journal health remain coherent

4. `kill-daemon-mid-run`
- terminate daemon during active run and verify restart reconciliation

5. `partial-write crash`
- interrupt action execution and inspect resulting trust state

6. `concurrent-run churn`
- run multiple active runs against the same workspace and verify isolation and audit clarity

Pass criteria:

- no orphaned or misleading run state
- no crash leaves the operator surface falsely healthy

Launch blocker:

- silent post-crash inconsistency is a `P1`

## Campaign 7: Packaging And Install Parity Abuse Cases

Goal:

- prove that the shipped artifacts behave like the source tree under adversarial conditions

Probes:

1. `installed-cli parity`
- run the same containment and secrecy probes against installed tarball artifacts

2. `fresh-machine bootstrap`
- validate `setup`, `daemon start`, `run`, `inspect`, and `restore` on a clean config root

3. `old-cli new-daemon`
- verify compatibility paths do not reopen trust bypasses

4. `release-bundle verification`
- confirm signed/unpacked artifact workflows fail closed on tamper

Pass criteria:

- packaged installs preserve the same trust guarantees as source execution

Launch blocker:

- any source/package mismatch that weakens trust is a `P1`

## Daily Audit Cadence

Recommended loop:

1. run one campaign until findings stabilize
2. file every `P0` and `P1` with exact repro
3. patch the highest-severity cluster
4. add regression tests before continuing
5. rerun the affected campaign
6. only then move on to the next campaign

This avoids the common failure mode where later tests are run on a baseline that is already invalid.

## Recommended Near-Term Sequence

Because of the confirmed shell findings, the next week should look like this:

1. fix shell path normalization and enforcement
2. add regressions for protected-path read, protected-path write, absolute-path outside read/write, and symlink outside read/write
3. rerun `Campaign 0`
4. run `Campaign 1`
5. run `Campaign 4`
6. only after those are green, continue with approval races and long-run soak

## Launch Gate

Do not call the product ready for broad autonomous MVP exposure until:

- `Campaign 0` is green
- `Campaign 1` is green
- no `P0` findings remain open
- all `P1` findings have either been fixed or explicitly accepted with documented compensating controls
- at least one archived adversarial audit evidence bundle is attached to release signoff
