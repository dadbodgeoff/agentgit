# 09. Hosted MCP And Remote Trust

## Working Thesis

Hosted MCP support should be an additive governed capability layered on top of the local-first authority model, not a loophole that bypasses it.

That means:

- local authority remains the canonical policy and journal boundary for local runs
- remote/public MCP registration is candidate-first and approval-gated
- hosted execution is optional, explicit, and evidence-rich
- arbitrary upstream MCP metadata is never trusted on its own
- credentials stay brokered and scoped even when execution happens off the local machine

## Why This Matters

If remote MCP is treated like a raw URL plus a tool list:

- the trust model collapses
- the product becomes vulnerable to confused-deputy failures
- approvals become noisy because onboarding and execution are mixed together
- “governed MCP” stops meaning anything

If hosted execution is bolted on as a hidden fallback:

- local-first becomes fake
- debugging gets harder
- users cannot tell where side effects actually happened

So the right model is:

**candidate-first onboarding, explicit trust tiers, brokered auth, and optional hosted execution with signed evidence**

## Non-Negotiable Rules

- raw user input or agent output may create MCP server candidates, but never executable governed registrations directly
- public remote MCP must use HTTPS with platform TLS validation
- tool annotations, `readOnlyHint`, `destructiveHint`, and descriptive text are only hints unless backed by trust and policy
- model-visible paths never receive durable raw credentials
- hosted execution must not become a required dependency for local product correctness
- drift in identity, auth, or tool inventory must be visible and able to quarantine the server profile

## Product Modes

The product should support three distinct MCP modes and keep them separate.

### 1. Local operator-managed MCP

This is the current launch-owned slice:

- operator-managed `stdio`
- operator-managed `streamable_http`
- local daemon executes and records everything directly

### 2. Local governed remote MCP

The local daemon still executes the remote MCP call directly, but the upstream server may be:

- operator-approved public remote
- publisher-verified remote
- user-submitted or agent-discovered after approval and profile activation

This mode expands registration and trust without moving execution off-box.

### 3. Hosted delegated MCP

The local or hosted control plane delegates the actual remote MCP call to a hosted worker when:

- the operator explicitly allows hosted mode
- the target profile supports hosted execution
- policy allows the delegation
- a short-lived execution lease has been minted

Hosted mode is additive. It is not the hidden source of truth for local runs.

## Trust Tiers

The system should classify remote MCP profiles into durable trust tiers.

### `operator_owned`

Meaning:

- infrastructure, credentials, and registry ownership are under operator control

Default posture:

- existing MCP launch behavior

### `publisher_verified`

Meaning:

- the endpoint is public, but the publisher identity is cryptographically or operationally verified strongly enough for durable reuse

Examples:

- verified marketplace listing
- signed metadata bundle tied to the publisher
- enterprise internal server with verifiable issuer and ownership chain

Default posture:

- read-only tools may be policy-managed
- mutating tools still default to approval until a stronger policy says otherwise

### `operator_approved_public`

Meaning:

- public remote endpoint approved by the operator after review, but without stronger publisher verification

Default posture:

- read-only tools may run under `mcp.safe`
- mutation stays approval-first
- drift triggers quarantine

### `user_supplied_candidate`

Meaning:

- a person entered the endpoint or imported it, but no executable profile exists yet

Default posture:

- non-executable

### `agent_discovered_candidate`

Meaning:

- an agent proposed the endpoint based on instructions, browsing, or tool output

Default posture:

- non-executable
- never auto-promoted to mutating capability

## Candidate-First Registration Lifecycle

Remote/public MCP registration should be a pipeline, not a single write.

### 1. Candidate intake

A raw endpoint enters the system as a candidate with provenance:

- `operator_seeded`
- `user_input`
- `agent_discovered`
- `catalog_import`

The candidate stores:

- raw endpoint
- transport hint
- submitting session or run when available
- workspace scope when available
- submission time

At this point the candidate cannot execute anything.

### 2. Resolution

The resolver canonicalizes and inspects the candidate:

- normalize URL and transport
- enforce public HTTPS rules where applicable
- fetch MCP metadata and tool inventory through a constrained discovery path
- capture auth discovery metadata if present
- compute hashes for identity-relevant metadata and tool schemas

Resolution produces evidence, not trust.

### 3. Profile creation

A resolved candidate may create a durable server profile with:

- stable profile ID
- canonical endpoint
- trust tier
- allowed execution modes
- auth descriptor
- imported tool inventory snapshot
- drift baseline

Only profiles can become executable.

### 4. Approval

Approval should happen on the profile, not on the raw URL.

Approvers must see:

- candidate provenance
- endpoint and issuer identity
- transport type
- tool inventory snapshot
- mutation/read-only classification
- requested auth scopes
- execution modes requested

### 5. Credential binding

After approval, credentials are bound through the broker:

- browser-mediated OAuth session
- durable secret reference
- short-lived token exchange
- session-only token in degraded mode

The binding is independent from the tool inventory so auth can rotate without recreating the server profile.

### 6. Activation

The server profile becomes executable only after:

- approval is resolved
- required auth binding exists
- policy permits at least one execution mode
- drift state is clean

### 7. Continuous drift monitoring

The profile is monitored for:

- certificate or issuer changes
- auth discovery changes
- tool additions/removals
- schema hash changes
- side-effect metadata changes
- repeated protocol or auth failures

Material drift can move the profile to `quarantined`.

## Identity Model

Remote MCP identity should not rely on hostname alone.

The durable profile identity should include:

- canonical transport
- canonical endpoint URL
- normalized host and port
- TLS identity evidence for public HTTPS
- auth issuer and audience metadata when available
- publisher identity or attestation reference when available
- tool inventory hash set

The system should distinguish:

- endpoint identity
- publisher identity
- current auth issuer
- current tool inventory version

That separation matters because one can drift without the others.

## Trust Decision Model

Trust decisions should be explicit records, not implicit booleans on the server definition.

Each decision should encode:

- trust tier
- execution modes allowed
- max side-effect level allowed without approval
- reason codes
- approver identity
- validity window when appropriate
- re-review trigger conditions

Examples:

- allow read-only locally, ask on mutation
- deny hosted execution until publisher verification exists
- quarantine until auth issuer change is reviewed

## Auth Model

Remote/public MCP needs a stronger auth posture than today’s operator-owned path.

### Preferred auth order

1. browser-mediated OAuth 2.1 style flow with PKCE
2. broker-minted short-lived derived token
3. durable secret reference with explicit scope metadata
4. session-only token in degraded mode

### Hard rules

- the model never sees refresh tokens
- the agent never chooses token audiences or scopes without policy review
- hosted workers receive leases or derived tokens, not durable reusable secrets
- auth state is bound to a server profile, not copied into raw tool calls

## Execution Modes

Each executable server profile should declare one or both execution modes.

### `local_proxy`

Meaning:

- the local authority daemon opens the MCP client connection itself

Use when:

- the operator wants strict local-only governance
- credentials are locally available
- latency and egress are acceptable

### `hosted_delegated`

Meaning:

- a hosted worker performs the MCP call under a signed execution lease

Use when:

- the operator wants shared/team execution
- the local machine should not hold the upstream session directly
- the use case benefits from stable hosted connectivity or isolation

## Hosted Delegated Execution

Hosted execution should follow a strict lease-and-attestation model.

### Step 1. Local admission

The local authority or hosted authority admits the action through the normal policy path.

### Step 2. Lease minting

The broker and control plane mint a one-time execution lease that binds:

- `run_id`
- `action_id`
- server profile ID
- target tool name
- allowed endpoint set
- auth context reference
- time limit
- max artifact budget

### Step 3. Worker execution

The hosted worker:

- validates the lease
- resolves only the referenced server profile
- obtains scoped auth material
- executes `tools/list` or `tools/call`
- captures artifacts and structured output

### Step 4. Attested result return

The worker returns:

- execution result
- artifact manifest
- worker image/runtime identity
- signed attestation over the result bundle

### Step 5. Journal linkage

The authority records both:

- the decision to delegate
- the attested hosted result

This keeps execution provenance honest.

## Hosted Worker Isolation

Hosted delegated execution needs a stricter runtime than the local daemon.

Minimum baseline:

- per-tenant or stricter worker isolation
- ephemeral filesystem
- no inbound public listener beyond the control plane
- egress allowlist limited to target MCP hosts and required auth endpoints
- lease-scoped credentials only
- short worker lifetime
- auditable image digest and runtime version
- explicit concurrency, rate, and artifact budgets

Nice-to-have but not required for the first hosted slice:

- confidential compute
- hardware-backed attestation
- per-profile dedicated worker pools

## Tool Import And Drift Rules

Tool import is part of onboarding, not just execution.

The system should store an immutable imported snapshot containing:

- tool name
- input schema hash
- output schema hash when available
- annotations
- side-effect classification
- import time
- import source

Changes to imported tools should be compared against policy-sensitive fields.

High-signal drift examples:

- new tool appears
- read-only hint disappears
- schema expands to accept broader writes
- auth requirements change
- output structure changes in a way that weakens validation

## Policy Surface

`mcp.safe` needs to become trust-tier aware.

Recommended policy dimensions:

- trust tier
- execution mode
- side-effect level
- auth strength
- candidate provenance
- drift state
- publisher verification state
- workspace or org allowlist

Default rules:

- candidates are non-executable
- unresolved public profiles deny
- approved public read-only tools may allow
- public mutations ask
- hosted delegated execution requires explicit opt-in

## Evidence And Operator UX

Operators need enough detail to make good decisions without reading raw protocol traces.

Registration review should show:

- how the candidate entered the system
- what identity evidence was collected
- what tools were imported
- what auth flow is requested
- whether hosted mode is requested
- what changed since the last approval

Execution review should show:

- local vs hosted execution mode
- trust tier at execution time
- credential mode used
- any attestation verification state
- structured output summary

## Failure And Abuse Model

The design should handle at least these cases cleanly:

- user pastes a public MCP URL that later changes ownership
- agent discovers a malicious server and tries to register it during a run
- auth issuer rotates unexpectedly
- tool inventory changes to add mutating behavior
- hosted worker is healthy but attestation verification fails
- remote server asks for broader OAuth scope than previously approved
- same hostname serves different MCP identities over time

Failure posture:

- fail closed when identity, auth, or attestation confidence drops below the approved posture
- quarantine instead of silently refreshing trust
- preserve evidence for review

## Relationship To Hosted Boundary

This design must stay aligned with the local-first hosted boundary:

- local truth stays canonical for local runs
- hosted execution is optional and explicit
- synced hosted records preserve provenance
- secrets never sync in raw form

Hosted MCP should extend the product without moving the source of truth away from the local control plane.

## Recommended Rollout

### Phase 0. Current state

- operator-owned local registry
- operator-managed `stdio` and `streamable_http`

### Phase 1. Candidate registry and trust records

- candidate-first intake
- resolved server profiles
- trust decisions
- drift and quarantine states

### Phase 2. Local governed public MCP

- full approval flow for user and agent supplied servers
- brokered auth binding
- trust-tier-aware `mcp.safe`

### Phase 3. Hosted delegated execution

- leased hosted workers
- attested evidence bundles
- hosted-specific policy and limits

### Phase 4. Verified publisher ecosystem

- publisher verification
- catalog import
- reusable trust policies by publisher tier

## Bottom Line

Production-grade remote/public MCP is not “accept any URL and proxy it.”

It is:

- candidate-first registration
- durable profile identity
- explicit trust decisions
- brokered auth
- drift-aware tool import
- optional hosted delegated execution with signed evidence

That is the minimum shape required to make hosted MCP and arbitrary remote/public MCP registration production-real without weakening the product’s trust model.
