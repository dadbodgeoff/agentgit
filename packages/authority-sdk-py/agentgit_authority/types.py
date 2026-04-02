"""Type aliases for the Python authority SDK."""

from __future__ import annotations

from typing import Literal, TypeAlias

JSONScalar: TypeAlias = str | int | float | bool | None
JSONValue: TypeAlias = JSONScalar | list["JSONValue"] | dict[str, "JSONValue"]
JSONObject: TypeAlias = dict[str, JSONValue]

ClientType: TypeAlias = Literal["sdk_ts", "sdk_py", "cli", "ui"]
MethodName: TypeAlias = Literal[
    "hello",
    "register_run",
    "get_run_summary",
    "get_capabilities",
    "get_effective_policy",
    "validate_policy_config",
    "get_policy_calibration_report",
    "explain_policy_action",
    "get_policy_threshold_recommendations",
    "replay_policy_thresholds",
    "list_mcp_servers",
    "list_mcp_server_candidates",
    "submit_mcp_server_candidate",
    "list_mcp_server_profiles",
    "resolve_mcp_server_candidate",
    "list_mcp_server_trust_decisions",
    "approve_mcp_server_profile",
    "list_mcp_server_credential_bindings",
    "bind_mcp_server_credentials",
    "revoke_mcp_server_credentials",
    "activate_mcp_server_profile",
    "quarantine_mcp_server_profile",
    "revoke_mcp_server_profile",
    "upsert_mcp_server",
    "remove_mcp_server",
    "list_mcp_secrets",
    "upsert_mcp_secret",
    "remove_mcp_secret",
    "list_mcp_host_policies",
    "upsert_mcp_host_policy",
    "remove_mcp_host_policy",
    "diagnostics",
    "run_maintenance",
    "submit_action_attempt",
    "list_approvals",
    "query_approval_inbox",
    "resolve_approval",
    "query_timeline",
    "query_helper",
    "query_artifact",
    "plan_recovery",
    "execute_recovery",
]
