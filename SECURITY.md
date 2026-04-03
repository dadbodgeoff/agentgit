# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest  | ✅        |

agentgit is pre-1.0. Only the most recent published version receives security fixes.

## Reporting a Vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**

Report security issues directly via [GitHub's private security advisory form](https://github.com/dadbodgeoff/agentgit/security/advisories/new).

Include:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- The affected package(s) and version(s)
- Any mitigations or workarounds you're aware of

You should receive an acknowledgment within 48 hours and a more detailed response within 5 business days.

## Security Model

agentgit is a **local-first** tool — the daemon runs on your machine and all data stays in `<project>/.agentgit/`. There is no cloud service, no remote data transmission, and no authentication server.

Key security boundaries:

- **Credentials** are stored in the OS keychain (not in the journal or filesystem) via `@agentgit/credential-broker`
- **Sensitive journal entries** are marked `sensitive_internal` and excluded from audit exports by default
- **MCP server trust decisions** require explicit operator approval before credentials are bound
- **Policy is fail-closed** — if the daemon is unreachable or policy evaluation fails, actions are denied

If you find a way to bypass policy, exfiltrate credentials, or escalate privileges through the daemon IPC, that's a high-severity finding we want to know about immediately.
