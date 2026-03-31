# 03. Credential Broker

## Working Thesis

The credential broker should expose scoped runtime handles to owned integrations while keeping raw secrets out of agent-visible paths and general-purpose application storage.

That means:

- adapters ask the broker for access, not for raw secrets whenever possible
- the broker enforces scope, lifetime, and policy labels
- local secret storage should prefer OS-native facilities
- the broker should produce auditable metadata without leaking the secret itself

The launch goal is not “build a vault.”
The goal is:

**make governed integrations work without teaching the agent durable secrets**

## Why This Matters

If the broker is too weak:

- the agent ends up holding raw credentials
- attribution and revocation get worse
- trust claims become thin

If the broker is too ambitious:

- launch scope explodes into a secrets platform
- local-first usability suffers

So the launch design should be:

**small broker, strong scoping, OS-native storage when possible**

## Credential Modes

The broker should support the same modes exposed in the action and execution models:

### `brokered`

The adapter receives:

- an ephemeral token
- a signed request
- a short-lived session credential
- or a handle usable only through the authority runtime

This is the preferred launch mode.

### `delegated`

The adapter receives a handle that allows it to call another trusted component which uses the real secret.

Useful for:

- MCP upstream sessions
- browser auth helpers
- local signing/delegation shims

### `direct`

The adapter is allowed to use directly stored credentials only when policy explicitly permits it.

This should be the exception path, not the default.

### `none`

No credential material is needed.

## Threat Model

The broker should assume:

- the model may propose actions using sensitive integrations
- prompts and tool inputs may be inspected or logged elsewhere
- artifacts and journals must not become a shadow secret store
- local compromise is possible, so minimize plaintext secret exposure and lifetime

The broker is not trying to solve full endpoint compromise.
It is trying to minimize unnecessary secret spread within the product boundary.

## What The Broker Must Do

- register integrations and credential scopes
- acquire credentials from local secret sources
- mint runtime handles or ephemeral tokens where supported
- inject credentials into adapters safely
- record safe audit metadata
- support revoke, rotate, and expire semantics

## What It Must Not Do

- return raw secrets to the model
- store secrets in the run journal
- leak secrets through helper or timeline surfaces
- overpromise machine-to-machine security across different hosts at launch

## Secret Sources

The broker should support several source classes.

### 1. OS-native secure store

Preferred source for durable local secrets.

Examples:

- macOS Keychain
- Windows Credential Manager or DPAPI-protected storage
- Secret Service / libsecret on Linux desktops

### 2. User-supplied session secret

For flows where the user authorizes access for the current session only.

Examples:

- paste token once for this session
- browser-mediated OAuth flow yielding short-lived credentials

### 3. Derived or minted runtime credentials

Examples:

- short-lived access tokens from a refresh token
- signed request tokens
- per-run scoped delegation handles

This is often the cleanest path when upstream APIs support it.

## Storage Strategy

### Preferred launch rule

Do not build a custom plaintext local secret database.

Instead:

- macOS: prefer Keychain Services
- Windows: prefer Credential Management and/or DPAPI-protected storage
- Linux desktop: prefer Secret Service-compatible storage when available

Fallback:

- encrypted local secret envelope using OS-provided primitives when possible
- if no secure local storage exists, require session-only credentials and degrade capability honestly

Launch note:

- `get_capabilities` should surface this launch broker posture explicitly as a degraded host capability rather than implying secure-store support that does not yet exist

## Platform Notes

### macOS

Apple guidance is straightforward:

- Keychain is intended for passwords, keys, and other small secret material
- untrusted apps should not have access to data stored there without authorization rules

Launch recommendation:

- use Keychain for durable local refresh tokens, API tokens, and broker master secrets if needed

### Windows

Windows provides two useful primitives:

- Credentials Management API
- DPAPI via `CryptProtectData`

DPAPI is especially useful for protecting local secret material so that the same user on the same machine can decrypt it.

Launch recommendation:

- use Credential Manager where it fits the UX
- use DPAPI-protected local envelopes when durable machine-local secret storage is needed

### Linux

On Linux desktops, the best fit is usually Secret Service-compatible storage such as GNOME Keyring/KWallet ecosystems.

Launch recommendation:

- use Secret Service when available
- if unavailable, fall back to session-only credentials or an explicit degraded mode

## Broker Object Model

The broker should reason in terms of:

### `CredentialProfile`

Defines:

- integration name
- auth type
- storage source
- supported scopes
- rotation rules

### `CredentialHandle`

Represents:

- a runtime-safe reference usable by adapters
- scope and expiry
- audit-safe metadata

### `CredentialLease`

Represents:

- a time-bounded grant for a specific action, run, or session

This is a useful launch concept because adapters rarely need indefinite access.

## Scope Model

Credentials should be scoped as tightly as possible.

Possible scope axes:

- integration
- account
- workspace
- run
- session
- adapter kind
- action kind

Examples:

- browser adapter may use an auth session for one origin only
- API adapter may get a short-lived token for one service and one account
- MCP proxy may get an upstream server credential profile but only use it inside the proxy

## Broker API Surface

The authority runtime should expose internal broker operations roughly like:

- `register_credential_profile`
- `resolve_credential_handle`
- `mint_lease`
- `revoke_lease`
- `rotate_profile`
- `get_broker_metadata`

Adapters should never need general secret-browsing APIs.

## Injection Model

The adapter should receive one of:

- environment injection for a child process when safe
- HTTP header injection inside the adapter
- browser session cookie/context injection
- signed request callback
- opaque handle usable only through a local helper

Preferred order:

1. opaque handle
2. signed or derived ephemeral token
3. tightly scoped environment injection
4. direct secret injection only if unavoidable and policy-approved

## Audit Model

The broker should log metadata such as:

- credential profile ID
- credential mode
- lease ID
- scope labels
- issued-at and expires-at

It should never log:

- raw token values
- passwords
- refresh tokens
- private keys

## Rotation And Expiry

The broker should distinguish:

### Expiry

- credential becomes invalid naturally after time

### Revocation

- broker or user intentionally invalidates it

### Rotation

- new credential replaces old one while preserving integration identity

The launch product does not need full enterprise rotation orchestration, but it does need clear local semantics for these states.

## Failure Modes

### Broker unavailable

Impact:

- governed actions requiring brokered credentials should fail closed or become `ask` depending on policy

### Secret store unavailable

Impact:

- durable brokered mode may degrade
- session-only mode may still work

### Expired credential

Impact:

- adapter should fail with a typed auth error
- broker may attempt refresh if allowed

### Revoked credential

Impact:

- action should not silently retry forever
- helper and diagnostics should show that auth state changed

## Launch Scope Recommendation

At launch, support these credential categories well:

- HTTP/API bearer tokens
- OAuth-style refresh/access token pairs where practical
- browser auth session handoff
- MCP upstream credentials for proxied servers

Defer for later:

- complex enterprise SSO brokers
- team-shared credential orchestration
- hardware-backed enterprise key flows

## Degraded Modes

If no secure local storage exists:

- allow session-only credentials
- mark the integration as degraded
- tighten policy where appropriate

The product should prefer honest degraded capability over a fake secure store.

## Launch Recommendation

For launch, the strongest broker architecture is:

- OS-native secret storage first
- scoped credential handles and leases
- no raw secret return to model-visible paths
- audit metadata without secret leakage
- explicit degraded mode where the platform cannot support strong brokering

## Source Inputs

- Apple keychain and crypto services guidance: <https://developer.apple.com/library/archive/documentation/Security/Conceptual/cryptoservices/KeyManagementAPIs/KeyManagementAPIs.html>
- Apple cryptographic services overview: <https://developer.apple.com/library/archive/documentation/Security/Conceptual/cryptoservices/Introduction/Introduction.html>
- Windows Credentials Management: <https://learn.microsoft.com/en-us/windows/win32/secauthn/credentials-management>
- Windows DPAPI `CryptProtectData`: <https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata>
- Secret Service API draft: <https://specifications.freedesktop.org/secret-service/latest/>
- libsecret simple API: <https://gnome.pages.gitlab.gnome.org/libsecret/libsecret-simple-api.html>
