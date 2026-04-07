import type { PolicyConfig } from "@agentgit/schemas";

export const DEFAULT_POLICY_PACK: PolicyConfig = {
  profile_name: "coding-agent-v1",
  policy_version: "2026-04-01",
  thresholds: {
    low_confidence: [
      {
        action_family: "filesystem/*",
        ask_below: 0.3,
      },
      {
        action_family: "shell/*",
        ask_below: 0.3,
      },
      {
        action_family: "function/*",
        ask_below: 0.5,
      },
    ],
  },
  rules: [
    {
      rule_id: "platform.secret-paths.deny",
      description: "Deny governed access to protected secret paths.",
      rationale:
        "Known credential and secret files should never be automatically accessed through the governed runtime.",
      references: ["support-architecture/10-policy-hardening-and-defaults.md"],
      binding_scope: "platform_default",
      decision: "deny",
      enforcement_mode: "enforce",
      priority: 10_000,
      match: {
        type: "all",
        conditions: [
          {
            type: "field",
            field: "operation.domain",
            operator: "in",
            value: ["filesystem", "shell"],
          },
          {
            type: "field",
            field: "target.primary.type",
            operator: "eq",
            value: "path",
          },
          {
            type: "any",
            conditions: [
              {
                type: "field",
                field: "target.primary.locator",
                operator: "matches",
                value: "(^|/)\\.env(\\.[^/]+)?$",
              },
              {
                type: "field",
                field: "target.primary.locator",
                operator: "matches",
                value: "(^|/)\\.npmrc$",
              },
              {
                type: "field",
                field: "target.primary.locator",
                operator: "matches",
                value: "(^|/)\\.netrc$",
              },
              {
                type: "field",
                field: "target.primary.locator",
                operator: "matches",
                value: "(^|/)\\.ssh(/|$)",
              },
              {
                type: "field",
                field: "target.primary.locator",
                operator: "matches",
                value: "(^|/)\\.aws(/|$)",
              },
              {
                type: "field",
                field: "target.primary.locator",
                operator: "matches",
                value: "(^|/)\\.gnupg(/|$)",
              },
              {
                type: "field",
                field: "target.primary.locator",
                operator: "matches",
                value: "\\.(pem|key)$",
              },
            ],
          },
        ],
      },
      reason: {
        code: "PROTECTED_SECRET_PATH_DENIED",
        severity: "critical",
        message: "Protected secret paths are outside the governed auto-execution surface.",
      },
    },
    {
      rule_id: "platform.outside-workspace-paths.deny",
      description: "Deny governed access to explicit paths outside the governed workspace roots.",
      rationale:
        "Explicit access to paths outside the governed workspace roots breaks the local containment contract and must fail closed.",
      references: ["support-architecture/10-policy-hardening-and-defaults.md"],
      binding_scope: "platform_default",
      decision: "deny",
      enforcement_mode: "enforce",
      priority: 9_950,
      match: {
        type: "all",
        conditions: [
          {
            type: "field",
            field: "target.primary.type",
            operator: "eq",
            value: "path",
          },
          {
            type: "field",
            field: "target.scope.breadth",
            operator: "eq",
            value: "external",
          },
        ],
      },
      reason: {
        code: "PATH_NOT_GOVERNED",
        severity: "critical",
        message: "Explicit paths outside the governed workspace roots are denied.",
      },
    },
    {
      rule_id: "platform.agent-config-mutation.deny",
      description: "Deny agent mutation of authority and agent configuration surfaces.",
      rationale:
        "Agent-editable config and policy surfaces create a persistence and sandbox-escape vector and must be protected.",
      references: ["support-architecture/10-policy-hardening-and-defaults.md"],
      binding_scope: "platform_default",
      decision: "deny",
      enforcement_mode: "enforce",
      priority: 9_900,
      match: {
        type: "all",
        conditions: [
          {
            type: "field",
            field: "operation.domain",
            operator: "in",
            value: ["filesystem", "shell"],
          },
          {
            type: "field",
            field: "risk_hints.side_effect_level",
            operator: "in",
            value: ["mutating", "destructive"],
          },
          {
            type: "field",
            field: "target.primary.type",
            operator: "eq",
            value: "path",
          },
          {
            type: "any",
            conditions: [
              {
                type: "field",
                field: "target.primary.locator",
                operator: "matches",
                value: "(^|/)\\.claude(/|$)",
              },
              {
                type: "field",
                field: "target.primary.locator",
                operator: "matches",
                value: "(^|/)\\.codex(/|$)",
              },
              {
                type: "field",
                field: "target.primary.locator",
                operator: "matches",
                value: "(^|/)\\.agentgit(/|$)",
              },
              {
                type: "field",
                field: "target.primary.locator",
                operator: "matches",
                value: "(^|/)\\.mcp\\.json$",
              },
            ],
          },
        ],
      },
      reason: {
        code: "AGENT_CONFIG_MUTATION_DENIED",
        severity: "critical",
        message: "Agent configuration and authority-control surfaces may not be mutated automatically.",
      },
    },
  ],
};
