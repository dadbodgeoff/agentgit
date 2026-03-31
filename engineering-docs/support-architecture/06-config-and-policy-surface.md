# 06. Config And Policy Surface

## Working Thesis

The product should have a small, layered, hand-inspectable configuration surface that cleanly separates durable user intent from transient runtime state.

That means:

- config should be readable and debuggable
- policy should be versioned and explicit
- safe modes should compile down to rules without hiding their source
- runtime overrides should be visible and temporary

The launch system should not require a hidden database just to understand what the user asked the product to do.

## Why This Matters

If config is too implicit:

- users cannot trust what the system will do
- support and debugging get much harder
- policy behavior feels magical

If config is too enterprise-heavy:

- the product becomes hard to adopt
- local-first usage becomes annoying

So the right launch design is:

**simple layered config with explicit policy sources**

## Config Layers

The runtime should layer config in this order:

### 1. System defaults

Shipped with the product.

Examples:

- default safe mode behavior
- default retention thresholds
- default capability fallbacks

### 2. User config

Durable preferences for the current user across workspaces.

Examples:

- preferred safe modes
- approval preferences
- default retention caps
- helper verbosity

### 3. Workspace config

Workspace-scoped preferences and policy rules.

Examples:

- writable roots
- workspace-specific safe mode
- allow/deny patterns for shell
- excluded paths for snapshots

### 4. Session/runtime overrides

Temporary changes for the current daemon session or run.

Examples:

- temporary maintenance disable
- temporary elevated debug logging
- run-scoped approval override

These should never silently mutate durable user/workspace config.

## Config Formats

### Launch recommendation

Use:

- TOML for durable config files
- JSON only for generated machine state where appropriate

Why TOML:

- easy to read and hand-edit
- comments are possible
- good fit for app config and rule lists
- already familiar in tool-heavy developer ecosystems

## File Layout

Suggested durable config files:

- `config_root/config.toml`
- `config_root/policies/defaults.toml`
- `config_root/policies/user.toml`
- optional workspace pointer or workspace-local file:
  - `.agentgit/policy.toml`
  - or a central workspace config referenced by workspace ID

Generated runtime state should live elsewhere, not inside config files.

## Config Domains

The config surface should be split into a few major domains.

### Runtime config

Examples:

- IPC settings
- maintenance thresholds
- storage budgets
- logging level

### Execution policy config

Examples:

- safe modes
- allow/deny/ask rules
- broker requirements
- external-domain rules

### Snapshot config

Examples:

- exclusion classes
- retention caps
- compaction thresholds
- max journal chain depth

### UI/helper config

Examples:

- helper answer style
- artifact preview policy
- timeline defaults

## Policy Representation

The policy engine needs a representation surface that users and the runtime can both understand.

### Launch recommendation

Represent policy as:

- named safe modes
- ordered rule sets
- budget definitions
- trust requirements

### High-level policy sections

- `[safe_modes]`
- `[budgets]`
- `[trust]`
- `[[rules]]`
- `[approvals]`
- `[snapshots]`

## Safe Modes

Safe modes are the product-facing surface.

Internally they should compile to rule bundles.

Examples:

- `filesystem.safe`
- `shell.safe`
- `browser.safe`
- `mcp.safe`

Important rule:

The compiled rules should be inspectable so the user is not forced to trust a hidden preset.

## Rule Model

The durable config surface should allow ordered rules with:

- ID
- description
- match predicate
- decision
- reason code
- priority or order

The config should not try to expose every internal heuristic.
It should expose the durable intent surface.

## Budget Surface

Budgets should be configurable in a human-readable way.

Examples:

- token cap per run
- spend cap per month
- max side-effecting actions per run
- max runtime duration

Each budget should declare:

- threshold
- enforcement level
  - informational
  - soft
  - hard

## Trust Surface

The config should allow explicit trust declarations.

Examples:

- trusted MCP servers
- allowed browser origins
- governed writable roots
- integrations requiring brokered credentials

This is one of the most important support structures because it determines where “governed” can truthfully apply.

## Runtime Overrides

Runtime overrides should be visible, scoped, and ephemeral.

Examples:

- CLI flag to disable noncritical maintenance for one session
- debug mode for helper explanations
- one-run approval stickiness

Rules:

- record override source
- show overrides in diagnostics
- do not silently persist them

## Migration Model

Config and policy should be versioned.

Recommended fields:

- `config_version`
- `policy_version`

Migration rules:

- on load, migrate or reject explicitly
- keep automatic migrations simple and auditable
- preserve comments and hand-edited intent when possible

## Validation

The runtime should validate config at startup and on reload.

Validation should catch:

- unknown keys in strict sections
- malformed rule predicates
- invalid safe mode references
- conflicting storage roots
- impossible budget thresholds

Bad config should fail safely and explain why.

## Reload Model

The authority daemon should support partial config reload.

### Safe to reload live

- helper defaults
- maintenance thresholds
- some policy rules

### Require careful coordination

- storage roots
- IPC endpoint changes
- schema/storage version changes

### Runtime recommendation

Use:

- explicit reload command
- file-watch-assisted prompt later if useful

Do not rely on silent auto-reload for sensitive policy changes at launch.

## Workspace Config Strategy

There are two plausible models:

### Central-only workspace config

Pros:

- authority owns truth
- simpler migrations

Cons:

- less discoverable inside the repo

### Optional workspace-local file plus central cache

Pros:

- visible in repo
- easier onboarding for a team

Cons:

- needs conflict handling with user config

### Launch recommendation

Support:

- central durable workspace config
- optional lightweight workspace-local policy file for discoverability and portability

The central store remains authoritative once loaded.

## Diagnostics

The CLI and UI should be able to answer:

- which config files are active?
- which rules matched?
- which safe mode compiled into which rules?
- what runtime overrides are active?
- what config version is loaded?

This is essential for trust.

## Launch Recommendation

For launch, the config and policy surface should be:

- TOML-based
- layered
- inspectable
- versioned
- explicit about source and override precedence

That gives users enough control without turning the product into a policy-language project.
