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

- **Credentials** are stored in the OS keychain where keychain-backed brokers are implemented. Some integration metadata still lives in encrypted local state, so treat local state protection as part of the credential boundary.
- **Sensitive journal entries** are marked `sensitive_internal` and excluded from audit exports by default
- **MCP server trust decisions** require explicit operator approval before credentials are bound
- **Policy evaluation failures are fail-closed.** Do not assume every daemon transport outage is denied unless the current release notes and tests explicitly say so.

If you find a way to bypass policy, exfiltrate credentials, or escalate privileges through the daemon IPC, that's a high-severity finding we want to know about immediately.
