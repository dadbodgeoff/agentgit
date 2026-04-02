# 14. Hosted MCP And Remote Trust Spec

## Scope

This document resolves the implementation-shaping decisions for:

- hosted delegated MCP execution
- user-supplied and agent-supplied remote/public MCP registration
- durable remote trust records
- auth binding for public remote MCP
- drift, quarantine, and re-approval behavior

This spec is additive to the current launch-real MCP slice. It does not change the audited claim for what is already built.

## Objectives

- preserve the local-first authority model
- allow arbitrary remote/public MCP discovery without allowing arbitrary execution
- make trust decisions durable, inspectable, and revocable
- support hosted execution without leaking credentials or losing provenance
- keep policy, registry, auth, and execution responsibilities separated cleanly

## Non-Goals

- replacing local canonical truth for local runs
- blind auto-trust of public MCP servers
- general plugin marketplace semantics
- unaudited secret pass-through from model to remote server

## Execution Modes

Executable server profiles may declare:

- `local_proxy`
- `hosted_delegated`

Rules:

- every server profile must support at least one mode before activation
- `hosted_delegated` requires explicit policy opt-in
- raw candidates support no execution mode

## Candidate And Profile Records

### `McpServerCandidate`

Purpose:

- persist raw remote/public MCP proposals without making them executable

Required fields:

- `candidate_id`
- `source_kind`:
  - `operator_seeded`
  - `user_input`
  - `agent_discovered`
  - `catalog_import`
- `submitted_at`
- `raw_endpoint`
- `transport_hint`
- `workspace_id` optional
- `submitted_by_session_id` optional
- `submitted_by_run_id` optional
- `notes` optional
- `resolution_state`

`resolution_state` enum:

- `pending`
- `resolved`
- `failed`
- `superseded`

Rules:

- candidates are never executable
- candidate deletion must not delete previously derived approved profiles automatically

### `McpServerProfile`

Purpose:

- durable executable identity for a resolved MCP server

Required fields:

- `server_profile_id`
- `candidate_id` optional
- `display_name`
- `transport`
- `canonical_endpoint`
- `network_scope`
- `trust_tier`
- `status`
- `allowed_execution_modes`
- `auth_descriptor`
- `identity_baseline`
- `tool_inventory_version`
- `created_at`
- `updated_at`

`trust_tier` enum:

- `operator_owned`
- `publisher_verified`
- `operator_approved_public`

`status` enum:

- `draft`
- `pending_approval`
- `active`
- `quarantined`
- `revoked`

Rules:

- only profiles may be activated
- `status = active` requires approval, valid auth posture, and clean drift state
- profiles derived from `agent_discovered` candidates cannot skip `pending_approval`

### `McpIdentityBaseline`

Purpose:

- capture the fields that define identity and drift comparisons

Required fields:

- canonical host and port
- transport
- TLS identity summary for public HTTPS
- auth issuer metadata when available
- publisher identity metadata when available
- tool inventory hash
- metadata fetch time

## Trust Decisions

### `McpTrustDecision`

Purpose:

- durable policy-adjacent record describing what has been approved for a profile

Required fields:

- `trust_decision_id`
- `server_profile_id`
- `decision`
- `reason_codes`
- `approved_by`
- `approved_at`
- `valid_until` optional
- `reapproval_triggers`

`decision` enum:

- `deny`
- `allow_read_only`
- `allow_policy_managed`
- `mutations_require_approval`

Rules:

- trust decisions are separate from runtime execution decisions
- execution policy consumes the active trust decision plus current action context
- profile status must move to `quarantined` if reapproval triggers fire

## Credential Binding

### `McpCredentialBinding`

Purpose:

- bind a server profile to brokered auth without storing secrets in the profile

Required fields:

- `credential_binding_id`
- `server_profile_id`
- `binding_mode`
- `broker_profile_id`
- `scope_labels`
- `audience`
- `created_at`
- `updated_at`
- `status`

`binding_mode` enum:

- `oauth_session`
- `derived_token`
- `bearer_secret_ref`
- `session_token`
- `hosted_token_exchange`

`status` enum:

- `active`
- `expired`
- `revoked`
- `degraded`

Rules:

- raw credentials never appear in journaled profile records
- `session_token` must be marked degraded
- hosted execution must not require the worker to browse arbitrary secret state

## Hosted Execution Lease

### `HostedMcpExecutionLease`

Purpose:

- authorize one hosted delegated execution

Required fields:

- `lease_id`
- `run_id`
- `action_id`
- `server_profile_id`
- `tool_name`
- `auth_context_ref`
- `allowed_hosts`
- `issued_at`
- `expires_at`
- `artifact_budget`
- `single_use`

Rules:

- leases are one-time use
- expired leases fail closed
- the worker may not widen host scope, tool scope, or auth scope

### `HostedMcpExecutionAttestation`

Purpose:

- bind hosted results to worker identity and a verifiable bundle hash

Required fields:

- `attestation_id`
- `lease_id`
- `worker_runtime_id`
- `worker_image_digest`
- `started_at`
- `completed_at`
- `result_hash`
- `artifact_manifest_hash`
- `signature`

Rules:

- attestation verification failure marks the result non-governed for trust purposes and blocks automatic success handling for mutating actions
- attestation artifacts must link back to the original `action_id`

## Registration Pipeline

### Step 1. Candidate submission

New daemon method:

- `submit_mcp_server_candidate`

Input:

- raw endpoint or server descriptor
- source metadata
- optional workspace scope

Behavior:

- validate shape only
- persist candidate
- do not create executable registration

### Step 2. Candidate resolution

New daemon method:

- `resolve_mcp_server_candidate`

Behavior:

- canonicalize endpoint
- enforce transport rules
- fetch discovery metadata through constrained networking
- fetch tool inventory snapshot
- compute identity baseline
- create or update draft profile

Rules:

- resolution success does not activate execution
- resolution failure records typed diagnostics

### Step 3. Approval

New daemon method:

- `approve_mcp_server_profile`

Behavior:

- attach trust decision
- optionally restrict execution modes
- optionally restrict max side-effect level

Rules:

- operator or authorized approver identity must be recorded
- profile remains non-active until credential binding and drift checks pass

### Step 4. Credential binding

New daemon methods:

- `bind_mcp_server_credentials`
- `revoke_mcp_server_credentials`

Behavior:

- create or update credential binding
- validate binding mode against profile and execution modes

Rules:

- public HTTPS profiles must not activate without supported auth posture when auth is required
- hosted delegated profiles must support lease-safe auth

### Step 5. Activation

New daemon method:

- `activate_mcp_server_profile`

Activation preconditions:

- `status = pending_approval` or `draft`
- active trust decision exists
- required credential binding exists
- drift state clean
- at least one execution mode allowed

### Step 6. Quarantine and revocation

New daemon methods:

- `quarantine_mcp_server_profile`
- `revoke_mcp_server_profile`

Rules:

- quarantine preserves history and evidence
- revoked profiles cannot be reactivated without explicit re-approval

## Execution Admission Rules

### Raw candidate execution

Rule:

- any action targeting a candidate instead of an active profile returns `PRECONDITION_FAILED`

### Trust-tier defaults

- `operator_owned`
  - current MCP launch behavior
- `publisher_verified`
  - read-only may be policy-managed
  - mutation defaults to `ask`
- `operator_approved_public`
  - read-only may allow
  - mutation requires `ask`

### Candidate provenance rules

- `agent_discovered` candidates may be resolved automatically if policy allows discovery, but activation still requires approval
- `agent_discovered` profiles cannot receive mutation auto-allow from discovery alone

### Hosted delegated rules

- requires profile support for `hosted_delegated`
- requires valid credential binding compatible with leases
- requires hosted capability health
- requires attestation verification on result ingest

## Action Model Additions

Normalized MCP actions should add:

- `server_profile_id`
- `candidate_id` optional for onboarding flows
- `execution_mode_requested`
- `trust_tier_at_submit`
- `drift_state_at_submit`
- `credential_binding_mode` optional

Rules:

- executable MCP actions must reference `server_profile_id`
- onboarding flows may reference `candidate_id` but do not produce executable MCP side effects

## Tool Inventory Import Rules

Imported tool inventory snapshots must capture:

- tool name
- input schema hash
- output schema hash when available
- side-effect classification
- annotations
- import timestamp

Material drift triggers:

- tool added or removed
- schema hash changed
- side-effect classification changed
- auth metadata changed

Material drift behavior:

- set profile status to `quarantined`
- prevent mutation execution
- optionally permit read-only execution only if policy explicitly allows stale-read posture

## Hosted Worker Rules

Hosted workers must enforce:

- lease validation before any network call
- egress restriction to approved hosts and auth endpoints
- ephemeral local storage
- bounded artifact capture
- explicit timeout budget
- result bundling with attestation

Hosted workers must not:

- persist raw credentials after execution
- widen tool scope
- fetch arbitrary remote MCP profiles
- mutate trust records directly

## Journal And Event Additions

Add event types:

- `mcp_candidate_submitted`
- `mcp_candidate_resolved`
- `mcp_profile_approved`
- `mcp_profile_activated`
- `mcp_profile_quarantined`
- `mcp_profile_revoked`
- `mcp_credential_bound`
- `mcp_hosted_lease_issued`
- `mcp_hosted_result_ingested`
- `mcp_drift_detected`

Rules:

- every hosted delegated action must record both delegation and result ingest events
- every quarantine must include drift reasons

## Policy Rules

`mcp.safe` compilation should gain predicates for:

- `trust_tier`
- `execution_mode_requested`
- `profile_status`
- `candidate_source_kind`
- `drift_state`
- `credential_binding_mode`

Default compiled rules:

- deny unresolved candidates
- deny inactive or revoked profiles
- ask on public mutation
- require explicit opt-in for hosted delegated execution
- deny direct credentials on governed remote/public paths

## Diagnostics And Capability Surface

`get_capabilities` should report:

- candidate registry availability
- hosted delegated execution availability
- hosted attestation verification availability
- supported auth binding modes
- degraded credential posture

Diagnostics should surface:

- active profile count by trust tier
- quarantined profile count
- profiles with expired bindings
- profiles with unresolved drift
- hosted execution health

## Error Handling

Recommended typed failure cases:

- `MCP_CANDIDATE_NOT_EXECUTABLE`
- `MCP_PROFILE_NOT_ACTIVE`
- `MCP_PROFILE_QUARANTINED`
- `MCP_PROFILE_REAPPROVAL_REQUIRED`
- `MCP_HOSTED_LEASE_INVALID`
- `MCP_HOSTED_ATTESTATION_INVALID`
- `MCP_REMOTE_IDENTITY_CHANGED`
- `MCP_AUTH_BINDING_MISSING`
- `MCP_AUTH_SCOPE_EXPANDED`

Mapping:

- lifecycle and state failures -> `PRECONDITION_FAILED`
- policy refusals -> `POLICY_BLOCKED`
- remote transport issues -> `UPSTREAM_FAILURE`

## Security Invariants

- candidate submission never implies execution permission
- executable server state is derived from profile approval, not raw input
- no raw secrets in candidates, profiles, trust decisions, or hosted result bundles
- hosted workers use scoped leases only
- attestation verification is required before treating hosted mutation execution as governed success
- material drift cannot silently refresh trust

## Rollout Order

1. Add candidate/profile/trust/credential schemas and durable storage.
2. Add candidate submission and resolution APIs.
3. Add approval, activation, quarantine, and drift handling.
4. Add trust-tier-aware policy predicates.
5. Add hosted lease issuance and attested result ingest.
6. Add hosted worker runtime and operational guardrails.

## Exit Criteria

This area is production-ready when:

- arbitrary user or agent supplied remote MCP endpoints can be proposed safely
- no raw candidate can execute before resolution and approval
- public remote auth is brokered and scoped
- trust drift produces quarantine instead of silent continuation
- hosted execution returns verifiable evidence linked to the original action
- policy, diagnostics, and operator UX make the trust posture understandable at decision time
