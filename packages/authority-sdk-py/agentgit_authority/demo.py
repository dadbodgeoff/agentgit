"""Runnable demo entrypoint for the Python authority SDK."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from .client import AuthorityClient
from .session import build_register_run_payload


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a small governed write flow against the local AgentGit authority daemon.",
    )
    parser.add_argument(
        "--workspace-root",
        default=os.environ.get("AGENTGIT_ROOT", os.getcwd()),
        help="Workspace root to register with the daemon. Defaults to AGENTGIT_ROOT or cwd.",
    )
    parser.add_argument(
        "--workflow-name",
        default="python-sdk-demo",
        help="Workflow name recorded in the run journal.",
    )
    parser.add_argument(
        "--target-path",
        default=".agentgit-python-demo.txt",
        help="Path to write relative to the workspace root.",
    )
    parser.add_argument(
        "--content",
        default="hello from the Python AgentGit SDK\n",
        help="Content to write through the governed filesystem flow.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    workspace_root = Path(args.workspace_root).resolve()
    target_path = workspace_root / args.target_path

    client = AuthorityClient()

    hello = client.hello([str(workspace_root)])
    run = client.register_run(
        build_register_run_payload(
            args.workflow_name,
            [str(workspace_root)],
            agent_framework="python",
            agent_name="agentgit-py-demo",
            client_metadata={"example": "agentgit_authority.demo"},
        )
    )

    write_result = client.submit_filesystem_write(
        run["run_id"],
        str(target_path),
        args.content,
        workspace_roots=[str(workspace_root)],
        cwd=str(workspace_root),
        agent_name="agentgit-py-demo",
        agent_framework="python",
    )

    timeline = client.query_timeline(run["run_id"])
    summary = client.summarize_run(run["run_id"])

    print("Hello")
    print(json.dumps(hello, indent=2))
    print("\nRun")
    print(json.dumps(run, indent=2))
    print("\nWrite Result")
    print(json.dumps(write_result, indent=2))
    print("\nSummary")
    print(json.dumps(summary, indent=2))
    print("\nTimeline")
    print(json.dumps(timeline, indent=2))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
