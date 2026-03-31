# Research Notes

## Scope

This note captures the external research used to shape the first plan for the Policy Engine subsystem.

Research date:

- March 29, 2026

## Key Findings

### 1. Host-side control is the right policy boundary

The MCP architecture spec explicitly puts policy and consent responsibilities in the host:

- hosts control client connection permissions and lifecycle
- hosts enforce security policies and consent requirements
- hosts handle user authorization decisions

Design implication:

- our policy engine belongs in the local authority layer, not inside arbitrary servers or tools

### 2. Human approval is a real primitive, but not the whole product

MCP tools guidance says there should always be a human in the loop for sensitive operations, and OpenAI HITL docs show durable pause/approve/resume flows with serialized state.

Design implication:

- `ask` should be a first-class durable outcome
- but policy should use it sparingly and reserve it for true consent boundaries

### 3. Existing guardrail systems are narrow

OpenAI Agents SDK docs clearly state that tool guardrails do not uniformly cover hosted tools or built-in execution tools like shell and computer use.

Design implication:

- our policy engine cannot depend on framework-native guardrail coverage
- it must consume our normalized action model instead

### 4. Ordered permission rules work

Claude Code’s permission system uses clear `allow`, `ask`, and `deny` rules, with ordered evaluation and deny-first precedence. Pre-tool hooks can still override or escalate before execution.

Design implication:

- use a deterministic layered rules engine
- keep precedence explicit and comprehensible

### 5. Credentials should be brokered and policy-aware

MCP elicitation guidance is explicit that third-party credentials must not transit through the MCP client and that the server must securely store and manage them. Claude Code also supports helper-based dynamic credential retrieval.

Design implication:

- brokered credentials should be a policy concept, not just an adapter implementation detail
- direct credential use on governed paths should be detectable and enforceable

### 6. State persistence affects policy design

OpenAI HITL docs note that paused runs, approvals, tool inputs, and tracing metadata can be serialized and resumed later.

Design implication:

- policy outputs and approval tasks need stable IDs and replay-safe structure
- any persisted context must be treated as persisted data, not temporary in-memory state

## Source Notes

### Model Context Protocol

- Architecture
  - Hosts enforce security policies and consent requirements.
  - <https://modelcontextprotocol.io/specification/2025-06-18/architecture>

- Tools
  - Human in the loop, input validation, access control, rate limiting, timeouts, and logging are all called out explicitly.
  - <https://modelcontextprotocol.io/specification/2025-03-26/server/tools>

- Elicitation
  - Third-party credentials should not pass through the client; the server must handle them directly and securely.
  - <https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation>

### OpenAI

- Agents guardrails (Python)
  - Input/output guardrails and workflow boundaries are useful patterns, but coverage is limited by tool type.
  - <https://openai.github.io/openai-agents-python/guardrails/>

- Agents HITL (Python)
  - Durable approval and resume semantics are directly relevant to `ask`.
  - <https://openai.github.io/openai-agents-python/human_in_the_loop/>

- Agents guardrails (JS)
  - Confirms built-in execution tools do not flow through the same tool-guardrail pipeline.
  - <https://openai.github.io/openai-agents-js/guides/guardrails/>

### Anthropic / Claude Code

- Settings
  - Permission rules use `allow`, `ask`, and `deny`, with deny-first ordered evaluation.
  - <https://code.claude.com/docs/en/settings>

- Hooks
  - `PreToolUse` supports `allow`, `deny`, and `ask`, can modify input, and blocks before execution.
  - <https://code.claude.com/docs/en/hooks>

- Authentication and credential handling
  - Dynamic credential helpers are a practical precedent for brokered or rotating credentials.
  - <https://code.claude.com/docs/en/team>

## Resulting Recommendation

The policy engine should be:

- deterministic
- layered
- deny-first and explanation-first
- capable of durable approval tasks
- aware of governed paths and credential modes
- biased toward `allow_with_snapshot` over unnecessary prompts
