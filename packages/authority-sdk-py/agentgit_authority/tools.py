"""Thin payload builders for governed tool attempts."""

from __future__ import annotations

from datetime import datetime, timezone

from .types import JSONObject


def build_action_attempt(
    run_id: str,
    *,
    tool_name: str,
    tool_kind: str,
    raw_call: JSONObject,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "none",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return {
        "run_id": run_id,
        "tool_registration": {
            "tool_name": tool_name,
            "tool_kind": tool_kind,
        },
        "raw_call": raw_call,
        "environment_context": {
            "workspace_roots": workspace_roots,
            "cwd": cwd or workspace_roots[0],
            "credential_mode": credential_mode,
        },
        "framework_context": {
            "agent_name": agent_name,
            "agent_framework": agent_framework,
        },
        "received_at": _iso_now(),
    }


def build_filesystem_write_attempt(
    run_id: str,
    path: str,
    content: str,
    *,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "none",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="write_file",
        tool_kind="filesystem",
        raw_call={
            "operation": "write",
            "path": path,
            "content": content,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_filesystem_delete_attempt(
    run_id: str,
    path: str,
    *,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "none",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="delete_file",
        tool_kind="filesystem",
        raw_call={
            "operation": "delete",
            "path": path,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_shell_attempt(
    run_id: str,
    command: str,
    *,
    argv: list[str] | None = None,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "none",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="exec_command",
        tool_kind="shell",
        raw_call={
            "command": command,
            "argv": argv or command.split(),
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_draft_create_attempt(
    run_id: str,
    subject: str,
    body: str,
    *,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "none",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="drafts_create",
        tool_kind="function",
        raw_call={
            "integration": "drafts",
            "operation": "create_draft",
            "subject": subject,
            "body": body,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_draft_archive_attempt(
    run_id: str,
    draft_id: str,
    *,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "none",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="drafts_archive",
        tool_kind="function",
        raw_call={
            "integration": "drafts",
            "operation": "archive_draft",
            "draft_id": draft_id,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_draft_delete_attempt(
    run_id: str,
    draft_id: str,
    *,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "none",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="drafts_delete",
        tool_kind="function",
        raw_call={
            "integration": "drafts",
            "operation": "delete_draft",
            "draft_id": draft_id,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_draft_unarchive_attempt(
    run_id: str,
    draft_id: str,
    *,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "none",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="drafts_unarchive",
        tool_kind="function",
        raw_call={
            "integration": "drafts",
            "operation": "unarchive_draft",
            "draft_id": draft_id,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_draft_update_attempt(
    run_id: str,
    draft_id: str,
    *,
    subject: str | None = None,
    body: str | None = None,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "none",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    raw_call: JSONObject = {
        "integration": "drafts",
        "operation": "update_draft",
        "draft_id": draft_id,
    }
    if subject is not None:
        raw_call["subject"] = subject
    if body is not None:
        raw_call["body"] = body

    return build_action_attempt(
        run_id,
        tool_name="drafts_update",
        tool_kind="function",
        raw_call=raw_call,
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_draft_restore_attempt(
    run_id: str,
    draft_id: str,
    *,
    subject: str,
    body: str,
    status: str,
    labels: list[str],
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "none",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="drafts_restore",
        tool_kind="function",
        raw_call={
            "integration": "drafts",
            "operation": "restore_draft",
            "draft_id": draft_id,
            "subject": subject,
            "body": body,
            "status": status,
            "labels": labels,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_draft_add_label_attempt(
    run_id: str,
    draft_id: str,
    label: str,
    *,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "none",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="drafts_add_label",
        tool_kind="function",
        raw_call={
            "integration": "drafts",
            "operation": "add_label",
            "draft_id": draft_id,
            "label": label,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_draft_remove_label_attempt(
    run_id: str,
    draft_id: str,
    label: str,
    *,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "none",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="drafts_remove_label",
        tool_kind="function",
        raw_call={
            "integration": "drafts",
            "operation": "remove_label",
            "draft_id": draft_id,
            "label": label,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_note_create_attempt(
    run_id: str,
    title: str,
    body: str,
    *,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "none",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="notes_create",
        tool_kind="function",
        raw_call={
            "integration": "notes",
            "operation": "create_note",
            "title": title,
            "body": body,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_note_archive_attempt(
    run_id: str,
    note_id: str,
    *,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "none",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="notes_archive",
        tool_kind="function",
        raw_call={
            "integration": "notes",
            "operation": "archive_note",
            "note_id": note_id,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_note_delete_attempt(
    run_id: str,
    note_id: str,
    *,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "none",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="notes_delete",
        tool_kind="function",
        raw_call={
            "integration": "notes",
            "operation": "delete_note",
            "note_id": note_id,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_note_unarchive_attempt(
    run_id: str,
    note_id: str,
    *,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "none",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="notes_unarchive",
        tool_kind="function",
        raw_call={
            "integration": "notes",
            "operation": "unarchive_note",
            "note_id": note_id,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_note_update_attempt(
    run_id: str,
    note_id: str,
    *,
    title: str | None = None,
    body: str | None = None,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "none",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    raw_call: JSONObject = {
        "integration": "notes",
        "operation": "update_note",
        "note_id": note_id,
    }
    if title is not None:
        raw_call["title"] = title
    if body is not None:
        raw_call["body"] = body

    return build_action_attempt(
        run_id,
        tool_name="notes_update",
        tool_kind="function",
        raw_call=raw_call,
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_note_restore_attempt(
    run_id: str,
    note_id: str,
    *,
    title: str,
    body: str,
    status: str,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "none",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="notes_restore",
        tool_kind="function",
        raw_call={
            "integration": "notes",
            "operation": "restore_note",
            "note_id": note_id,
            "title": title,
            "body": body,
            "status": status,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_ticket_create_attempt(
    run_id: str,
    title: str,
    body: str,
    *,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "brokered",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="tickets_create",
        tool_kind="function",
        raw_call={
            "integration": "tickets",
            "operation": "create_ticket",
            "title": title,
            "body": body,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_ticket_update_attempt(
    run_id: str,
    ticket_id: str,
    *,
    title: str | None = None,
    body: str | None = None,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "brokered",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    raw_call: JSONObject = {
        "integration": "tickets",
        "operation": "update_ticket",
        "ticket_id": ticket_id,
    }
    if title is not None:
        raw_call["title"] = title
    if body is not None:
        raw_call["body"] = body

    return build_action_attempt(
        run_id,
        tool_name="tickets_update",
        tool_kind="function",
        raw_call=raw_call,
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_ticket_delete_attempt(
    run_id: str,
    ticket_id: str,
    *,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "brokered",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="tickets_delete",
        tool_kind="function",
        raw_call={
            "integration": "tickets",
            "operation": "delete_ticket",
            "ticket_id": ticket_id,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_ticket_restore_attempt(
    run_id: str,
    ticket_id: str,
    *,
    title: str,
    body: str,
    status: str,
    labels: list[str],
    assigned_users: list[str],
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "brokered",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="tickets_restore",
        tool_kind="function",
        raw_call={
            "integration": "tickets",
            "operation": "restore_ticket",
            "ticket_id": ticket_id,
            "title": title,
            "body": body,
            "status": status,
            "labels": labels,
            "assigned_users": assigned_users,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_ticket_close_attempt(
    run_id: str,
    ticket_id: str,
    *,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "brokered",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="tickets_close",
        tool_kind="function",
        raw_call={
            "integration": "tickets",
            "operation": "close_ticket",
            "ticket_id": ticket_id,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_ticket_reopen_attempt(
    run_id: str,
    ticket_id: str,
    *,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "brokered",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="tickets_reopen",
        tool_kind="function",
        raw_call={
            "integration": "tickets",
            "operation": "reopen_ticket",
            "ticket_id": ticket_id,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_ticket_add_label_attempt(
    run_id: str,
    ticket_id: str,
    label: str,
    *,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "brokered",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="tickets_add_label",
        tool_kind="function",
        raw_call={
            "integration": "tickets",
            "operation": "add_label",
            "ticket_id": ticket_id,
            "label": label,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_ticket_remove_label_attempt(
    run_id: str,
    ticket_id: str,
    label: str,
    *,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "brokered",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="tickets_remove_label",
        tool_kind="function",
        raw_call={
            "integration": "tickets",
            "operation": "remove_label",
            "ticket_id": ticket_id,
            "label": label,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_ticket_assign_user_attempt(
    run_id: str,
    ticket_id: str,
    user_id: str,
    *,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "brokered",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="tickets_assign_user",
        tool_kind="function",
        raw_call={
            "integration": "tickets",
            "operation": "assign_user",
            "ticket_id": ticket_id,
            "user_id": user_id,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def build_ticket_unassign_user_attempt(
    run_id: str,
    ticket_id: str,
    user_id: str,
    *,
    workspace_roots: list[str],
    cwd: str | None = None,
    credential_mode: str = "brokered",
    agent_name: str = "agentgit-py",
    agent_framework: str = "python",
) -> JSONObject:
    return build_action_attempt(
        run_id,
        tool_name="tickets_unassign_user",
        tool_kind="function",
        raw_call={
            "integration": "tickets",
            "operation": "unassign_user",
            "ticket_id": ticket_id,
            "user_id": user_id,
        },
        workspace_roots=workspace_roots,
        cwd=cwd,
        credential_mode=credential_mode,
        agent_name=agent_name,
        agent_framework=agent_framework,
    )


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
