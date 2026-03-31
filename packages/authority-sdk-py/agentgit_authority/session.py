"""Session and run registration helpers for the Python authority SDK."""

from __future__ import annotations

from .types import JSONObject


def build_register_run_payload(
    workflow_name: str,
    workspace_roots: list[str],
    *,
    agent_framework: str = "python",
    agent_name: str = "agentgit-py",
    client_metadata: JSONObject | None = None,
    budget_config: JSONObject | None = None,
) -> JSONObject:
    payload: JSONObject = {
        "workflow_name": workflow_name,
        "agent_framework": agent_framework,
        "agent_name": agent_name,
        "workspace_roots": workspace_roots,
    }

    if client_metadata is not None:
        payload["client_metadata"] = client_metadata

    if budget_config is not None:
        payload["budget_config"] = budget_config

    return payload
