from __future__ import annotations

import json
import os
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from typing import Callable

from agentgit_authority import (
    API_VERSION,
    AuthorityClient,
    AuthorityClientTransportError,
    AuthorityDaemonResponseError,
    EXPLAIN_POLICY_DECISION,
    IDENTIFY_EXTERNAL_EFFECTS,
    LIKELY_CAUSE,
    LIST_ACTIONS_TOUCHING_SCOPE,
    PREVIEW_REVERT_LOSS,
    SUGGEST_LIKELY_CAUSE,
    STEP_DETAILS,
    SUMMARIZE_AFTER_BOUNDARY,
    build_action_attempt,
    build_draft_add_label_attempt,
    build_draft_archive_attempt,
    build_draft_create_attempt,
    build_draft_delete_attempt,
    build_draft_remove_label_attempt,
    build_draft_restore_attempt,
    build_draft_unarchive_attempt,
    build_draft_update_attempt,
    build_note_archive_attempt,
    build_note_create_attempt,
    build_note_delete_attempt,
    build_note_restore_attempt,
    build_note_unarchive_attempt,
    build_note_update_attempt,
    build_ticket_add_label_attempt,
    build_ticket_assign_user_attempt,
    build_ticket_close_attempt,
    build_ticket_create_attempt,
    build_ticket_delete_attempt,
    build_ticket_remove_label_attempt,
    build_ticket_reopen_attempt,
    build_ticket_restore_attempt,
    build_ticket_unassign_user_attempt,
    build_ticket_update_attempt,
    build_filesystem_write_attempt,
    build_register_run_payload,
)
from agentgit_authority.client import AuthorityClientOptions


Handler = Callable[[dict[str, object]], bytes]


class FakeDaemon:
    def __init__(self, socket_path: str, handler: Handler) -> None:
        self.socket_path = socket_path
        self.handler = handler
        self.requests: list[dict[str, object]] = []
        self._stop_event = threading.Event()
        self._thread = threading.Thread(target=self._serve, daemon=True)

    def start(self) -> None:
        self._thread.start()
        deadline = time.time() + 1.0
        while True:
            if time.time() > deadline:
                raise TimeoutError("Fake daemon did not become ready in time.")
            if not os.path.exists(self.socket_path):
                time.sleep(0.01)
                continue
            try:
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.settimeout(0.05)
                    client.connect(self.socket_path)
                break
            except OSError:
                time.sleep(0.01)

    def stop(self) -> None:
        self._stop_event.set()
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.connect(self.socket_path)
        except OSError:
            pass
        self._thread.join(timeout=1.0)
        if os.path.exists(self.socket_path):
            os.remove(self.socket_path)

    def _serve(self) -> None:
        if os.path.exists(self.socket_path):
            os.remove(self.socket_path)

        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(self.socket_path)
            server.listen()
            server.settimeout(0.1)

            while not self._stop_event.is_set():
                try:
                    connection, _ = server.accept()
                except TimeoutError:
                    continue
                except OSError:
                    continue

                with connection:
                    buffer = bytearray()
                    while True:
                        chunk = connection.recv(4096)
                        if not chunk:
                            break
                        buffer.extend(chunk)
                        newline_index = buffer.find(b"\n")
                        if newline_index < 0:
                            continue

                        request = json.loads(buffer[:newline_index].decode("utf-8"))
                        self.requests.append(request)
                        response = self.handler(request)
                        connection.sendall(response)
                        break


class AuthorityClientTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.socket_path = str(Path(self.temp_dir.name) / "authority.sock")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def make_client(self) -> AuthorityClient:
        return AuthorityClient(
            AuthorityClientOptions(
                socket_path=self.socket_path,
                client_version="0.1.0-test",
                connect_timeout_s=0.2,
                response_timeout_s=0.2,
                max_connect_retries=0,
            )
        )

    def test_hello_returns_session_and_stores_it(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_test_1",
                "ok": True,
                "result": {
                    "session_id": "sess_test_1",
                    "accepted_api_version": API_VERSION,
                    "runtime_version": "0.1.0",
                    "schema_pack_version": "v1",
                    "capabilities": {
                        "local_only": True,
                        "methods": ["hello"],
                    },
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        response = client.hello(["/tmp/workspace"])

        self.assertEqual(response["session_id"], "sess_test_1")
        self.assertEqual(client.session_id, "sess_test_1")
        self.assertEqual(daemon.requests[0]["method"], "hello")

    def test_register_run_bootstraps_hello_before_submit(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_bootstrap",
                    "ok": True,
                    "result": {
                        "session_id": "sess_bootstrap",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "register_run"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_bootstrap",
                "ok": True,
                "result": {
                    "run_id": "run_1",
                    "run_handle": {
                        "run_id": "run_1",
                        "session_id": "sess_bootstrap",
                        "workflow_name": "demo",
                    },
                    "effective_policy_profile": "default",
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        result = client.register_run(
            {
                "workflow_name": "demo",
                "agent_framework": "python",
                "agent_name": "agentgit-py",
                "workspace_roots": ["/tmp/workspace"],
            }
        )

        self.assertEqual(result["run_id"], "run_1")
        self.assertEqual([request["method"] for request in daemon.requests], ["hello", "register_run"])
        self.assertEqual(daemon.requests[1]["session_id"], "sess_bootstrap")

    def test_mutating_wrappers_forward_idempotency_keys(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_idem",
                    "ok": True,
                    "result": {
                        "session_id": "sess_idem",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "register_run", "run_maintenance", "execute_recovery"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            if method == "register_run":
                result = {
                    "run_id": "run_1",
                    "run_handle": {
                        "run_id": "run_1",
                        "session_id": "sess_idem",
                        "workflow_name": "demo",
                    },
                    "effective_policy_profile": "default",
                }
            elif method == "run_maintenance":
                result = {
                    "accepted_priority": "administrative",
                    "scope": None,
                    "jobs": [],
                    "stream_id": None,
                }
            else:
                result = {
                    "restored": True,
                    "outcome": "restored",
                    "executed_at": "2026-03-31T12:00:00.000Z",
                    "recovery_plan": {
                        "schema_version": "recovery-plan.v1",
                        "recovery_plan_id": "rec_test",
                        "target": {
                            "type": "snapshot_id",
                            "snapshot_id": "snap_test",
                        },
                        "recovery_class": "automated_restore",
                        "strategy": "restore_snapshot",
                        "confidence": 0.9,
                        "steps": [],
                        "impact_preview": {
                            "later_actions_affected": 0,
                            "overlapping_paths": [],
                            "external_effects": [],
                            "data_loss_risk": "low",
                        },
                        "warnings": [],
                        "created_at": "2026-03-31T12:00:00.000Z",
                    },
                }

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": request.get("session_id") or "sess_idem",
                "ok": True,
                "result": result,
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.register_run(
            {
                "workflow_name": "demo",
                "agent_framework": "python",
                "agent_name": "agentgit-py",
                "workspace_roots": ["/tmp/workspace"],
            },
            idempotency_key="idem_register",
        )
        client.run_maintenance(["capability_refresh"], idempotency_key="idem_maint")
        client.execute_recovery("snap_test", idempotency_key="idem_recover")

        self.assertEqual(
            next(request["idempotency_key"] for request in daemon.requests if request["method"] == "register_run"),
            "idem_register",
        )
        self.assertEqual(
            next(request["idempotency_key"] for request in daemon.requests if request["method"] == "run_maintenance"),
            "idem_maint",
        )
        self.assertEqual(
            next(request["idempotency_key"] for request in daemon.requests if request["method"] == "execute_recovery"),
            "idem_recover",
        )

    def test_daemon_error_raises_response_error(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": None,
                "ok": False,
                "result": None,
                "error": {
                    "code": "VALIDATION_FAILED",
                    "error_class": "ValidationError",
                    "message": "Bad payload",
                    "details": {"field": "run_id"},
                    "retryable": False,
                },
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        with self.assertRaises(AuthorityDaemonResponseError) as error:
            client.get_run_summary("run_bad")

        self.assertEqual(error.exception.code, "VALIDATION_FAILED")
        self.assertEqual(error.exception.error_class, "ValidationError")

    def test_malformed_json_raises_transport_error(self) -> None:
        def handler(_: dict[str, object]) -> bytes:
            return b"{not-json}\n"

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        with self.assertRaises(AuthorityClientTransportError) as error:
            client.hello()

        self.assertEqual(error.exception.code, "INVALID_RESPONSE")

    def test_submit_filesystem_write_builds_expected_attempt_shape(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_write_1",
                    "ok": True,
                    "result": {
                        "session_id": "sess_write_1",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "submit_action_attempt"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_write_1",
                "ok": True,
                "result": {
                    "action": {},
                    "policy_outcome": {},
                    "execution_result": None,
                    "snapshot_record": None,
                    "approval_request": None,
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.submit_filesystem_write(
            "run_write_1",
            "/tmp/example.txt",
            "hello",
            workspace_roots=["/tmp"],
        )

        submit_request = daemon.requests[1]
        attempt = submit_request["payload"]["attempt"]
        self.assertEqual(submit_request["method"], "submit_action_attempt")
        self.assertEqual(attempt["tool_registration"]["tool_name"], "write_file")
        self.assertEqual(attempt["tool_registration"]["tool_kind"], "filesystem")
        self.assertEqual(attempt["raw_call"]["operation"], "write")
        self.assertEqual(attempt["raw_call"]["path"], "/tmp/example.txt")
        self.assertEqual(attempt["raw_call"]["content"], "hello")
        self.assertEqual(attempt["environment_context"]["workspace_roots"], ["/tmp"])
        self.assertEqual(attempt["environment_context"]["cwd"], "/tmp")
        self.assertEqual(attempt["framework_context"]["agent_framework"], "python")
        self.assertIsInstance(attempt["received_at"], str)

    def test_helper_builders_return_expected_payloads(self) -> None:
        run_payload = build_register_run_payload(
            "demo",
            ["/workspace"],
            agent_framework="pytest",
            agent_name="agentgit-py-test",
        )
        attempt = build_filesystem_write_attempt(
            "run_123",
            "/workspace/README.md",
            "hello\n",
            workspace_roots=["/workspace"],
        )
        generic_attempt = build_action_attempt(
            "run_456",
            tool_name="crm_update",
            tool_kind="mcp",
            raw_call={"operation": "update_contact", "contact_id": "123"},
            workspace_roots=["/workspace"],
            agent_framework="pytest",
        )
        draft_attempt = build_draft_create_attempt(
            "run_789",
            "Launch plan",
            "Ship the compensator.",
            workspace_roots=["/workspace"],
        )
        archive_attempt = build_draft_archive_attempt(
            "run_790",
            "draft_abc",
            workspace_roots=["/workspace"],
        )
        delete_attempt = build_draft_delete_attempt(
            "run_790a",
            "draft_abc",
            workspace_roots=["/workspace"],
        )
        unarchive_attempt = build_draft_unarchive_attempt(
            "run_790b",
            "draft_abc",
            workspace_roots=["/workspace"],
        )
        update_attempt = build_draft_update_attempt(
            "run_791",
            "draft_abc",
            subject="Updated launch plan",
            body="Refine the scope.",
            workspace_roots=["/workspace"],
        )
        restore_attempt = build_draft_restore_attempt(
            "run_791b",
            "draft_abc",
            subject="Restored launch plan",
            body="Restore the original body.",
            status="archived",
            labels=["priority/high", "ops"],
            workspace_roots=["/workspace"],
        )
        label_attempt = build_draft_add_label_attempt(
            "run_792",
            "draft_abc",
            "priority/high",
            workspace_roots=["/workspace"],
        )
        remove_label_attempt = build_draft_remove_label_attempt(
            "run_792b",
            "draft_abc",
            "priority/high",
            workspace_roots=["/workspace"],
        )
        note_attempt = build_note_create_attempt(
            "run_793",
            "Launch notes",
            "Track the second owned integration.",
            workspace_roots=["/workspace"],
        )
        note_archive_attempt = build_note_archive_attempt(
            "run_793b",
            "note_abc",
            workspace_roots=["/workspace"],
        )
        note_delete_attempt = build_note_delete_attempt(
            "run_793bb",
            "note_abc",
            workspace_roots=["/workspace"],
        )
        note_unarchive_attempt = build_note_unarchive_attempt(
            "run_793c",
            "note_abc",
            workspace_roots=["/workspace"],
        )
        note_update_attempt = build_note_update_attempt(
            "run_793d",
            "note_abc",
            title="Updated notes",
            body="Refine the second owned integration.",
            workspace_roots=["/workspace"],
        )
        note_restore_attempt = build_note_restore_attempt(
            "run_793e",
            "note_abc",
            title="Restored notes",
            body="Return the original note.",
            status="archived",
            workspace_roots=["/workspace"],
        )
        ticket_attempt = build_ticket_create_attempt(
            "run_794",
            "Launch blocker",
            "Credentialed adapters must use brokered auth.",
            workspace_roots=["/workspace"],
        )
        ticket_update_attempt = build_ticket_update_attempt(
            "run_795",
            "ticket_existing",
            title="Updated blocker",
            workspace_roots=["/workspace"],
        )
        ticket_delete_attempt = build_ticket_delete_attempt(
            "run_795b",
            "ticket_existing",
            workspace_roots=["/workspace"],
        )
        ticket_restore_attempt = build_ticket_restore_attempt(
            "run_795c",
            "ticket_existing",
            title="Restored blocker",
            body="Restore deleted tickets honestly.",
            status="closed",
            labels=["priority/high"],
            assigned_users=["user_123"],
            workspace_roots=["/workspace"],
        )
        ticket_close_attempt = build_ticket_close_attempt(
            "run_796",
            "ticket_existing",
            workspace_roots=["/workspace"],
        )
        ticket_reopen_attempt = build_ticket_reopen_attempt(
            "run_796b",
            "ticket_existing",
            workspace_roots=["/workspace"],
        )
        ticket_label_attempt = build_ticket_add_label_attempt(
            "run_797",
            "ticket_existing",
            "priority/high",
            workspace_roots=["/workspace"],
        )
        ticket_remove_label_attempt = build_ticket_remove_label_attempt(
            "run_797b",
            "ticket_existing",
            "priority/high",
            workspace_roots=["/workspace"],
        )
        ticket_assign_attempt = build_ticket_assign_user_attempt(
            "run_798",
            "ticket_existing",
            "user_123",
            workspace_roots=["/workspace"],
        )
        ticket_unassign_attempt = build_ticket_unassign_user_attempt(
            "run_799",
            "ticket_existing",
            "user_123",
            workspace_roots=["/workspace"],
        )

        self.assertEqual(run_payload["workflow_name"], "demo")
        self.assertEqual(run_payload["agent_framework"], "pytest")
        self.assertEqual(run_payload["workspace_roots"], ["/workspace"])
        self.assertEqual(attempt["run_id"], "run_123")
        self.assertEqual(attempt["tool_registration"]["tool_name"], "write_file")
        self.assertEqual(attempt["environment_context"]["cwd"], "/workspace")
        self.assertEqual(attempt["framework_context"]["agent_name"], "agentgit-py")
        self.assertIsInstance(attempt["received_at"], str)
        self.assertEqual(generic_attempt["tool_registration"]["tool_kind"], "mcp")
        self.assertEqual(generic_attempt["raw_call"]["operation"], "update_contact")
        self.assertEqual(generic_attempt["framework_context"]["agent_framework"], "pytest")
        self.assertEqual(draft_attempt["tool_registration"]["tool_kind"], "function")
        self.assertEqual(draft_attempt["raw_call"]["integration"], "drafts")
        self.assertEqual(draft_attempt["raw_call"]["operation"], "create_draft")
        self.assertEqual(draft_attempt["raw_call"]["subject"], "Launch plan")
        self.assertEqual(archive_attempt["raw_call"]["operation"], "archive_draft")
        self.assertEqual(archive_attempt["raw_call"]["draft_id"], "draft_abc")
        self.assertEqual(delete_attempt["raw_call"]["operation"], "delete_draft")
        self.assertEqual(delete_attempt["raw_call"]["draft_id"], "draft_abc")
        self.assertEqual(unarchive_attempt["raw_call"]["operation"], "unarchive_draft")
        self.assertEqual(unarchive_attempt["raw_call"]["draft_id"], "draft_abc")
        self.assertEqual(update_attempt["raw_call"]["operation"], "update_draft")
        self.assertEqual(update_attempt["raw_call"]["draft_id"], "draft_abc")
        self.assertEqual(update_attempt["raw_call"]["subject"], "Updated launch plan")
        self.assertEqual(restore_attempt["raw_call"]["operation"], "restore_draft")
        self.assertEqual(restore_attempt["raw_call"]["status"], "archived")
        self.assertEqual(restore_attempt["raw_call"]["labels"], ["priority/high", "ops"])
        self.assertEqual(label_attempt["raw_call"]["operation"], "add_label")
        self.assertEqual(label_attempt["raw_call"]["draft_id"], "draft_abc")
        self.assertEqual(label_attempt["raw_call"]["label"], "priority/high")
        self.assertEqual(remove_label_attempt["raw_call"]["operation"], "remove_label")
        self.assertEqual(remove_label_attempt["raw_call"]["draft_id"], "draft_abc")
        self.assertEqual(remove_label_attempt["raw_call"]["label"], "priority/high")
        self.assertEqual(note_attempt["raw_call"]["integration"], "notes")
        self.assertEqual(note_attempt["raw_call"]["operation"], "create_note")
        self.assertEqual(note_attempt["raw_call"]["title"], "Launch notes")
        self.assertEqual(note_archive_attempt["raw_call"]["operation"], "archive_note")
        self.assertEqual(note_archive_attempt["raw_call"]["note_id"], "note_abc")
        self.assertEqual(note_delete_attempt["raw_call"]["operation"], "delete_note")
        self.assertEqual(note_delete_attempt["raw_call"]["note_id"], "note_abc")
        self.assertEqual(note_unarchive_attempt["raw_call"]["operation"], "unarchive_note")
        self.assertEqual(note_unarchive_attempt["raw_call"]["note_id"], "note_abc")
        self.assertEqual(note_update_attempt["raw_call"]["operation"], "update_note")
        self.assertEqual(note_update_attempt["raw_call"]["note_id"], "note_abc")
        self.assertEqual(note_update_attempt["raw_call"]["title"], "Updated notes")
        self.assertEqual(note_restore_attempt["raw_call"]["operation"], "restore_note")
        self.assertEqual(note_restore_attempt["raw_call"]["note_id"], "note_abc")
        self.assertEqual(note_restore_attempt["raw_call"]["status"], "archived")
        self.assertEqual(ticket_attempt["raw_call"]["integration"], "tickets")
        self.assertEqual(ticket_attempt["raw_call"]["operation"], "create_ticket")
        self.assertEqual(ticket_attempt["raw_call"]["title"], "Launch blocker")
        self.assertEqual(ticket_attempt["environment_context"]["credential_mode"], "brokered")
        self.assertEqual(ticket_update_attempt["raw_call"]["operation"], "update_ticket")
        self.assertEqual(ticket_update_attempt["raw_call"]["ticket_id"], "ticket_existing")
        self.assertEqual(ticket_update_attempt["raw_call"]["title"], "Updated blocker")
        self.assertEqual(ticket_update_attempt["environment_context"]["credential_mode"], "brokered")
        self.assertEqual(ticket_delete_attempt["raw_call"]["operation"], "delete_ticket")
        self.assertEqual(ticket_delete_attempt["raw_call"]["ticket_id"], "ticket_existing")
        self.assertEqual(ticket_delete_attempt["environment_context"]["credential_mode"], "brokered")
        self.assertEqual(ticket_restore_attempt["raw_call"]["operation"], "restore_ticket")
        self.assertEqual(ticket_restore_attempt["raw_call"]["ticket_id"], "ticket_existing")
        self.assertEqual(ticket_restore_attempt["raw_call"]["status"], "closed")
        self.assertEqual(ticket_restore_attempt["raw_call"]["labels"], ["priority/high"])
        self.assertEqual(ticket_restore_attempt["raw_call"]["assigned_users"], ["user_123"])
        self.assertEqual(ticket_restore_attempt["environment_context"]["credential_mode"], "brokered")
        self.assertEqual(ticket_close_attempt["raw_call"]["operation"], "close_ticket")
        self.assertEqual(ticket_close_attempt["raw_call"]["ticket_id"], "ticket_existing")
        self.assertEqual(ticket_close_attempt["environment_context"]["credential_mode"], "brokered")
        self.assertEqual(ticket_reopen_attempt["raw_call"]["operation"], "reopen_ticket")
        self.assertEqual(ticket_reopen_attempt["raw_call"]["ticket_id"], "ticket_existing")
        self.assertEqual(ticket_reopen_attempt["environment_context"]["credential_mode"], "brokered")
        self.assertEqual(ticket_label_attempt["raw_call"]["operation"], "add_label")
        self.assertEqual(ticket_label_attempt["raw_call"]["ticket_id"], "ticket_existing")
        self.assertEqual(ticket_label_attempt["raw_call"]["label"], "priority/high")
        self.assertEqual(ticket_label_attempt["environment_context"]["credential_mode"], "brokered")
        self.assertEqual(ticket_remove_label_attempt["raw_call"]["operation"], "remove_label")
        self.assertEqual(ticket_remove_label_attempt["raw_call"]["ticket_id"], "ticket_existing")
        self.assertEqual(ticket_remove_label_attempt["raw_call"]["label"], "priority/high")
        self.assertEqual(ticket_remove_label_attempt["environment_context"]["credential_mode"], "brokered")
        self.assertEqual(ticket_assign_attempt["raw_call"]["operation"], "assign_user")
        self.assertEqual(ticket_assign_attempt["raw_call"]["ticket_id"], "ticket_existing")
        self.assertEqual(ticket_assign_attempt["raw_call"]["user_id"], "user_123")
        self.assertEqual(ticket_assign_attempt["environment_context"]["credential_mode"], "brokered")
        self.assertEqual(ticket_unassign_attempt["raw_call"]["operation"], "unassign_user")
        self.assertEqual(ticket_unassign_attempt["raw_call"]["ticket_id"], "ticket_existing")
        self.assertEqual(ticket_unassign_attempt["raw_call"]["user_id"], "user_123")
        self.assertEqual(ticket_unassign_attempt["environment_context"]["credential_mode"], "brokered")

    def test_submit_ticket_create_uses_brokered_mode(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_ticket",
                    "ok": True,
                    "result": {
                        "session_id": "sess_ticket",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "submit_action_attempt"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_ticket",
                "ok": True,
                "result": {
                    "action": {},
                    "policy_outcome": {},
                    "execution_result": None,
                    "snapshot_record": None,
                    "approval_request": None,
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.submit_ticket_create(
            "run_ticket_1",
            "Launch blocker",
            "Credentialed adapters must use brokered auth.",
            workspace_roots=["/tmp"],
        )

        submit_request = daemon.requests[1]
        attempt = submit_request["payload"]["attempt"]
        self.assertEqual(attempt["tool_registration"]["tool_name"], "tickets_create")
        self.assertEqual(attempt["raw_call"]["integration"], "tickets")
        self.assertEqual(attempt["raw_call"]["operation"], "create_ticket")
        self.assertEqual(attempt["environment_context"]["credential_mode"], "brokered")

    def test_submit_ticket_update_builds_expected_attempt_shape(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_ticket_update",
                    "ok": True,
                    "result": {
                        "session_id": "sess_ticket_update",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "submit_action_attempt"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_ticket_update",
                "ok": True,
                "result": {
                    "action": {},
                    "policy_outcome": {},
                    "execution_result": None,
                    "snapshot_record": None,
                    "approval_request": None,
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.submit_ticket_update(
            "run_ticket_2",
            "ticket_existing",
            title="Updated blocker",
            body="Recovered ticket flow needs preimage restore.",
            workspace_roots=["/tmp"],
        )

        submit_request = daemon.requests[1]
        attempt = submit_request["payload"]["attempt"]
        self.assertEqual(submit_request["method"], "submit_action_attempt")
        self.assertEqual(attempt["tool_registration"]["tool_name"], "tickets_update")
        self.assertEqual(attempt["raw_call"]["integration"], "tickets")
        self.assertEqual(attempt["raw_call"]["operation"], "update_ticket")
        self.assertEqual(attempt["raw_call"]["ticket_id"], "ticket_existing")
        self.assertEqual(attempt["raw_call"]["title"], "Updated blocker")
        self.assertEqual(attempt["raw_call"]["body"], "Recovered ticket flow needs preimage restore.")
        self.assertEqual(attempt["environment_context"]["credential_mode"], "brokered")

    def test_submit_ticket_delete_builds_expected_attempt_shape(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_ticket_delete",
                    "ok": True,
                    "result": {
                        "session_id": "sess_ticket_delete",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "submit_action_attempt"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_ticket_delete",
                "ok": True,
                "result": {
                    "action": {},
                    "policy_outcome": {},
                    "execution_result": None,
                    "snapshot_record": None,
                    "approval_request": None,
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.submit_ticket_delete(
            "run_ticket_2b",
            "ticket_existing",
            workspace_roots=["/tmp"],
        )

        submit_request = daemon.requests[1]
        attempt = submit_request["payload"]["attempt"]
        self.assertEqual(submit_request["method"], "submit_action_attempt")
        self.assertEqual(attempt["tool_registration"]["tool_name"], "tickets_delete")
        self.assertEqual(attempt["raw_call"]["integration"], "tickets")
        self.assertEqual(attempt["raw_call"]["operation"], "delete_ticket")
        self.assertEqual(attempt["raw_call"]["ticket_id"], "ticket_existing")
        self.assertEqual(attempt["environment_context"]["credential_mode"], "brokered")

    def test_submit_ticket_restore_builds_expected_attempt_shape(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_ticket_restore",
                    "ok": True,
                    "result": {
                        "session_id": "sess_ticket_restore",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "submit_action_attempt"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_ticket_restore",
                "ok": True,
                "result": {
                    "action": {},
                    "policy_outcome": {},
                    "execution_result": None,
                    "snapshot_record": None,
                    "approval_request": None,
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.submit_ticket_restore(
            "run_ticket_2c",
            "ticket_existing",
            title="Restored blocker",
            body="Restore deleted tickets honestly.",
            status="active",
            labels=["priority/high"],
            assigned_users=["user_123"],
            workspace_roots=["/tmp"],
        )

        submit_request = daemon.requests[1]
        attempt = submit_request["payload"]["attempt"]
        self.assertEqual(submit_request["method"], "submit_action_attempt")
        self.assertEqual(attempt["tool_registration"]["tool_name"], "tickets_restore")
        self.assertEqual(attempt["raw_call"]["integration"], "tickets")
        self.assertEqual(attempt["raw_call"]["operation"], "restore_ticket")
        self.assertEqual(attempt["raw_call"]["ticket_id"], "ticket_existing")
        self.assertEqual(attempt["raw_call"]["title"], "Restored blocker")
        self.assertEqual(attempt["raw_call"]["status"], "active")
        self.assertEqual(attempt["raw_call"]["labels"], ["priority/high"])
        self.assertEqual(attempt["raw_call"]["assigned_users"], ["user_123"])
        self.assertEqual(attempt["environment_context"]["credential_mode"], "brokered")

    def test_submit_ticket_close_builds_expected_attempt_shape(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_ticket_close",
                    "ok": True,
                    "result": {
                        "session_id": "sess_ticket_close",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "submit_action_attempt"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_ticket_close",
                "ok": True,
                "result": {
                    "action": {},
                    "policy_outcome": {},
                    "execution_result": None,
                    "snapshot_record": None,
                    "approval_request": None,
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.submit_ticket_close(
            "run_ticket_3",
            "ticket_existing",
            workspace_roots=["/tmp"],
        )

        submit_request = daemon.requests[1]
        attempt = submit_request["payload"]["attempt"]
        self.assertEqual(submit_request["method"], "submit_action_attempt")
        self.assertEqual(attempt["tool_registration"]["tool_name"], "tickets_close")
        self.assertEqual(attempt["raw_call"]["integration"], "tickets")
        self.assertEqual(attempt["raw_call"]["operation"], "close_ticket")
        self.assertEqual(attempt["raw_call"]["ticket_id"], "ticket_existing")
        self.assertEqual(attempt["environment_context"]["credential_mode"], "brokered")

    def test_submit_ticket_reopen_builds_expected_attempt_shape(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_ticket_reopen",
                    "ok": True,
                    "result": {
                        "session_id": "sess_ticket_reopen",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "submit_action_attempt"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_ticket_reopen",
                "ok": True,
                "result": {
                    "action": {},
                    "policy_outcome": {},
                    "execution_result": None,
                    "snapshot_record": None,
                    "approval_request": None,
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.submit_ticket_reopen(
            "run_ticket_3b",
            "ticket_existing",
            workspace_roots=["/tmp"],
        )

        submit_request = daemon.requests[1]
        attempt = submit_request["payload"]["attempt"]
        self.assertEqual(submit_request["method"], "submit_action_attempt")
        self.assertEqual(attempt["tool_registration"]["tool_name"], "tickets_reopen")
        self.assertEqual(attempt["raw_call"]["integration"], "tickets")
        self.assertEqual(attempt["raw_call"]["operation"], "reopen_ticket")
        self.assertEqual(attempt["raw_call"]["ticket_id"], "ticket_existing")
        self.assertEqual(attempt["environment_context"]["credential_mode"], "brokered")

    def test_submit_ticket_add_label_builds_expected_attempt_shape(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_ticket_label",
                    "ok": True,
                    "result": {
                        "session_id": "sess_ticket_label",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "submit_action_attempt"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_ticket_label",
                "ok": True,
                "result": {
                    "action": {},
                    "policy_outcome": {},
                    "execution_result": None,
                    "snapshot_record": None,
                    "approval_request": None,
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.submit_ticket_add_label(
            "run_ticket_4",
            "ticket_existing",
            "priority/high",
            workspace_roots=["/tmp"],
        )

        submit_request = daemon.requests[1]
        attempt = submit_request["payload"]["attempt"]
        self.assertEqual(submit_request["method"], "submit_action_attempt")
        self.assertEqual(attempt["tool_registration"]["tool_name"], "tickets_add_label")
        self.assertEqual(attempt["raw_call"]["integration"], "tickets")
        self.assertEqual(attempt["raw_call"]["operation"], "add_label")
        self.assertEqual(attempt["raw_call"]["ticket_id"], "ticket_existing")
        self.assertEqual(attempt["raw_call"]["label"], "priority/high")
        self.assertEqual(attempt["environment_context"]["credential_mode"], "brokered")

    def test_submit_ticket_remove_label_builds_expected_attempt_shape(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_ticket_remove_label",
                    "ok": True,
                    "result": {
                        "session_id": "sess_ticket_remove_label",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "submit_action_attempt"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_ticket_remove_label",
                "ok": True,
                "result": {
                    "action": {},
                    "policy_outcome": {},
                    "execution_result": None,
                    "snapshot_record": None,
                    "approval_request": None,
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.submit_ticket_remove_label(
            "run_ticket_4b",
            "ticket_existing",
            "priority/high",
            workspace_roots=["/tmp"],
        )

        submit_request = daemon.requests[1]
        attempt = submit_request["payload"]["attempt"]
        self.assertEqual(submit_request["method"], "submit_action_attempt")
        self.assertEqual(attempt["tool_registration"]["tool_name"], "tickets_remove_label")
        self.assertEqual(attempt["raw_call"]["integration"], "tickets")
        self.assertEqual(attempt["raw_call"]["operation"], "remove_label")
        self.assertEqual(attempt["raw_call"]["ticket_id"], "ticket_existing")
        self.assertEqual(attempt["raw_call"]["label"], "priority/high")
        self.assertEqual(attempt["environment_context"]["credential_mode"], "brokered")

    def test_submit_ticket_assign_user_builds_expected_attempt_shape(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_ticket_assign",
                    "ok": True,
                    "result": {
                        "session_id": "sess_ticket_assign",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "submit_action_attempt"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_ticket_assign",
                "ok": True,
                "result": {
                    "action": {},
                    "policy_outcome": {},
                    "execution_result": None,
                    "snapshot_record": None,
                    "approval_request": None,
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.submit_ticket_assign_user(
            "run_ticket_5",
            "ticket_existing",
            "user_123",
            workspace_roots=["/tmp"],
        )

        submit_request = daemon.requests[1]
        attempt = submit_request["payload"]["attempt"]
        self.assertEqual(submit_request["method"], "submit_action_attempt")
        self.assertEqual(attempt["tool_registration"]["tool_name"], "tickets_assign_user")
        self.assertEqual(attempt["raw_call"]["integration"], "tickets")
        self.assertEqual(attempt["raw_call"]["operation"], "assign_user")
        self.assertEqual(attempt["raw_call"]["ticket_id"], "ticket_existing")
        self.assertEqual(attempt["raw_call"]["user_id"], "user_123")
        self.assertEqual(attempt["environment_context"]["credential_mode"], "brokered")

    def test_submit_ticket_unassign_user_builds_expected_attempt_shape(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_ticket_unassign",
                    "ok": True,
                    "result": {
                        "session_id": "sess_ticket_unassign",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "submit_action_attempt"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_ticket_unassign",
                "ok": True,
                "result": {
                    "action": {},
                    "policy_outcome": {},
                    "execution_result": None,
                    "snapshot_record": None,
                    "approval_request": None,
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.submit_ticket_unassign_user(
            "run_ticket_6",
            "ticket_existing",
            "user_123",
            workspace_roots=["/tmp"],
        )

        submit_request = daemon.requests[1]
        attempt = submit_request["payload"]["attempt"]
        self.assertEqual(submit_request["method"], "submit_action_attempt")
        self.assertEqual(attempt["tool_registration"]["tool_name"], "tickets_unassign_user")
        self.assertEqual(attempt["raw_call"]["integration"], "tickets")
        self.assertEqual(attempt["raw_call"]["operation"], "unassign_user")
        self.assertEqual(attempt["raw_call"]["ticket_id"], "ticket_existing")
        self.assertEqual(attempt["raw_call"]["user_id"], "user_123")
        self.assertEqual(attempt["environment_context"]["credential_mode"], "brokered")

    def test_recovery_wrappers_normalize_snapshot_and_action_targets(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_recovery",
                    "ok": True,
                    "result": {
                        "session_id": "sess_recovery",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "plan_recovery", "execute_recovery"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_recovery",
                "ok": True,
                "result": {"echo_method": method, "echo_payload": request["payload"]},
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        snapshot_result = client.plan_recovery("snap_123")
        action_result = client.execute_recovery("act_123")

        self.assertEqual(snapshot_result["echo_method"], "plan_recovery")
        self.assertEqual(
            snapshot_result["echo_payload"]["target"],
            {"type": "snapshot_id", "snapshot_id": "snap_123"},
        )
        self.assertEqual(action_result["echo_method"], "execute_recovery")
        self.assertEqual(
            action_result["echo_payload"]["target"],
            {"type": "action_boundary", "action_id": "act_123"},
        )

    def test_recovery_wrappers_pass_through_external_object_targets(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_recovery",
                    "ok": True,
                    "result": {
                        "session_id": "sess_recovery",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "plan_recovery"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_recovery",
                "ok": True,
                "result": {"echo_method": method, "echo_payload": request["payload"]},
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        result = client.plan_recovery({"type": "external_object", "external_object_id": "note_shared"})

        self.assertEqual(result["echo_method"], "plan_recovery")
        self.assertEqual(
            result["echo_payload"]["target"],
            {"type": "external_object", "external_object_id": "note_shared"},
        )

    def test_recovery_wrappers_pass_through_run_checkpoint_targets(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_recovery",
                    "ok": True,
                    "result": {
                        "session_id": "sess_recovery",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "execute_recovery"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_recovery",
                "ok": True,
                "result": {"echo_method": method, "echo_payload": request["payload"]},
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        result = client.execute_recovery({"type": "run_checkpoint", "run_checkpoint": "run_demo#9"})

        self.assertEqual(result["echo_method"], "execute_recovery")
        self.assertEqual(
            result["echo_payload"]["target"],
            {"type": "run_checkpoint", "run_checkpoint": "run_demo#9"},
        )

    def test_recovery_wrappers_pass_through_path_subset_targets(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_recovery",
                    "ok": True,
                    "result": {
                        "session_id": "sess_recovery",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "plan_recovery"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_recovery",
                "ok": True,
                "result": {"echo_method": method, "echo_payload": request["payload"]},
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        result = client.plan_recovery(
            {"type": "path_subset", "snapshot_id": "snap_demo", "paths": ["src/app.ts", "/workspace/README.md"]}
        )

        self.assertEqual(result["echo_method"], "plan_recovery")
        self.assertEqual(
            result["echo_payload"]["target"],
            {"type": "path_subset", "snapshot_id": "snap_demo", "paths": ["src/app.ts", "/workspace/README.md"]},
        )

    def test_recovery_wrappers_pass_through_branch_point_targets(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_recovery",
                    "ok": True,
                    "result": {
                        "session_id": "sess_recovery",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "execute_recovery"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_recovery",
                "ok": True,
                "result": {"echo_method": method, "echo_payload": request["payload"]},
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        result = client.execute_recovery({"type": "branch_point", "run_id": "run_demo", "sequence": 7})

        self.assertEqual(result["echo_method"], "execute_recovery")
        self.assertEqual(
            result["echo_payload"]["target"],
            {"type": "branch_point", "run_id": "run_demo", "sequence": 7},
        )

    def test_submit_draft_create_builds_expected_attempt_shape(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_draft_1",
                    "ok": True,
                    "result": {
                        "session_id": "sess_draft_1",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "submit_action_attempt"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_draft_1",
                "ok": True,
                "result": {
                    "action": {},
                    "policy_outcome": {},
                    "execution_result": None,
                    "snapshot_record": None,
                    "approval_request": None,
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.submit_draft_create(
            "run_draft_1",
            "Launch plan",
            "Ship the owned compensator.",
            workspace_roots=["/tmp"],
        )

        submit_request = daemon.requests[1]
        attempt = submit_request["payload"]["attempt"]
        self.assertEqual(submit_request["method"], "submit_action_attempt")
        self.assertEqual(attempt["tool_registration"]["tool_kind"], "function")
        self.assertEqual(attempt["raw_call"]["integration"], "drafts")
        self.assertEqual(attempt["raw_call"]["operation"], "create_draft")
        self.assertEqual(attempt["raw_call"]["subject"], "Launch plan")
        self.assertEqual(attempt["raw_call"]["body"], "Ship the owned compensator.")
        self.assertEqual(attempt["environment_context"]["cwd"], "/tmp")

    def test_submit_draft_archive_builds_expected_attempt_shape(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_draft_2",
                    "ok": True,
                    "result": {
                        "session_id": "sess_draft_2",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "submit_action_attempt"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_draft_2",
                "ok": True,
                "result": {
                    "action": {},
                    "policy_outcome": {},
                    "execution_result": None,
                    "snapshot_record": None,
                    "approval_request": None,
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.submit_draft_archive(
            "run_draft_2",
            "draft_abc",
            workspace_roots=["/tmp"],
        )

        submit_request = daemon.requests[1]
        attempt = submit_request["payload"]["attempt"]
        self.assertEqual(submit_request["method"], "submit_action_attempt")
        self.assertEqual(attempt["tool_registration"]["tool_kind"], "function")
        self.assertEqual(attempt["raw_call"]["integration"], "drafts")
        self.assertEqual(attempt["raw_call"]["operation"], "archive_draft")
        self.assertEqual(attempt["raw_call"]["draft_id"], "draft_abc")
        self.assertEqual(attempt["environment_context"]["cwd"], "/tmp")

    def test_submit_draft_delete_builds_expected_attempt_shape(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_draft_delete",
                    "ok": True,
                    "result": {
                        "session_id": "sess_draft_delete",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "submit_action_attempt"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_draft_delete",
                "ok": True,
                "result": {
                    "action": {},
                    "policy_outcome": {},
                    "execution_result": None,
                    "snapshot_record": None,
                    "approval_request": None,
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.submit_draft_delete(
            "run_draft_delete",
            "draft_abc",
            workspace_roots=["/tmp"],
        )

        submit_request = daemon.requests[1]
        attempt = submit_request["payload"]["attempt"]
        self.assertEqual(submit_request["method"], "submit_action_attempt")
        self.assertEqual(attempt["tool_registration"]["tool_kind"], "function")
        self.assertEqual(attempt["raw_call"]["integration"], "drafts")
        self.assertEqual(attempt["raw_call"]["operation"], "delete_draft")
        self.assertEqual(attempt["raw_call"]["draft_id"], "draft_abc")
        self.assertEqual(attempt["environment_context"]["cwd"], "/tmp")

    def test_submit_draft_update_builds_expected_attempt_shape(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_draft_3",
                    "ok": True,
                    "result": {
                        "session_id": "sess_draft_3",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "submit_action_attempt"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_draft_3",
                "ok": True,
                "result": {
                    "action": {},
                    "policy_outcome": {},
                    "execution_result": None,
                    "snapshot_record": None,
                    "approval_request": None,
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.submit_draft_update(
            "run_draft_3",
            "draft_abc",
            subject="Updated launch plan",
            body="Refine the scope.",
            workspace_roots=["/tmp"],
        )

        submit_request = daemon.requests[1]
        attempt = submit_request["payload"]["attempt"]
        self.assertEqual(submit_request["method"], "submit_action_attempt")
        self.assertEqual(attempt["tool_registration"]["tool_kind"], "function")
        self.assertEqual(attempt["raw_call"]["integration"], "drafts")
        self.assertEqual(attempt["raw_call"]["operation"], "update_draft")
        self.assertEqual(attempt["raw_call"]["draft_id"], "draft_abc")
        self.assertEqual(attempt["raw_call"]["subject"], "Updated launch plan")
        self.assertEqual(attempt["raw_call"]["body"], "Refine the scope.")
        self.assertEqual(attempt["environment_context"]["cwd"], "/tmp")

    def test_submit_draft_add_label_builds_expected_attempt_shape(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_draft_4",
                    "ok": True,
                    "result": {
                        "session_id": "sess_draft_4",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "submit_action_attempt"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_draft_4",
                "ok": True,
                "result": {
                    "action": {},
                    "policy_outcome": {},
                    "execution_result": None,
                    "snapshot_record": None,
                    "approval_request": None,
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.submit_draft_add_label(
            "run_draft_4",
            "draft_abc",
            "priority/high",
            workspace_roots=["/tmp"],
        )

        submit_request = daemon.requests[1]
        attempt = submit_request["payload"]["attempt"]
        self.assertEqual(submit_request["method"], "submit_action_attempt")
        self.assertEqual(attempt["tool_registration"]["tool_kind"], "function")
        self.assertEqual(attempt["raw_call"]["integration"], "drafts")
        self.assertEqual(attempt["raw_call"]["operation"], "add_label")
        self.assertEqual(attempt["raw_call"]["draft_id"], "draft_abc")
        self.assertEqual(attempt["raw_call"]["label"], "priority/high")
        self.assertEqual(attempt["environment_context"]["cwd"], "/tmp")

    def test_submit_draft_restore_builds_expected_attempt_shape(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_draft_restore",
                    "ok": True,
                    "result": {
                        "session_id": "sess_draft_restore",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "submit_action_attempt"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_draft_restore",
                "ok": True,
                "result": {
                    "action": {},
                    "policy_outcome": {},
                    "execution_result": None,
                    "snapshot_record": None,
                    "approval_request": None,
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.submit_draft_restore(
            "run_draft_restore",
            "draft_abc",
            subject="Restored launch plan",
            body="Restore the original body.",
            status="archived",
            labels=["priority/high", "ops"],
            workspace_roots=["/tmp"],
        )

        submit_request = daemon.requests[1]
        attempt = submit_request["payload"]["attempt"]
        self.assertEqual(submit_request["method"], "submit_action_attempt")
        self.assertEqual(attempt["raw_call"]["integration"], "drafts")
        self.assertEqual(attempt["raw_call"]["operation"], "restore_draft")
        self.assertEqual(attempt["raw_call"]["draft_id"], "draft_abc")
        self.assertEqual(attempt["raw_call"]["status"], "archived")
        self.assertEqual(attempt["raw_call"]["labels"], ["priority/high", "ops"])

    def test_submit_draft_unarchive_and_remove_label_build_expected_attempt_shape(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_draft_variants",
                    "ok": True,
                    "result": {
                        "session_id": "sess_draft_variants",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "submit_action_attempt"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_draft_variants",
                "ok": True,
                "result": {
                    "action": {},
                    "policy_outcome": {},
                    "execution_result": None,
                    "snapshot_record": None,
                    "approval_request": None,
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.submit_draft_unarchive(
            "run_draft_unarchive",
            "draft_abc",
            workspace_roots=["/tmp"],
        )
        client.submit_draft_remove_label(
            "run_draft_remove_label",
            "draft_abc",
            "priority/high",
            workspace_roots=["/tmp"],
        )

        unarchive_attempt = daemon.requests[1]["payload"]["attempt"]
        remove_label_attempt = daemon.requests[2]["payload"]["attempt"]
        self.assertEqual(unarchive_attempt["raw_call"]["operation"], "unarchive_draft")
        self.assertEqual(unarchive_attempt["raw_call"]["draft_id"], "draft_abc")
        self.assertEqual(remove_label_attempt["raw_call"]["operation"], "remove_label")
        self.assertEqual(remove_label_attempt["raw_call"]["label"], "priority/high")

    def test_submit_note_create_builds_expected_attempt_shape(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_note_1",
                    "ok": True,
                    "result": {
                        "session_id": "sess_note_1",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "submit_action_attempt"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_note_1",
                "ok": True,
                "result": {
                    "action": {},
                    "policy_outcome": {},
                    "execution_result": None,
                    "snapshot_record": None,
                    "approval_request": None,
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.submit_note_create(
            "run_note_1",
            "Launch notes",
            "Track the second owned integration.",
            workspace_roots=["/tmp"],
        )

        submit_request = daemon.requests[1]
        attempt = submit_request["payload"]["attempt"]
        self.assertEqual(submit_request["method"], "submit_action_attempt")
        self.assertEqual(attempt["tool_registration"]["tool_kind"], "function")
        self.assertEqual(attempt["raw_call"]["integration"], "notes")
        self.assertEqual(attempt["raw_call"]["operation"], "create_note")
        self.assertEqual(attempt["raw_call"]["title"], "Launch notes")
        self.assertEqual(attempt["raw_call"]["body"], "Track the second owned integration.")
        self.assertEqual(attempt["environment_context"]["cwd"], "/tmp")

    def test_submit_note_archive_and_unarchive_build_expected_attempt_shape(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_note_variants",
                    "ok": True,
                    "result": {
                        "session_id": "sess_note_variants",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "submit_action_attempt"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_note_variants",
                "ok": True,
                "result": {
                    "action": {},
                    "policy_outcome": {},
                    "execution_result": None,
                    "snapshot_record": None,
                    "approval_request": None,
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.submit_note_archive("run_note_archive", "note_abc", workspace_roots=["/tmp"])
        client.submit_note_unarchive("run_note_unarchive", "note_abc", workspace_roots=["/tmp"])

        archive_attempt = daemon.requests[1]["payload"]["attempt"]
        unarchive_attempt = daemon.requests[2]["payload"]["attempt"]
        self.assertEqual(archive_attempt["raw_call"]["operation"], "archive_note")
        self.assertEqual(archive_attempt["raw_call"]["note_id"], "note_abc")
        self.assertEqual(unarchive_attempt["raw_call"]["operation"], "unarchive_note")
        self.assertEqual(unarchive_attempt["raw_call"]["note_id"], "note_abc")

    def test_submit_note_delete_build_expected_attempt_shape(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_note_delete",
                    "ok": True,
                    "result": {
                        "session_id": "sess_note_delete",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "submit_action_attempt"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_note_delete",
                "ok": True,
                "result": {
                    "action": {},
                    "policy_outcome": {},
                    "execution_result": None,
                    "snapshot_record": None,
                    "approval_request": None,
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.submit_note_delete("run_note_delete", "note_abc", workspace_roots=["/tmp"])

        delete_attempt = daemon.requests[1]["payload"]["attempt"]
        self.assertEqual(delete_attempt["raw_call"]["operation"], "delete_note")
        self.assertEqual(delete_attempt["raw_call"]["note_id"], "note_abc")

    def test_submit_note_update_and_restore_build_expected_attempt_shape(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_note_mutations",
                    "ok": True,
                    "result": {
                        "session_id": "sess_note_mutations",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": ["hello", "submit_action_attempt"],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_note_mutations",
                "ok": True,
                "result": {
                    "action": {},
                    "policy_outcome": {},
                    "execution_result": None,
                    "snapshot_record": None,
                    "approval_request": None,
                },
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        client.submit_note_update(
            "run_note_update",
            "note_abc",
            title="Updated notes",
            body="Refine the second owned integration.",
            workspace_roots=["/tmp"],
        )
        client.submit_note_restore(
            "run_note_restore",
            "note_abc",
            title="Restored notes",
            body="Return the original note.",
            status="archived",
            workspace_roots=["/tmp"],
        )

        update_attempt = daemon.requests[1]["payload"]["attempt"]
        restore_attempt = daemon.requests[2]["payload"]["attempt"]
        self.assertEqual(update_attempt["raw_call"]["operation"], "update_note")
        self.assertEqual(update_attempt["raw_call"]["note_id"], "note_abc")
        self.assertEqual(update_attempt["raw_call"]["title"], "Updated notes")
        self.assertEqual(restore_attempt["raw_call"]["operation"], "restore_note")
        self.assertEqual(restore_attempt["raw_call"]["note_id"], "note_abc")
        self.assertEqual(restore_attempt["raw_call"]["status"], "archived")

    def test_approval_and_helper_wrappers_send_expected_requests(self) -> None:
        def handler(request: dict[str, object]) -> bytes:
            method = request["method"]
            if method == "hello":
                payload = {
                    "api_version": API_VERSION,
                    "request_id": request["request_id"],
                    "session_id": "sess_wrappers",
                    "ok": True,
                    "result": {
                        "session_id": "sess_wrappers",
                        "accepted_api_version": API_VERSION,
                        "runtime_version": "0.1.0",
                        "schema_pack_version": "v1",
                        "capabilities": {
                            "local_only": True,
                            "methods": [
                                "hello",
                                "list_approvals",
                                "resolve_approval",
                                "query_helper",
                                "query_artifact",
                                "get_capabilities",
                                "get_effective_policy",
                                "get_policy_calibration_report",
                                "explain_policy_action",
                                "get_policy_threshold_recommendations",
                                "validate_policy_config",
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
                                "list_mcp_secrets",
                                "list_mcp_host_policies",
                                "upsert_mcp_secret",
                                "remove_mcp_secret",
                                "upsert_mcp_host_policy",
                                "remove_mcp_host_policy",
                                "upsert_mcp_server",
                                "remove_mcp_server",
                                "diagnostics",
                                "run_maintenance",
                            ],
                        },
                    },
                    "error": None,
                }
                return f"{json.dumps(payload)}\n".encode("utf-8")

            payload = {
                "api_version": API_VERSION,
                "request_id": request["request_id"],
                "session_id": "sess_wrappers",
                "ok": True,
                "result": {"echo_method": method, "echo_payload": request["payload"]},
                "error": None,
            }
            return f"{json.dumps(payload)}\n".encode("utf-8")

        daemon = FakeDaemon(self.socket_path, handler)
        daemon.start()
        self.addCleanup(daemon.stop)

        client = self.make_client()
        approvals = client.list_pending_approvals("run_abc")
        approved = client.approve("apr_123", "looks good")
        helper = client.likely_cause("run_abc")
        timeline = client.query_timeline("run_abc", visibility_scope="internal")
        helper_with_visibility = client.query_helper(
            "run_abc",
            STEP_DETAILS,
            focus_step_id="step_secret",
            visibility_scope="sensitive_internal",
        )
        artifact = client.query_artifact("artifact_secret", visibility_scope="internal")
        capabilities = client.get_capabilities("/tmp")
        effective_policy = client.get_effective_policy()
        calibration_report = client.get_policy_calibration_report(
            run_id="run_abc", include_samples=True, sample_limit=10
        )
        explained_action = client.explain_policy_action(
            {
                "run_id": "run_abc",
                "tool_registration": {
                    "tool_name": "write_file",
                    "tool_kind": "filesystem",
                },
                "raw_call": {"path": "/tmp/demo.txt", "content": "hello"},
                "environment_context": {"workspace_roots": ["/tmp"]},
                "received_at": "2026-04-01T12:00:00.000Z",
            }
        )
        threshold_recommendations = client.get_policy_threshold_recommendations(
            run_id="run_abc", min_samples=2
        )
        policy_validation = client.validate_policy_config(
            {
                "profile_name": "workspace-hardening",
                "policy_version": "2026.04.01",
                "rules": [],
            }
        )
        mcp_servers = client.list_mcp_servers()
        upserted_server = client.upsert_mcp_server(
            {
                "server_id": "notes_http",
                "transport": "streamable_http",
                "url": "http://127.0.0.1:3010/mcp",
                "tools": [
                    {
                        "tool_name": "echo_note",
                        "side_effect_level": "read_only",
                        "approval_mode": "allow",
                    }
                ],
            }
        )
        removed_server = client.remove_mcp_server("notes_http")
        diagnostics = client.diagnostics(["storage_summary", "journal_health"])
        maintenance = client.run_maintenance(
            ["artifact_expiry", "sqlite_wal_checkpoint"],
            priority_override="administrative",
            scope={"workspace_root": "/tmp"},
        )
        summarize_after = client.summarize_after_boundary("run_abc", "step_boundary")
        explain_policy = client.explain_policy_decision("run_abc", "step_policy")
        preview_revert = client.preview_revert_loss("run_abc", "step_revert")
        identify_external = client.identify_external_effects("run_abc")
        suggest_cause = client.suggest_likely_cause("run_abc")
        touching_scope = client.list_actions_touching_scope("run_abc", "step_scope")

        self.assertEqual(approvals["echo_method"], "list_approvals")
        self.assertEqual(approvals["echo_payload"]["status"], "pending")
        self.assertEqual(approvals["echo_payload"]["run_id"], "run_abc")
        self.assertEqual(approved["echo_method"], "resolve_approval")
        self.assertEqual(approved["echo_payload"]["approval_id"], "apr_123")
        self.assertEqual(approved["echo_payload"]["resolution"], "approved")
        self.assertEqual(helper["echo_method"], "query_helper")
        self.assertEqual(helper["echo_payload"]["question_type"], LIKELY_CAUSE)
        self.assertEqual(timeline["echo_method"], "query_timeline")
        self.assertEqual(timeline["echo_payload"]["visibility_scope"], "internal")
        self.assertEqual(helper_with_visibility["echo_payload"]["question_type"], STEP_DETAILS)
        self.assertEqual(helper_with_visibility["echo_payload"]["focus_step_id"], "step_secret")
        self.assertEqual(helper_with_visibility["echo_payload"]["visibility_scope"], "sensitive_internal")
        self.assertEqual(artifact["echo_method"], "query_artifact")
        self.assertEqual(artifact["echo_payload"]["artifact_id"], "artifact_secret")
        self.assertEqual(artifact["echo_payload"]["visibility_scope"], "internal")
        self.assertEqual(capabilities["echo_method"], "get_capabilities")
        self.assertEqual(capabilities["echo_payload"]["workspace_root"], "/tmp")
        self.assertEqual(effective_policy["echo_method"], "get_effective_policy")
        self.assertEqual(effective_policy["echo_payload"], {})
        self.assertEqual(
            calibration_report["echo_method"], "get_policy_calibration_report"
        )
        self.assertEqual(
            calibration_report["echo_payload"],
            {
                "run_id": "run_abc",
                "include_samples": True,
                "sample_limit": 10,
            },
        )
        self.assertEqual(explained_action["echo_method"], "explain_policy_action")
        self.assertEqual(
            explained_action["echo_payload"],
            {
                "attempt": {
                    "run_id": "run_abc",
                    "tool_registration": {
                        "tool_name": "write_file",
                        "tool_kind": "filesystem",
                    },
                    "raw_call": {"path": "/tmp/demo.txt", "content": "hello"},
                    "environment_context": {"workspace_roots": ["/tmp"]},
                    "received_at": "2026-04-01T12:00:00.000Z",
                }
            },
        )
        self.assertEqual(
            threshold_recommendations["echo_method"],
            "get_policy_threshold_recommendations",
        )
        self.assertEqual(
            threshold_recommendations["echo_payload"],
            {"run_id": "run_abc", "min_samples": 2},
        )
        self.assertEqual(policy_validation["echo_method"], "validate_policy_config")
        self.assertEqual(policy_validation["echo_payload"]["config"]["profile_name"], "workspace-hardening")
        self.assertEqual(mcp_servers["echo_method"], "list_mcp_servers")
        self.assertEqual(mcp_servers["echo_payload"], {})
        mcp_candidates = client.list_mcp_server_candidates()
        submitted_candidate = client.submit_mcp_server_candidate(
            {
                "source_kind": "user_input",
                "raw_endpoint": "https://api.example.com/mcp",
                "transport_hint": "streamable_http",
            }
        )
        mcp_profiles = client.list_mcp_server_profiles()
        resolved_candidate = client.resolve_mcp_server_candidate(
            {
                "candidate_id": "mcpcand_123",
                "display_name": "Example MCP",
            }
        )
        mcp_trust_decisions = client.list_mcp_server_trust_decisions("mcpprof_123")
        mcp_credential_bindings = client.list_mcp_server_credential_bindings("mcpprof_123")
        bound_credentials = client.bind_mcp_server_credentials(
            {
                "server_profile_id": "mcpprof_123",
                "binding_mode": "bearer_secret_ref",
                "broker_profile_id": "mcp_secret_123",
                "scope_labels": ["remote:mcp"],
            }
        )
        approved_profile = client.approve_mcp_server_profile(
            {
                "server_profile_id": "mcpprof_123",
                "decision": "allow_policy_managed",
                "trust_tier": "operator_approved_public",
                "allowed_execution_modes": ["local_proxy"],
                "reason_codes": ["INITIAL_REVIEW_COMPLETE"],
            }
        )
        activated_profile = client.activate_mcp_server_profile("mcpprof_123")
        quarantined_profile = client.quarantine_mcp_server_profile(
            {
                "server_profile_id": "mcpprof_123",
                "reason_codes": ["MCP_TOOL_INVENTORY_CHANGED"],
            }
        )
        revoked_credentials = client.revoke_mcp_server_credentials("mcpbind_123")
        revoked_profile = client.revoke_mcp_server_profile(
            {
                "server_profile_id": "mcpprof_123",
                "reason_codes": ["MANUAL_REVOKE"],
            }
        )
        mcp_secrets = client.list_mcp_secrets()
        upserted_secret = client.upsert_mcp_secret(
            {
                "secret_id": "mcp_secret_notion",
                "display_name": "Notion MCP",
                "bearer_token": "redacted-in-transport-test",
            }
        )
        removed_secret = client.remove_mcp_secret("mcp_secret_notion")
        mcp_host_policies = client.list_mcp_host_policies()
        upserted_host_policy = client.upsert_mcp_host_policy(
            {
                "host": "api.notion.com",
                "display_name": "Notion API",
                "allow_subdomains": False,
                "allowed_ports": [443],
            }
        )
        removed_host_policy = client.remove_mcp_host_policy("api.notion.com")
        self.assertEqual(upserted_server["echo_method"], "upsert_mcp_server")
        self.assertEqual(upserted_server["echo_payload"]["server"]["server_id"], "notes_http")
        self.assertEqual(removed_server["echo_method"], "remove_mcp_server")
        self.assertEqual(removed_server["echo_payload"]["server_id"], "notes_http")
        self.assertEqual(mcp_candidates["echo_method"], "list_mcp_server_candidates")
        self.assertEqual(mcp_candidates["echo_payload"], {})
        self.assertEqual(submitted_candidate["echo_method"], "submit_mcp_server_candidate")
        self.assertEqual(submitted_candidate["echo_payload"]["candidate"]["raw_endpoint"], "https://api.example.com/mcp")
        self.assertEqual(mcp_profiles["echo_method"], "list_mcp_server_profiles")
        self.assertEqual(mcp_profiles["echo_payload"], {})
        self.assertEqual(resolved_candidate["echo_method"], "resolve_mcp_server_candidate")
        self.assertEqual(resolved_candidate["echo_payload"]["candidate_id"], "mcpcand_123")
        self.assertEqual(resolved_candidate["echo_payload"]["display_name"], "Example MCP")
        self.assertEqual(mcp_trust_decisions["echo_method"], "list_mcp_server_trust_decisions")
        self.assertEqual(mcp_trust_decisions["echo_payload"]["server_profile_id"], "mcpprof_123")
        self.assertEqual(mcp_credential_bindings["echo_method"], "list_mcp_server_credential_bindings")
        self.assertEqual(mcp_credential_bindings["echo_payload"]["server_profile_id"], "mcpprof_123")
        self.assertEqual(bound_credentials["echo_method"], "bind_mcp_server_credentials")
        self.assertEqual(bound_credentials["echo_payload"]["server_profile_id"], "mcpprof_123")
        self.assertEqual(bound_credentials["echo_payload"]["binding_mode"], "bearer_secret_ref")
        self.assertEqual(approved_profile["echo_method"], "approve_mcp_server_profile")
        self.assertEqual(approved_profile["echo_payload"]["server_profile_id"], "mcpprof_123")
        self.assertEqual(approved_profile["echo_payload"]["decision"], "allow_policy_managed")
        self.assertEqual(activated_profile["echo_method"], "activate_mcp_server_profile")
        self.assertEqual(activated_profile["echo_payload"]["server_profile_id"], "mcpprof_123")
        self.assertEqual(quarantined_profile["echo_method"], "quarantine_mcp_server_profile")
        self.assertEqual(
            quarantined_profile["echo_payload"]["reason_codes"],
            ["MCP_TOOL_INVENTORY_CHANGED"],
        )
        self.assertEqual(revoked_credentials["echo_method"], "revoke_mcp_server_credentials")
        self.assertEqual(revoked_credentials["echo_payload"]["credential_binding_id"], "mcpbind_123")
        self.assertEqual(revoked_profile["echo_method"], "revoke_mcp_server_profile")
        self.assertEqual(revoked_profile["echo_payload"]["reason_codes"], ["MANUAL_REVOKE"])
        self.assertEqual(mcp_secrets["echo_method"], "list_mcp_secrets")
        self.assertEqual(mcp_secrets["echo_payload"], {})
        self.assertEqual(upserted_secret["echo_method"], "upsert_mcp_secret")
        self.assertEqual(upserted_secret["echo_payload"]["secret"]["secret_id"], "mcp_secret_notion")
        self.assertEqual(removed_secret["echo_method"], "remove_mcp_secret")
        self.assertEqual(removed_secret["echo_payload"]["secret_id"], "mcp_secret_notion")
        self.assertEqual(mcp_host_policies["echo_method"], "list_mcp_host_policies")
        self.assertEqual(mcp_host_policies["echo_payload"], {})
        self.assertEqual(upserted_host_policy["echo_method"], "upsert_mcp_host_policy")
        self.assertEqual(upserted_host_policy["echo_payload"]["policy"]["host"], "api.notion.com")
        self.assertEqual(removed_host_policy["echo_method"], "remove_mcp_host_policy")
        self.assertEqual(removed_host_policy["echo_payload"]["host"], "api.notion.com")
        self.assertEqual(diagnostics["echo_method"], "diagnostics")
        self.assertEqual(diagnostics["echo_payload"]["sections"], ["storage_summary", "journal_health"])
        self.assertEqual(maintenance["echo_method"], "run_maintenance")
        self.assertEqual(maintenance["echo_payload"]["job_types"], ["artifact_expiry", "sqlite_wal_checkpoint"])
        self.assertEqual(maintenance["echo_payload"]["priority_override"], "administrative")
        self.assertEqual(maintenance["echo_payload"]["scope"]["workspace_root"], "/tmp")
        self.assertEqual(summarize_after["echo_payload"]["question_type"], SUMMARIZE_AFTER_BOUNDARY)
        self.assertEqual(summarize_after["echo_payload"]["focus_step_id"], "step_boundary")
        self.assertEqual(explain_policy["echo_payload"]["question_type"], EXPLAIN_POLICY_DECISION)
        self.assertEqual(explain_policy["echo_payload"]["focus_step_id"], "step_policy")
        self.assertEqual(preview_revert["echo_payload"]["question_type"], PREVIEW_REVERT_LOSS)
        self.assertEqual(preview_revert["echo_payload"]["focus_step_id"], "step_revert")
        self.assertEqual(identify_external["echo_payload"]["question_type"], IDENTIFY_EXTERNAL_EFFECTS)
        self.assertEqual(suggest_cause["echo_payload"]["question_type"], SUGGEST_LIKELY_CAUSE)
        self.assertEqual(touching_scope["echo_payload"]["question_type"], LIST_ACTIONS_TOUCHING_SCOPE)
        self.assertEqual(touching_scope["echo_payload"]["focus_step_id"], "step_scope")


if __name__ == "__main__":
    unittest.main()
