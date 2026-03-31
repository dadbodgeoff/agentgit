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
