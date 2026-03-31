"""Thin Python client for the local AgentGit authority daemon."""

from __future__ import annotations

import json
import os
import socket
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from .constants import API_VERSION
from .errors import (
    AuthorityClientTransportError,
    AuthorityDaemonResponseError,
)
from .types import ClientType, JSONObject, JSONValue, MethodName


@dataclass(slots=True)
class AuthorityClientOptions:
    socket_path: str | None = None
    client_type: ClientType = "sdk_py"
    client_version: str = "0.1.0"
    connect_timeout_s: float = 1.0
    response_timeout_s: float = 5.0
    max_connect_retries: int = 1
    connect_retry_delay_s: float = 0.05


class AuthorityClient:
    """Minimal local IPC client for the authority daemon."""

    def __init__(self, options: AuthorityClientOptions | None = None) -> None:
        resolved = options or AuthorityClientOptions()
        project_root = os.environ.get("AGENTGIT_ROOT") or os.environ.get("INIT_CWD") or os.getcwd()
        self._socket_path = resolved.socket_path or str(Path(project_root) / ".agentgit" / "authority.sock")
        self._client_type = resolved.client_type
        self._client_version = resolved.client_version
        self._connect_timeout_s = resolved.connect_timeout_s
        self._response_timeout_s = resolved.response_timeout_s
        self._max_connect_retries = resolved.max_connect_retries
        self._connect_retry_delay_s = resolved.connect_retry_delay_s
        self._session_id: str | None = None

    @property
    def session_id(self) -> str | None:
        return self._session_id

    def hello(self, workspace_roots: list[str] | None = None) -> JSONObject:
        payload: JSONObject = {
            "client_type": self._client_type,
            "client_version": self._client_version,
            "requested_api_version": API_VERSION,
            "workspace_roots": cast(JSONValue, workspace_roots or []),
        }
        response = self._send_request("hello", payload)
        session_id = response.get("session_id")
        if isinstance(session_id, str) and session_id:
            self._session_id = session_id
        return response

    def register_run(self, payload: JSONObject, *, idempotency_key: str | None = None) -> JSONObject:
        self._ensure_session(cast(list[str] | None, payload.get("workspace_roots")))
        return self._send_request("register_run", payload, self._session_id, idempotency_key=idempotency_key)

    def get_run_summary(self, run_id: str) -> JSONObject:
        self._ensure_session()
        return self._send_request("get_run_summary", {"run_id": run_id}, self._session_id)

    def get_capabilities(self, workspace_root: str | None = None) -> JSONObject:
        self._ensure_session([workspace_root] if workspace_root else None)
        payload: JSONObject = {"workspace_root": workspace_root} if workspace_root else {}
        return self._send_request("get_capabilities", payload, self._session_id)

    def diagnostics(self, sections: list[str] | None = None) -> JSONObject:
        self._ensure_session()
        payload: JSONObject = {"sections": cast(JSONValue, sections)} if sections else {}
        return self._send_request("diagnostics", payload, self._session_id)

    def run_maintenance(
        self,
        job_types: list[str],
        *,
        priority_override: str | None = None,
        scope: JSONObject | None = None,
        idempotency_key: str | None = None,
    ) -> JSONObject:
        self._ensure_session()
        payload: JSONObject = {"job_types": cast(JSONValue, job_types)}
        if priority_override is not None:
            payload["priority_override"] = priority_override
        if scope is not None:
            payload["scope"] = scope
        return self._send_request("run_maintenance", payload, self._session_id, idempotency_key=idempotency_key)

    def submit_action_attempt(self, attempt: JSONObject, *, idempotency_key: str | None = None) -> JSONObject:
        environment = attempt.get("environment_context")
        workspace_roots: list[str] | None = None
        if isinstance(environment, dict):
            raw_workspace_roots = environment.get("workspace_roots")
            if isinstance(raw_workspace_roots, list):
                workspace_roots = [str(value) for value in raw_workspace_roots]
        self._ensure_session(workspace_roots)
        return self._send_request(
            "submit_action_attempt",
            {"attempt": attempt},
            self._session_id,
            idempotency_key=idempotency_key,
        )

    def submit_filesystem_write(
        self,
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
        from .tools import build_filesystem_write_attempt

        return self.submit_action_attempt(
            build_filesystem_write_attempt(
                run_id,
                path,
                content,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_filesystem_delete(
        self,
        run_id: str,
        path: str,
        *,
        workspace_roots: list[str],
        cwd: str | None = None,
        credential_mode: str = "none",
        agent_name: str = "agentgit-py",
        agent_framework: str = "python",
    ) -> JSONObject:
        from .tools import build_filesystem_delete_attempt

        return self.submit_action_attempt(
            build_filesystem_delete_attempt(
                run_id,
                path,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_shell(
        self,
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
        from .tools import build_shell_attempt

        return self.submit_action_attempt(
            build_shell_attempt(
                run_id,
                command,
                argv=argv,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_draft_create(
        self,
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
        from .tools import build_draft_create_attempt

        return self.submit_action_attempt(
            build_draft_create_attempt(
                run_id,
                subject,
                body,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_draft_archive(
        self,
        run_id: str,
        draft_id: str,
        *,
        workspace_roots: list[str],
        cwd: str | None = None,
        credential_mode: str = "none",
        agent_name: str = "agentgit-py",
        agent_framework: str = "python",
    ) -> JSONObject:
        from .tools import build_draft_archive_attempt

        return self.submit_action_attempt(
            build_draft_archive_attempt(
                run_id,
                draft_id,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_draft_delete(
        self,
        run_id: str,
        draft_id: str,
        *,
        workspace_roots: list[str],
        cwd: str | None = None,
        credential_mode: str = "none",
        agent_name: str = "agentgit-py",
        agent_framework: str = "python",
    ) -> JSONObject:
        from .tools import build_draft_delete_attempt

        return self.submit_action_attempt(
            build_draft_delete_attempt(
                run_id,
                draft_id,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_draft_unarchive(
        self,
        run_id: str,
        draft_id: str,
        *,
        workspace_roots: list[str],
        cwd: str | None = None,
        credential_mode: str = "none",
        agent_name: str = "agentgit-py",
        agent_framework: str = "python",
    ) -> JSONObject:
        from .tools import build_draft_unarchive_attempt

        return self.submit_action_attempt(
            build_draft_unarchive_attempt(
                run_id,
                draft_id,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_draft_update(
        self,
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
        from .tools import build_draft_update_attempt

        return self.submit_action_attempt(
            build_draft_update_attempt(
                run_id,
                draft_id,
                subject=subject,
                body=body,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_draft_restore(
        self,
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
        from .tools import build_draft_restore_attempt

        return self.submit_action_attempt(
            build_draft_restore_attempt(
                run_id,
                draft_id,
                subject=subject,
                body=body,
                status=status,
                labels=labels,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_draft_add_label(
        self,
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
        from .tools import build_draft_add_label_attempt

        return self.submit_action_attempt(
            build_draft_add_label_attempt(
                run_id,
                draft_id,
                label,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_draft_remove_label(
        self,
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
        from .tools import build_draft_remove_label_attempt

        return self.submit_action_attempt(
            build_draft_remove_label_attempt(
                run_id,
                draft_id,
                label,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_note_create(
        self,
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
        from .tools import build_note_create_attempt

        return self.submit_action_attempt(
            build_note_create_attempt(
                run_id,
                title,
                body,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_note_archive(
        self,
        run_id: str,
        note_id: str,
        *,
        workspace_roots: list[str],
        cwd: str | None = None,
        credential_mode: str = "none",
        agent_name: str = "agentgit-py",
        agent_framework: str = "python",
    ) -> JSONObject:
        from .tools import build_note_archive_attempt

        return self.submit_action_attempt(
            build_note_archive_attempt(
                run_id,
                note_id,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_note_delete(
        self,
        run_id: str,
        note_id: str,
        *,
        workspace_roots: list[str],
        cwd: str | None = None,
        credential_mode: str = "none",
        agent_name: str = "agentgit-py",
        agent_framework: str = "python",
    ) -> JSONObject:
        from .tools import build_note_delete_attempt

        return self.submit_action_attempt(
            build_note_delete_attempt(
                run_id,
                note_id,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_note_unarchive(
        self,
        run_id: str,
        note_id: str,
        *,
        workspace_roots: list[str],
        cwd: str | None = None,
        credential_mode: str = "none",
        agent_name: str = "agentgit-py",
        agent_framework: str = "python",
    ) -> JSONObject:
        from .tools import build_note_unarchive_attempt

        return self.submit_action_attempt(
            build_note_unarchive_attempt(
                run_id,
                note_id,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_note_update(
        self,
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
        from .tools import build_note_update_attempt

        return self.submit_action_attempt(
            build_note_update_attempt(
                run_id,
                note_id,
                title=title,
                body=body,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_note_restore(
        self,
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
        from .tools import build_note_restore_attempt

        return self.submit_action_attempt(
            build_note_restore_attempt(
                run_id,
                note_id,
                title=title,
                body=body,
                status=status,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_ticket_create(
        self,
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
        from .tools import build_ticket_create_attempt

        return self.submit_action_attempt(
            build_ticket_create_attempt(
                run_id,
                title,
                body,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_ticket_update(
        self,
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
        from .tools import build_ticket_update_attempt

        return self.submit_action_attempt(
            build_ticket_update_attempt(
                run_id,
                ticket_id,
                title=title,
                body=body,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_ticket_delete(
        self,
        run_id: str,
        ticket_id: str,
        *,
        workspace_roots: list[str],
        cwd: str | None = None,
        credential_mode: str = "brokered",
        agent_name: str = "agentgit-py",
        agent_framework: str = "python",
    ) -> JSONObject:
        from .tools import build_ticket_delete_attempt

        return self.submit_action_attempt(
            build_ticket_delete_attempt(
                run_id,
                ticket_id,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_ticket_restore(
        self,
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
        from .tools import build_ticket_restore_attempt

        return self.submit_action_attempt(
            build_ticket_restore_attempt(
                run_id,
                ticket_id,
                title=title,
                body=body,
                status=status,
                labels=labels,
                assigned_users=assigned_users,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_ticket_close(
        self,
        run_id: str,
        ticket_id: str,
        *,
        workspace_roots: list[str],
        cwd: str | None = None,
        credential_mode: str = "brokered",
        agent_name: str = "agentgit-py",
        agent_framework: str = "python",
    ) -> JSONObject:
        from .tools import build_ticket_close_attempt

        return self.submit_action_attempt(
            build_ticket_close_attempt(
                run_id,
                ticket_id,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_ticket_reopen(
        self,
        run_id: str,
        ticket_id: str,
        *,
        workspace_roots: list[str],
        cwd: str | None = None,
        credential_mode: str = "brokered",
        agent_name: str = "agentgit-py",
        agent_framework: str = "python",
    ) -> JSONObject:
        from .tools import build_ticket_reopen_attempt

        return self.submit_action_attempt(
            build_ticket_reopen_attempt(
                run_id,
                ticket_id,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_ticket_add_label(
        self,
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
        from .tools import build_ticket_add_label_attempt

        return self.submit_action_attempt(
            build_ticket_add_label_attempt(
                run_id,
                ticket_id,
                label,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_ticket_remove_label(
        self,
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
        from .tools import build_ticket_remove_label_attempt

        return self.submit_action_attempt(
            build_ticket_remove_label_attempt(
                run_id,
                ticket_id,
                label,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_ticket_assign_user(
        self,
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
        from .tools import build_ticket_assign_user_attempt

        return self.submit_action_attempt(
            build_ticket_assign_user_attempt(
                run_id,
                ticket_id,
                user_id,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def submit_ticket_unassign_user(
        self,
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
        from .tools import build_ticket_unassign_user_attempt

        return self.submit_action_attempt(
            build_ticket_unassign_user_attempt(
                run_id,
                ticket_id,
                user_id,
                workspace_roots=workspace_roots,
                cwd=cwd,
                credential_mode=credential_mode,
                agent_name=agent_name,
                agent_framework=agent_framework,
            )
        )

    def list_approvals(self, filters: JSONObject | None = None) -> JSONObject:
        self._ensure_session()
        return self._send_request("list_approvals", filters or {}, self._session_id)

    def list_pending_approvals(self, run_id: str | None = None) -> JSONObject:
        filters: JSONObject = {"status": "pending"}
        if run_id:
            filters["run_id"] = run_id
        return self.list_approvals(filters)

    def query_approval_inbox(self, filters: JSONObject | None = None) -> JSONObject:
        self._ensure_session()
        return self._send_request("query_approval_inbox", filters or {}, self._session_id)

    def query_pending_approval_inbox(self, run_id: str | None = None) -> JSONObject:
        filters: JSONObject = {"status": "pending"}
        if run_id:
            filters["run_id"] = run_id
        return self.query_approval_inbox(filters)

    def resolve_approval(
        self,
        approval_id: str,
        resolution: str,
        note: str | None = None,
        *,
        idempotency_key: str | None = None,
    ) -> JSONObject:
        self._ensure_session()
        payload: JSONObject = {
            "approval_id": approval_id,
            "resolution": resolution,
        }
        if note:
            payload["note"] = note
        return self._send_request("resolve_approval", payload, self._session_id, idempotency_key=idempotency_key)

    def approve(self, approval_id: str, note: str | None = None) -> JSONObject:
        return self.resolve_approval(approval_id, "approved", note)

    def deny(self, approval_id: str, note: str | None = None) -> JSONObject:
        return self.resolve_approval(approval_id, "denied", note)

    def query_timeline(self, run_id: str, visibility_scope: str | None = None) -> JSONObject:
        self._ensure_session()
        payload: JSONObject = {"run_id": run_id}
        if visibility_scope:
            payload["visibility_scope"] = visibility_scope
        return self._send_request("query_timeline", payload, self._session_id)

    def query_helper(
        self,
        run_id: str,
        question_type: str,
        focus_step_id: str | None = None,
        compare_step_id: str | None = None,
        visibility_scope: str | None = None,
    ) -> JSONObject:
        self._ensure_session()
        payload: JSONObject = {
            "run_id": run_id,
            "question_type": question_type,
        }
        if focus_step_id:
            payload["focus_step_id"] = focus_step_id
        if compare_step_id:
            payload["compare_step_id"] = compare_step_id
        if visibility_scope:
            payload["visibility_scope"] = visibility_scope
        return self._send_request("query_helper", payload, self._session_id)

    def query_artifact(self, artifact_id: str, visibility_scope: str | None = None) -> JSONObject:
        self._ensure_session()
        payload: JSONObject = {"artifact_id": artifact_id}
        if visibility_scope:
            payload["visibility_scope"] = visibility_scope
        return self._send_request("query_artifact", payload, self._session_id)

    def summarize_run(self, run_id: str) -> JSONObject:
        from .helper import RUN_SUMMARY

        return self.query_helper(run_id, RUN_SUMMARY)

    def what_happened(self, run_id: str) -> JSONObject:
        from .helper import WHAT_HAPPENED

        return self.query_helper(run_id, WHAT_HAPPENED)

    def summarize_after_boundary(self, run_id: str, focus_step_id: str) -> JSONObject:
        from .helper import SUMMARIZE_AFTER_BOUNDARY

        return self.query_helper(run_id, SUMMARIZE_AFTER_BOUNDARY, focus_step_id=focus_step_id)

    def likely_cause(self, run_id: str) -> JSONObject:
        from .helper import LIKELY_CAUSE

        return self.query_helper(run_id, LIKELY_CAUSE)

    def suggest_likely_cause(self, run_id: str) -> JSONObject:
        from .helper import SUGGEST_LIKELY_CAUSE

        return self.query_helper(run_id, SUGGEST_LIKELY_CAUSE)

    def step_details(self, run_id: str, focus_step_id: str) -> JSONObject:
        from .helper import STEP_DETAILS

        return self.query_helper(run_id, STEP_DETAILS, focus_step_id=focus_step_id)

    def explain_policy_decision(self, run_id: str, focus_step_id: str) -> JSONObject:
        from .helper import EXPLAIN_POLICY_DECISION

        return self.query_helper(run_id, EXPLAIN_POLICY_DECISION, focus_step_id=focus_step_id)

    def reversible_steps(self, run_id: str) -> JSONObject:
        from .helper import REVERSIBLE_STEPS

        return self.query_helper(run_id, REVERSIBLE_STEPS)

    def preview_revert_loss(self, run_id: str, focus_step_id: str) -> JSONObject:
        from .helper import PREVIEW_REVERT_LOSS

        return self.query_helper(run_id, PREVIEW_REVERT_LOSS, focus_step_id=focus_step_id)

    def identify_external_effects(self, run_id: str) -> JSONObject:
        from .helper import IDENTIFY_EXTERNAL_EFFECTS

        return self.query_helper(run_id, IDENTIFY_EXTERNAL_EFFECTS)

    def list_actions_touching_scope(self, run_id: str, focus_step_id: str) -> JSONObject:
        from .helper import LIST_ACTIONS_TOUCHING_SCOPE

        return self.query_helper(run_id, LIST_ACTIONS_TOUCHING_SCOPE, focus_step_id=focus_step_id)

    def plan_recovery(self, target: str | JSONObject) -> JSONObject:
        self._ensure_session()
        return self._send_request("plan_recovery", _normalize_recovery_payload(target), self._session_id)

    def execute_recovery(self, target: str | JSONObject, *, idempotency_key: str | None = None) -> JSONObject:
        self._ensure_session()
        return self._send_request(
            "execute_recovery",
            _normalize_recovery_payload(target),
            self._session_id,
            idempotency_key=idempotency_key,
        )

    def _ensure_session(self, workspace_roots: list[str] | None = None) -> None:
        if self._session_id is None:
            self.hello(workspace_roots or [])

    def _send_request(
        self,
        method: MethodName,
        payload: JSONObject,
        session_id: str | None = None,
        *,
        idempotency_key: str | None = None,
    ) -> JSONObject:
        request: JSONObject = {
            "api_version": API_VERSION,
            "request_id": f"req_{uuid.uuid4().hex}",
            "method": method,
            "payload": payload,
        }
        if session_id:
            request["session_id"] = session_id
        if idempotency_key:
            request["idempotency_key"] = idempotency_key

        raw_response = self._write_and_read_line(request)
        if not _is_response_envelope(raw_response):
            raise AuthorityClientTransportError(
                "Daemon returned an invalid response envelope.",
                "INVALID_RESPONSE",
                False,
                None,
            )

        ok = raw_response.get("ok")
        result = raw_response.get("result")
        if ok is not True or not isinstance(result, dict):
            raw_error = raw_response.get("error")
            error = raw_error if isinstance(raw_error, dict) else {}
            raise AuthorityDaemonResponseError(
                str(error.get("message") or "Unknown daemon error."),
                str(error.get("code") or "UNKNOWN"),
                str(error.get("error_class") or "UnknownError"),
                bool(error.get("retryable", False)),
                cast(dict[str, object] | None, error.get("details")) if isinstance(error.get("details"), dict) else None,
            )

        return cast(JSONObject, result)

    def _write_and_read_line(self, payload: JSONObject) -> JSONObject:
        last_error: Exception | None = None
        for attempt in range(self._max_connect_retries + 1):
            try:
                return self._write_and_read_line_once(payload)
            except AuthorityClientTransportError as error:
                last_error = error
                can_retry = (
                    attempt < self._max_connect_retries
                    and error.retryable
                    and error.code in {"SOCKET_CONNECT_FAILED", "SOCKET_CONNECT_TIMEOUT"}
                )
                if not can_retry:
                    raise
                time.sleep(self._connect_retry_delay_s)

        if last_error:
            raise last_error

        raise AuthorityClientTransportError(
            "Failed to communicate with the authority daemon.",
            "SOCKET_CONNECT_FAILED",
            False,
            {"socket_path": self._socket_path},
        )

    def _write_and_read_line_once(self, payload: JSONObject) -> JSONObject:
        request_body = f"{json.dumps(payload)}\n".encode("utf-8")
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)

        try:
            client.settimeout(self._connect_timeout_s)
            try:
                client.connect(self._socket_path)
            except socket.timeout as error:
                raise AuthorityClientTransportError(
                    "Timed out while connecting to the authority daemon.",
                    "SOCKET_CONNECT_TIMEOUT",
                    True,
                    {
                        "socket_path": self._socket_path,
                        "timeout_s": self._connect_timeout_s,
                    },
                ) from error
            except OSError as error:
                raise AuthorityClientTransportError(
                    "Failed to communicate with the authority daemon.",
                    "SOCKET_CONNECT_FAILED",
                    True,
                    {
                        "socket_path": self._socket_path,
                        "cause": str(error),
                    },
                ) from error

            client.settimeout(self._response_timeout_s)
            client.sendall(request_body)

            buffer = bytearray()
            while True:
                try:
                    chunk = client.recv(4096)
                except socket.timeout as error:
                    raise AuthorityClientTransportError(
                        "Timed out while waiting for the authority daemon response.",
                        "SOCKET_RESPONSE_TIMEOUT",
                        False,
                        {
                            "socket_path": self._socket_path,
                            "timeout_s": self._response_timeout_s,
                        },
                    ) from error

                if not chunk:
                    raise AuthorityClientTransportError(
                        "Authority daemon closed the socket before sending a response.",
                        "SOCKET_CLOSED",
                        False,
                        {
                            "socket_path": self._socket_path,
                        },
                    )

                buffer.extend(chunk)
                newline_index = buffer.find(b"\n")
                if newline_index >= 0:
                    line = buffer[:newline_index].decode("utf-8").strip()
                    try:
                        parsed = json.loads(line)
                    except json.JSONDecodeError as error:
                        raise AuthorityClientTransportError(
                            "Daemon returned malformed JSON.",
                            "INVALID_RESPONSE",
                            False,
                            {
                                "cause": str(error),
                            },
                        ) from error

                    if not isinstance(parsed, dict):
                        raise AuthorityClientTransportError(
                            "Daemon returned an invalid response envelope.",
                            "INVALID_RESPONSE",
                            False,
                            None,
                        )

                    return cast(JSONObject, parsed)
        finally:
            client.close()


def _is_response_envelope(value: object) -> bool:
    if not isinstance(value, dict):
        return False

    required_keys = {"api_version", "request_id", "ok", "result", "error"}
    return required_keys.issubset(value.keys())


def _normalize_recovery_payload(target: str | JSONObject) -> JSONObject:
    if isinstance(target, dict):
        return {"target": target}

    if target.startswith("act_"):
        return {
            "target": {
                "type": "action_boundary",
                "action_id": target,
            }
        }

    return {
        "target": {
            "type": "snapshot_id",
            "snapshot_id": target,
        }
    }
