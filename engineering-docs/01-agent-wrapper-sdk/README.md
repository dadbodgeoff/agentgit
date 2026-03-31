# 01. Agent Wrapper / SDK

## Working Thesis

The agent wrapper should be a thin integration layer backed by a local authority daemon.

That means:

- the SDK is responsible for intercepting agent tool calls and forwarding them
- the daemon is responsible for decisions, snapshots, journaling, and execution dispatch
- the agent should never talk directly to side-effecting tools when a governed path exists

This keeps the product local-first, reduces language-specific drift, and gives us one real enforcement point instead of several partial ones.

## Why This Shape Wins

We need the wrapper to do four things well:

1. Integrate with real agent runtimes quickly
2. Intercept tool use before side effects happen
3. Work across different frameworks and languages
4. Feed one canonical downstream control pipeline

If we push too much logic into each SDK, the system fragments immediately.
If we make the daemon too smart too early, integrations become painful.

So the right split for v1 is:

- SDKs stay thin and framework-friendly
- the daemon owns the control plane logic
- adapters translate framework-specific events into our canonical runtime model

## Product Role

This subsystem is the ingress layer for the whole product.

Its job is to turn:

- agent runs
- tool registrations
- tool call attempts
- environment metadata
- approval interruptions

into a governed execution flow that downstream systems can reason about.

## Design Principles

### 1. No trusted side effects outside the wrapper

If a tool is not wrapped, it is outside the governance model.

For v1, that is acceptable as long as we are explicit about the trust boundary.

Mandatory tool wrapping is therefore a launch requirement for any surface we want to label as governed.

### 2. The SDK should feel native to each framework

Developers should be able to:

- wrap a function tool
- wrap a shell tool
- wrap a browser/computer tool
- expose or proxy an MCP server

without rewriting their application architecture.

### 3. One run model across frameworks

OpenAI Agents, MCP hosts, and coding-agent runtimes all have different concepts of runs and sessions. We need a single internal model so policy, snapshots, and recovery do not care which framework the action came from.

### 4. Governance must happen before execution

Observability-only hooks are not enough. The wrapper must be able to block, pause, simulate, or require a snapshot before the real side effect occurs.

### 5. Trust metadata, but never rely on it

Tool schemas, MCP annotations, roots, and read-only hints are useful signals, but not security boundaries.

### 6. Broker credentials at runtime where we own execution

When the runtime owns a tool or integration path, it should inject or delegate scoped credentials instead of handing raw durable secrets directly to the agent.

This is a launch concern for owned integrations, not a later enterprise-only feature.

## Research-Driven Constraints

### MCP is a protocol, not a sandbox

MCP’s host-client-server architecture is a great interoperability surface, but official MCP docs are very clear that:

- roots are a coordination mechanism, not a security boundary
- tool annotations are hints, not trustworthy enforcement inputs

This means our wrapper cannot treat MCP metadata as authoritative. It has to enforce policy itself.

### Existing agent SDK guardrails are partial

Current OpenAI Agents SDK docs show strong tracing and approval flows, but also note that tool guardrails apply only to function tools and do not cover hosted tools or built-in execution tools like shell, apply-patch, and computer tooling in the same way.

That is a big architectural signal:

- framework-native guardrails are useful integration points
- they are not enough to be the universal control layer

### Approval systems already exist, but recovery does not

Claude Code and OpenAI Agents already support approval-oriented workflows. That validates the wrapper approach, but it also reinforces the product direction:

- approvals are table stakes
- the differentiated layer is checkpointed, reversible execution

### Modern tool ecosystems are mixed-mode

Today’s agent environments mix:

- local tools
- hosted tools
- remote MCP servers
- custom function calls
- shell and browser harnesses

So the wrapper has to support both local runtime interception and remote tool proxying.

## Proposed v1 Architecture

## Launch Boundary Requirements

The current launch plan should explicitly include these two requirements:

### Mandatory tool wrapping

Any action surface we describe as governed must route through one of our wrapped execution paths:

- SDK-wrapped function tools
- governed shell execution
- governed filesystem helpers
- governed browser/computer harnesses
- governed MCP proxy paths

Anything else may be:

- observed
- imported
- unknown

but it should not be labeled governed.

### Credential brokering for owned integrations

For launch, the runtime should broker credentials for the integrations and adapters we directly own.

That includes:

- proxied MCP connections we initiate
- API-backed tools we wrap
- browser-backed sessions where auth can be runtime-mediated

This does not require a full vault product at launch. It does require that our governed execution paths do not depend on the agent holding broad reusable secrets whenever our runtime can inject scoped credentials instead.

## Components

### A. Local authority daemon

A long-lived local process that owns:

- run/session registration
- action admission
- policy requests
- snapshot triggers
- execution dispatch
- event emission

Recommended transport:

- Unix domain socket on macOS/Linux
- named pipe on Windows later

### B. Language SDKs

Thin SDKs for:

- TypeScript
- Python

Responsibilities:

- create and attach run context
- wrap framework-native tools
- stream tool attempts to the daemon
- surface approval interruptions back into the host framework
- translate results back into tool outputs
- request brokered credentials from the daemon for owned integrations when needed

### C. Framework adapters

The first adapters should target:

- OpenAI Agents Python
- OpenAI Agents TypeScript
- generic MCP host/proxy integration
- direct shell/filesystem/browser harnesses for local coding agents

### D. MCP proxy mode

For MCP specifically, we should support two modes:

1. `wrapServer`
   Expose our own governed MCP server to the agent and implement tools locally or through our adapters.

2. `proxyServer`
   Present a governed MCP server to the agent while acting as an MCP client to one or more upstream MCP servers.

`proxyServer` is important because it lets us:

- inspect tool metadata
- normalize tool calls
- apply policy before forwarding
- attach snapshots and journal events around the call

without requiring upstream MCP servers to know anything about our product.

## Canonical Runtime Objects

The wrapper layer should introduce these objects before the action normalizer gets involved downstream:

### `RunHandle`

- `run_id`
- `workflow_name`
- `agent_framework`
- `agent_name`
- `workspace_roots`
- `user_id` optional in local mode
- `trace_context`

### `ToolRegistration`

- `tool_id`
- `tool_name`
- `tool_kind`
- `framework_origin`
- `input_schema`
- `capability_hints`
- `execution_mode` local, remote, hosted, proxied

### `ToolCallAttempt`

- `attempt_id`
- `run_id`
- `tool_id`
- `raw_input`
- `call_site`
- `framework_metadata`
- `parent_step_id`
- `requested_at`

### `GovernanceEnvelope`

The SDK sends the daemon a single envelope that contains:

- run context
- tool registration reference
- raw call payload
- local environment metadata
- optional framework-native approval context

This becomes the boundary object that enters the rest of the system.

## Integration Surfaces To Support First

### 1. Wrapped function tools

This is the easiest place to start and gives us a clean interception point.

Developer experience should look like:

- register function as usual
- wrap with our SDK helper
- get governed execution automatically

### 2. Wrapped local shell tool

This is the most strategically important early integration because coding agents live here.

The SDK should:

- intercept the command request
- attach cwd, env policy, and declared intent
- send the request to the daemon
- only execute if the daemon returns a positive decision

### 3. Wrapped filesystem mutation helpers

Even if a framework already edits files directly, we should provide governed write helpers so local agents can opt into checkpoint-friendly file operations immediately.

### 4. Wrapped browser/computer harness

For browser agents, the wrapper should sit around the local computer/browser implementation, not just around the model call.

### 5. MCP proxy integration

This expands us from function tools into the broader agent ecosystem without needing every MCP server to adopt our SDK.

## Trust Model

### Trusted

- local authority daemon
- official SDK adapters we ship
- execution adapters that route through the daemon

### Semi-trusted

- MCP server metadata
- tool annotations like `readOnlyHint`
- tool schemas
- framework-provided tool categories

These are useful hints, but must be validated or treated conservatively.

### Untrusted

- arbitrary upstream MCP servers
- model-produced tool arguments
- tool descriptions claiming low risk
- filesystem roots as a hard boundary

## v1 Enforcement Promise

We should be honest about what we can enforce in the first version.

### Strongly governed in v1

- tools invoked through our SDK
- local shell commands routed through our wrapper
- local file mutations routed through our wrapper
- proxied MCP tool invocations routed through our server
- owned integrations executed with runtime-brokered credentials

### Partially governed in v1

- framework-hosted tools where the framework owns execution
- browser state recovery
- subprocesses spawned by already-approved commands

### Out of scope in v1

- actions taken outside wrapped integrations
- arbitrary OS-level escape prevention
- complete containment of malicious local code

## Developer Experience Proposal

## Minimal API shape

### Python sketch

```python
from authority import AuthorityClient, governed_tool, governed_shell

authority = AuthorityClient()

@governed_tool(authority=authority, kind="function")
async def create_ticket(title: str, body: str) -> str:
    ...

shell = governed_shell(authority=authority)
```

### TypeScript sketch

```ts
import { AuthorityClient, governedTool, governedShell } from "@authority/sdk";

const authority = new AuthorityClient();

const sendEmail = governedTool({
  authority,
  kind: "function",
  name: "send_email",
  description: "Send an email",
  parameters: emailSchema,
  execute: async (input) => {
    // actual implementation
  },
});

const shell = governedShell({ authority });
```

### MCP proxy sketch

```ts
import { proxyMcpServer } from "@authority/sdk/mcp";

await proxyMcpServer({
  authority,
  listen: "stdio",
  upstreamServers: [
    { name: "filesystem", command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] }
  ],
});
```

## Run Lifecycle

1. Host framework starts a governed run
2. SDK registers the run with the daemon
3. Wrapped tool invocation creates a `ToolCallAttempt`
4. SDK sends a `GovernanceEnvelope` to the daemon
5. Daemon returns:
   - allow
   - deny
   - ask
   - simulate
   - allow_with_snapshot
6. If approval is needed, the SDK maps that back into the host framework’s native interruption model where possible
7. If approved, execution proceeds through a governed adapter path
8. Result returns to the agent as a normal tool result

## Why A Daemon Beats SDK-Only Logic

- It gives us one place to implement policy, snapshots, and journaling.
- It keeps Python and TypeScript behavior aligned.
- It lets us add a local UI or CLI inspector later without instrumenting every framework separately.
- It creates a clean migration path to a hosted control plane without rewriting integrations.

## Main Risks

### 1. Bypass risk

If an agent can still access native unwrapped tools, governance becomes partial.

Mitigation:

- target frameworks where wrapped tools are normal
- make mandatory tool wrapping explicit in the product contract
- be explicit in docs about governed versus ungoverned surfaces
- eventually add stricter runtime modes

### 2. Framework mismatch

Every agent framework has different pause/resume and streaming semantics.

Mitigation:

- keep the SDK thin
- normalize into our own run model early
- adapt approvals per framework rather than forcing one universal host API

### 3. Hosted tool blind spots

Some tool ecosystems execute on provider infrastructure, not locally.

Mitigation:

- prefer local and proxied integrations in v1
- treat hosted tools as a later expansion area

### 4. Overpromising security

MCP roots, tool hints, or SDK callbacks do not equal real isolation.

Mitigation:

- position the wrapper as an execution authority layer for supported integrations
- combine with OS sandboxing later where possible

## Recommended Build Order

1. Build the local authority daemon API
2. Build mandatory tool-wrapping primitives for function tools, shell, and filesystem actions
3. Add basic credential brokering for owned integrations and proxied MCP connections
4. Build the TypeScript SDK with the wrapped-tool and brokered-credential contract
5. Build the Python SDK with the same contract
6. Add run registration and interruption mapping
7. Add MCP proxy mode
8. Add browser/computer harness wrapping

## Concrete Recommendation

For the first implementation pass, we should optimize for one thing:

**make a local coding agent route shell and file actions through a governed daemon without feeling unnatural to the developer**

To make that true at launch, the plan has to include:

- mandatory wrapping for every governed tool surface
- credential brokering for integrations we directly own

If we can do those well, we have the real spine of the product.

## Research Inputs

- MCP architecture overview: <https://modelcontextprotocol.io/docs/learn/architecture>
- MCP roots: <https://modelcontextprotocol.io/specification/2025-03-26/client/roots>
- MCP client concepts: <https://modelcontextprotocol.io/docs/learn/client-concepts>
- MCP tools spec: <https://modelcontextprotocol.io/specification/2025-06-18/server/tools>
- MCP authorization: <https://modelcontextprotocol.io/specification/draft/basic/authorization>
- MCP security best practices: <https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices>
- MCP transports: <https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>
- OpenAI Agents SDK overview: <https://openai.github.io/openai-agents-python/>
- OpenAI Agents SDK tools: <https://openai.github.io/openai-agents-python/tools/>
- OpenAI Agents SDK tracing: <https://openai.github.io/openai-agents-python/tracing/>
- OpenAI Agents SDK guardrails: <https://openai.github.io/openai-agents-python/guardrails/>
- OpenAI Agents SDK human-in-the-loop: <https://openai.github.io/openai-agents-python/human_in_the_loop/>
- OpenAI Agents SDK JS human-in-the-loop: <https://openai.github.io/openai-agents-js/guides/human-in-the-loop/>
- OpenAI function calling / structured outputs help article: <https://help.openai.com/en/articles/8555517-function-calling-in-the-openai-api>
- OpenAI Responses changelog: <https://developers.openai.com/api/docs/changelog>
- Anthropic Claude Code hooks: <https://docs.anthropic.com/en/docs/claude-code/hooks>
- Anthropic Claude Code IAM / permissions: <https://docs.anthropic.com/en/docs/claude-code/team>
- Anthropic sandboxing post: <https://www.anthropic.com/engineering/claude-code-sandboxing>
- OpenTelemetry trace semantics: <https://opentelemetry.io/docs/specs/semconv/general/trace/>
- OpenTelemetry tracing SDK: <https://opentelemetry.io/docs/specs/otel/trace/sdk/>
