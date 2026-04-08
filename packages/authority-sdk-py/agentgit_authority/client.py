"""Thin Python client for the local AgentGit authority daemon."""

from __future__ import annotations

import json
import os
import socket
import stat
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


MAX_CONNECT_RETRY_DELAY_S = 5.0
MAX_RESPONSE_BYTES = 1_048_576


def _current_uid() -> int | None:
    getuid = getattr(os, "getuid", None)
    return getuid() if callable(getuid) else None


def _validate_trusted_local_path(
    path: Path,
    *,
    code: str,
    message: str,
    expected_type: str,
    allow_missing: bool,
) -> None:
    try:
        path_stat = path.lstat()
    except FileNotFoundError:
        if allow_missing:
            return
        raise AuthorityClientTransportError(
            message,
            code,
            False,
            {"path": str(path), "reason": "missing"},
        ) from None

    if stat.S_ISLNK(path_stat.st_mode):
        raise AuthorityClientTransportError(
            message,
            code,
            False,
            {"path": str(path), "reason": "symlink"},
        )

    current_uid = _current_uid()
    if current_uid is not None and path_stat.st_uid != current_uid:
        raise AuthorityClientTransportError(
            message,
            code,
            False,
            {"path": str(path), "reason": "owner_mismatch", "owner_uid": path_stat.st_uid},
        )

    if expected_type == "directory" and not stat.S_ISDIR(path_stat.st_mode):
        raise AuthorityClientTransportError(
            message,
            code,
            False,
            {"path": str(path), "reason": "not_directory"},
        )
    if expected_type == "socket" and not stat.S_ISSOCK(path_stat.st_mode):
        raise AuthorityClientTransportError(
            message,
            code,
            False,
            {"path": str(path), "reason": "not_socket"},
        )
    if expected_type == "file" and not stat.S_ISREG(path_stat.st_mode):
        raise AuthorityClientTransportError(
            message,
            code,
            False,
            {"path": str(path), "reason": "not_file"},
        )


def _resolve_project_root() -> str:
    for env_key in ("AGENTGIT_ROOT", "INIT_CWD"):
        configured = os.environ.get(env_key)
        if not configured:
            continue
        candidate = Path(configured).expanduser().resolve(strict=False)
        _validate_trusted_local_path(
            candidate,
            code="SOCKET_PATH_UNTRUSTED",
            message="Authority daemon root directory is not trusted.",
            expected_type="directory",
            allow_missing=False,
        )
        return str(candidate)

    return os.path.abspath(os.getcwd())


class AuthorityClient:
    """Minimal local IPC client for the authority daemon."""

    def __init__(self, options: AuthorityClientOptions | None = None) -> None:
        resolved = options or AuthorityClientOptions()
        project_root = _resolve_project_root()
        self._socket_path = os.path.abspath(
            resolved.socket_path or os.path.join(project_root, ".agentgit", "authority.sock")
        )
        self._client_type = resolved.client_type
        self._client_version = resolved.client_version
        self._connect_timeout_s = resolved.connect_timeout_s
        self._response_timeout_s = resolved.response_timeout_s
        self._max_connect_retries = resolved.max_connect_retries
        self._connect_retry_delay_s = resolved.connect_retry_delay_s
        self._session_id: str | None = None

    def _validate_socket_path(self) -> None:
        socket_path = Path(self._socket_path)
        _validate_trusted_local_path(
            socket_path.parent,
            code="SOCKET_PATH_UNTRUSTED",
            message="Authority daemon socket directory is not trusted.",
            expected_type="directory",
            allow_missing=True,
        )
        _validate_trusted_local_path(
            socket_path,
            code="SOCKET_PATH_UNTRUSTED",
            message="Authority daemon socket path is not trusted.",
            expected_type="socket",
            allow_missing=True,
        )

    def _read_socket_auth_token(self) -> str | None:
        token_path = Path(f"{self._socket_path}.token")
        if not token_path.exists():
            return None

        _validate_trusted_local_path(
            token_path,
            code="SOCKET_AUTH_TOKEN_UNTRUSTED",
            message="Authority daemon auth token path is not trusted.",
            expected_type="file",
            allow_missing=False,
        )
        token = token_path.read_text(encoding="utf-8").strip()
        return token or None

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

    def get_effective_policy(self) -> JSONObject:
        self._ensure_session()
        return self._send_request("get_effective_policy", {}, self._session_id)

    def validate_policy_config(self, config: JSONObject) -> JSONObject:
        self._ensure_session()
        return self._send_request("validate_policy_config", {"config": config}, self._session_id)

    def get_policy_calibration_report(
        self,
        *,
        run_id: str | None = None,
        include_samples: bool = False,
        sample_limit: int | None = None,
    ) -> JSONObject:
        self._ensure_session()
        payload: JSONObject = {}
        if run_id is not None:
            payload["run_id"] = run_id
        if include_samples:
            payload["include_samples"] = include_samples
        if sample_limit is not None:
            payload["sample_limit"] = sample_limit
        return self._send_request("get_policy_calibration_report", payload, self._session_id)

    def explain_policy_action(self, attempt: JSONObject) -> JSONObject:
        if self._session_id is None:
            workspace_roots = attempt.get("environment_context", {}).get("workspace_roots", [])
            self.hello(workspace_roots if isinstance(workspace_roots, list) else [])
        return self._send_request(
            "explain_policy_action", {"attempt": attempt}, self._session_id
        )

    def get_policy_threshold_recommendations(
        self, *, run_id: str | None = None, min_samples: int | None = None
    ) -> JSONObject:
        if self._session_id is None:
            self.hello()
        payload: JSONObject = {}
        if run_id is not None:
            payload["run_id"] = run_id
        if min_samples is not None:
            payload["min_samples"] = min_samples
        return self._send_request(
            "get_policy_threshold_recommendations", payload, self._session_id
        )

    def replay_policy_thresholds(
        self,
        *,
        candidate_thresholds: list[JSONValue],
        run_id: str | None = None,
        include_changed_samples: bool = False,
        sample_limit: int | None = None,
    ) -> JSONObject:
        if self._session_id is None:
            self.hello()
        payload: JSONObject = {
            "candidate_thresholds": cast(JSONValue, candidate_thresholds),
        }
        if run_id is not None:
            payload["run_id"] = run_id
        if include_changed_samples:
            payload["include_changed_samples"] = include_changed_samples
        if sample_limit is not None:
            payload["sample_limit"] = sample_limit
        return self._send_request("replay_policy_thresholds", payload, self._session_id)

    def list_mcp_servers(self) -> JSONObject:
        self._ensure_session()
        return self._send_request("list_mcp_servers", {}, self._session_id)

    def list_mcp_server_candidates(self) -> JSONObject:
        self._ensure_session()
        return self._send_request("list_mcp_server_candidates", {}, self._session_id)

    def submit_mcp_server_candidate(self, candidate: JSONObject, *, idempotency_key: str | None = None) -> JSONObject:
        self._ensure_session()
        return self._send_request(
            "submit_mcp_server_candidate",
            {"candidate": candidate},
            self._session_id,
            idempotency_key=idempotency_key,
        )

    def list_mcp_server_profiles(self) -> JSONObject:
        self._ensure_session()
        return self._send_request("list_mcp_server_profiles", {}, self._session_id)

    def resolve_mcp_server_candidate(self, payload: JSONObject, *, idempotency_key: str | None = None) -> JSONObject:
        self._ensure_session()
        return self._send_request(
            "resolve_mcp_server_candidate",
            payload,
            self._session_id,
            idempotency_key=idempotency_key,
        )

    def list_mcp_server_trust_decisions(self, server_profile_id: str | None = None) -> JSONObject:
        self._ensure_session()
        payload: JSONObject = {"server_profile_id": server_profile_id} if server_profile_id is not None else {}
        return self._send_request("list_mcp_server_trust_decisions", payload, self._session_id)

    def list_mcp_server_credential_bindings(self, server_profile_id: str | None = None) -> JSONObject:
        self._ensure_session()
        payload: JSONObject = {"server_profile_id": server_profile_id} if server_profile_id is not None else {}
        return self._send_request("list_mcp_server_credential_bindings", payload, self._session_id)

    def bind_mcp_server_credentials(self, payload: JSONObject, *, idempotency_key: str | None = None) -> JSONObject:
        self._ensure_session()
        return self._send_request(
            "bind_mcp_server_credentials",
            payload,
            self._session_id,
            idempotency_key=idempotency_key,
        )

    def revoke_mcp_server_credentials(self, credential_binding_id: str, *, idempotency_key: str | None = None) -> JSONObject:
        self._ensure_session()
        return self._send_request(
            "revoke_mcp_server_credentials",
            {"credential_binding_id": credential_binding_id},
            self._session_id,
            idempotency_key=idempotency_key,
        )

    def approve_mcp_server_profile(self, payload: JSONObject, *, idempotency_key: str | None = None) -> JSONObject:
        self._ensure_session()
        return self._send_request(
            "approve_mcp_server_profile",
            payload,
            self._session_id,
            idempotency_key=idempotency_key,
        )

    def activate_mcp_server_profile(self, server_profile_id: str, *, idempotency_key: str | None = None) -> JSONObject:
        self._ensure_session()
        return self._send_request(
            "activate_mcp_server_profile",
            {"server_profile_id": server_profile_id},
            self._session_id,
            idempotency_key=idempotency_key,
        )

    def quarantine_mcp_server_profile(self, payload: JSONObject, *, idempotency_key: str | None = None) -> JSONObject:
        self._ensure_session()
        return self._send_request(
            "quarantine_mcp_server_profile",
            payload,
            self._session_id,
            idempotency_key=idempotency_key,
        )

    def revoke_mcp_server_profile(self, payload: JSONObject, *, idempotency_key: str | None = None) -> JSONObject:
        self._ensure_session()
        return self._send_request(
            "revoke_mcp_server_profile",
            payload,
            self._session_id,
            idempotency_key=idempotency_key,
        )

    def list_mcp_secrets(self) -> JSONObject:
        self._ensure_session()
        return self._send_request("list_mcp_secrets", {}, self._session_id)

    def upsert_mcp_secret(self, secret: JSONObject, *, idempotency_key: str | None = None) -> JSONObject:
        self._ensure_session()
        return self._send_request(
            "upsert_mcp_secret",
            {"secret": secret},
            self._session_id,
            idempotency_key=idempotency_key,
        )

    def remove_mcp_secret(self, secret_id: str, *, idempotency_key: str | None = None) -> JSONObject:
        self._ensure_session()
        return self._send_request(
            "remove_mcp_secret",
            {"secret_id": secret_id},
            self._session_id,
            idempotency_key=idempotency_key,
        )

    def list_mcp_host_policies(self) -> JSONObject:
        self._ensure_session()
        return self._send_request("list_mcp_host_policies", {}, self._session_id)

    def upsert_mcp_host_policy(self, policy: JSONObject, *, idempotency_key: str | None = None) -> JSONObject:
        self._ensure_session()
        return self._send_request(
            "upsert_mcp_host_policy",
            {"policy": policy},
            self._session_id,
            idempotency_key=idempotency_key,
        )

    def remove_mcp_host_policy(self, host: str, *, idempotency_key: str | None = None) -> JSONObject:
        self._ensure_session()
        return self._send_request(
            "remove_mcp_host_policy",
            {"host": host},
            self._session_id,
            idempotency_key=idempotency_key,
        )

    def upsert_mcp_server(self, server: JSONObject, *, idempotency_key: str | None = None) -> JSONObject:
        self._ensure_session()
        return self._send_request(
            "upsert_mcp_server",
            {"server": server},
            self._session_id,
            idempotency_key=idempotency_key,
        )

    def remove_mcp_server(self, server_id: str, *, idempotency_key: str | None = None) -> JSONObject:
        self._ensure_session()
        return self._send_request(
            "remove_mcp_server",
            {"server_id": server_id},
            self._session_id,
            idempotency_key=idempotency_key,
        )

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
                time.sleep(min(max(self._connect_retry_delay_s, 0.0), MAX_CONNECT_RETRY_DELAY_S))

        if last_error:
            raise last_error

        raise AuthorityClientTransportError(
            "Failed to communicate with the authority daemon.",
            "SOCKET_CONNECT_FAILED",
            False,
            {"socket_path": self._socket_path},
        )

    def _write_and_read_line_once(self, payload: JSONObject) -> JSONObject:
        self._validate_socket_path()
        auth_token = self._read_socket_auth_token()
        request_body = f"{f'{auth_token}\\n' if auth_token else ''}{json.dumps(payload)}\n".encode("utf-8")
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
                        "socket_name": Path(self._socket_path).name,
                        "timeout_s": self._connect_timeout_s,
                    },
                ) from error
            except OSError as error:
                raise AuthorityClientTransportError(
                    "Failed to communicate with the authority daemon.",
                    "SOCKET_CONNECT_FAILED",
                    True,
                    {
                        "socket_name": Path(self._socket_path).name,
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
                            "socket_name": Path(self._socket_path).name,
                            "timeout_s": self._response_timeout_s,
                        },
                    ) from error

                if not chunk:
                    raise AuthorityClientTransportError(
                        "Authority daemon closed the socket before sending a response.",
                        "SOCKET_CLOSED",
                        False,
                        {
                            "socket_name": Path(self._socket_path).name,
                        },
                    )

                buffer.extend(chunk)
                if len(buffer) > MAX_RESPONSE_BYTES:
                    raise AuthorityClientTransportError(
                        "Authority daemon response exceeded the maximum supported size.",
                        "INVALID_RESPONSE",
                        False,
                        {
                            "max_bytes": MAX_RESPONSE_BYTES,
                        },
                    )
                newline_index = buffer.find(b"\n")
                if newline_index >= 0:
                    line = buffer[:newline_index].decode("utf-8").strip()
                    try:
                        parsed = json.loads(
                            line,
                            parse_constant=lambda value: (_ for _ in ()).throw(
                                ValueError(f"Unsupported constant: {value}")
                            ),
                        )
                    except json.JSONDecodeError as error:
                        raise AuthorityClientTransportError(
                            "Daemon returned malformed JSON.",
                            "INVALID_RESPONSE",
                            False,
                            {
                                "cause": str(error),
                            },
                        ) from error
                    except ValueError as error:
                        raise AuthorityClientTransportError(
                            "Daemon returned unsupported JSON values.",
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

    api_version = value.get("api_version")
    request_id = value.get("request_id")
    ok = value.get("ok")
    if not isinstance(api_version, str) or not isinstance(request_id, str) or not isinstance(ok, bool):
        return False

    if ok:
        return isinstance(value.get("result"), dict)

    return isinstance(value.get("error"), dict)


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
