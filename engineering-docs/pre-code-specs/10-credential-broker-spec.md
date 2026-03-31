# 10. Credential Broker Spec

## Scope

This document resolves credential request/response protocol, secret storage, scope, and audit semantics.

## Credential Modes

- `brokered`
- `delegated`
- `direct`
- `none`

## Request Shape

- `request_id`
- `integration`
- `account_scope`
- `workspace_scope`
- `run_id` optional
- `adapter_kind`
- `action_kind`
- `ttl_hint`
- `reason`

## Handle Response

- `handle_id`
- `mode`
- `scope`
- `expires_at`
- `audit_ref`
- `injection_kind`

## Storage Strategy

- macOS: Keychain first
- Linux: Secret Service first
- Windows: Credential Manager / DPAPI first
- Fallback:
  - session-only credentials preferred
  - encrypted local envelope only when acceptable
  - otherwise fail closed for durable brokered mode

## Scope Axes

- integration
- account
- workspace
- run
- session
- adapter_kind
- action_kind

## Audit

Logged:

- handle ID
- integration
- adapter kind
- action ID
- scope summary
- timestamp

Never logged:

- raw token values
- passwords
- private keys
- refresh token bodies
