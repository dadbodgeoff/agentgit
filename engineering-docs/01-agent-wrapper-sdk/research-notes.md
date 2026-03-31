# Research Notes

## Scope

This note captures the external research used to shape the first plan for the Agent Wrapper / SDK subsystem.

Research date:

- March 29, 2026

## Key Findings

### 1. MCP gives us interoperability, not enforcement

Official MCP materials are useful for integration design, but they repeatedly separate coordination from hard security:

- the host creates an MCP client per server
- local servers commonly use `stdio`
- remote servers commonly use Streamable HTTP
- roots help scope work, but are not a hard security boundary
- tool annotations like `readOnlyHint` and `destructiveHint` are hints, not trustworthy enforcement primitives

Design implication:

- our wrapper must enforce policy itself
- MCP metadata should feed risk decisions, not replace them

### 2. Approval-only patterns are already mainstream

OpenAI Agents SDK and Claude Code both already provide approval-style interruption flows.

Design implication:

- a pure approval product will look derivative
- our moat should come from the recoverability layer, not just permission prompts

### 3. Existing guardrails do not cover every tool surface equally

OpenAI Agents SDK documentation explicitly says function-tool guardrails do not uniformly cover hosted tools and built-in execution tools.

Design implication:

- framework-native hooks are useful integration points
- they are not sufficient as the universal policy boundary
- our wrapper has to sit around execution-capable surfaces, not just function definitions

### 4. Tool ecosystems are increasingly heterogeneous

Current agent systems mix:

- JSON-schema function calling
- plaintext custom tools
- local execution harnesses
- remote MCP servers
- hosted provider tools

Design implication:

- the wrapper needs one canonical ingress contract for tool attempts
- normalization starts at the wrapper boundary, not later

### 5. The strongest local-first boundary is still a daemon plus wrapped tools

MCP transports, Claude Code sandboxing, and SDK-specific approval callbacks all point in the same direction:

- use narrow integration points
- centralize decision-making
- keep the actual side-effecting path under one controllable runtime

Design implication:

- ship a local authority daemon
- keep framework SDKs thin

## Source Notes

### Model Context Protocol

- Architecture overview
  - Host/client/server split and transport layer are directly relevant to MCP proxy mode.
  - <https://modelcontextprotocol.io/docs/learn/architecture>

- Client concepts
  - Roots are advisory and best for accident prevention, not malicious containment.
  - <https://modelcontextprotocol.io/docs/learn/client-concepts>

- Roots specification
  - Good fit for workspace scoping metadata, but not as an enforcement primitive.
  - <https://modelcontextprotocol.io/specification/2025-03-26/client/roots>

- Tools specification
  - Human-in-the-loop is recommended, but tool annotations are untrusted unless from trusted servers.
  - <https://modelcontextprotocol.io/specification/2025-06-18/server/tools>

- Authorization
  - HTTP-based MCP should use OAuth 2.1-style auth, discovery, PKCE, and audience-bound tokens.
  - `stdio` is a different world and typically uses environment-based credentials.
  - <https://modelcontextprotocol.io/specification/draft/basic/authorization>

- Security best practices
  - Confused deputy and token-handling concerns matter a lot if we proxy remote MCP servers.
  - <https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices>

- Transports
  - `stdio` remains important for local-first developer workflows.
  - Streamable HTTP is the current remote transport shape.
  - <https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>

### OpenAI Agent Surfaces

- Agents SDK overview
  - Confirms current agent SDKs already include tracing, HITL, sessions, and tool orchestration.
  - <https://openai.github.io/openai-agents-python/>

- Tools guide
  - Shows mixed local and hosted tool categories and confirms local harness patterns for shell/computer/apply-patch.
  - <https://openai.github.io/openai-agents-python/tools/>

- Guardrails
  - Confirms tool guardrails do not universally apply across all tool types.
  - <https://openai.github.io/openai-agents-python/guardrails/>

- Human-in-the-loop
  - Confirms interruption + resume is a real pattern we can map into.
  - <https://openai.github.io/openai-agents-python/human_in_the_loop/>
  - <https://openai.github.io/openai-agents-js/guides/human-in-the-loop/>

- Tracing
  - Confirms that agent runs, tool calls, and handoffs are already span-shaped, which aligns well with our run journal and OTel integration.
  - <https://openai.github.io/openai-agents-python/tracing/>

- Function calling
  - Structured Outputs with `strict: true` reduce schema drift for JSON tools.
  - <https://help.openai.com/en/articles/8555517-function-calling-in-the-openai-api>

- Changelog / current platform direction
  - Remote MCP, code interpreter, and execution-oriented tools are part of the current Responses API direction.
  - <https://developers.openai.com/api/docs/changelog>

### Anthropic / Claude Code

- Hooks reference
  - Strong evidence that pre-tool hooks are a practical and important interception point.
  - <https://docs.anthropic.com/en/docs/claude-code/hooks>

- Team / permissions docs
  - Shows allow/ask/deny rules and tool-specific approval logic as a mainstream model in coding agents.
  - <https://docs.anthropic.com/en/docs/claude-code/team>

- Sandboxing post
  - Validates the move away from prompt-heavy approval toward bounded autonomy.
  - <https://www.anthropic.com/engineering/claude-code-sandboxing>

### Observability

- OpenTelemetry trace semantic conventions
  - Useful for aligning span attributes across languages.
  - <https://opentelemetry.io/docs/specs/semconv/general/trace/>

- OpenTelemetry tracing SDK
  - Useful for exporter and processor design later.
  - <https://opentelemetry.io/docs/specs/otel/trace/sdk/>

## Resulting Recommendation

The wrapper should be implemented as:

- a local authority daemon
- thin TypeScript and Python SDKs
- adapter-based framework integrations
- an MCP proxy path for broader ecosystem coverage

This gives us a realistic v1 enforcement surface without pretending protocol metadata or framework callbacks are stronger than they actually are.
