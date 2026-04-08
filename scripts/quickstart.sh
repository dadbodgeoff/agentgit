#!/usr/bin/env bash
set -euo pipefail

fail(){ echo "Error: $1" >&2; exit 1; }
need(){ command -v "$1" >/dev/null 2>&1 || fail "$2"; }
trim(){ local v="${1:-}"; v="${v#"${v%%[![:space:]]*}"}"; v="${v%"${v##*[![:space:]]}"}"; printf '%s' "$v"; }

need node "Node.js is required. Install Node.js 24 or newer."
need npm "npm is required. Install npm and retry."
need git "git is required. Install git and retry."

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")" || fail "Could not read the Node.js version."
[[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || fail "Could not parse the Node.js version."
(( NODE_MAJOR >= 24 )) || fail "Node.js 24 or newer is required. Current version: $(node -v)"

WORKSPACE_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
echo "Using workspace root: $WORKSPACE_ROOT"
echo "Installing @agentgit/cloud-connector globally..."
npm install -g @agentgit/cloud-connector >/dev/null 2>&1 || fail "Global install failed. Retry with npm configured for global installs."
need agentgit-cloud-connector "The connector binary is not on PATH after install. Re-open your shell and retry."

read -r -p "Cloud URL [http://localhost:3000]: " CLOUD_URL
CLOUD_URL="$(trim "${CLOUD_URL:-http://localhost:3000}")"
[[ -n "$CLOUD_URL" ]] || fail "Cloud URL cannot be empty."

read -r -p "Workspace ID (shown in the cloud UI): " WORKSPACE_ID
WORKSPACE_ID="$(trim "$WORKSPACE_ID")"
[[ -n "$WORKSPACE_ID" ]] || fail "Workspace ID is required for connector bootstrap."

read -r -s -p "Bootstrap token: " BOOTSTRAP_TOKEN
echo
BOOTSTRAP_TOKEN="$(trim "$BOOTSTRAP_TOKEN")"
[[ -n "$BOOTSTRAP_TOKEN" ]] || fail "Bootstrap token cannot be empty."

echo "Bootstrapping the connector..."
BOOTSTRAP_OUTPUT="$(agentgit-cloud-connector bootstrap --cloud-url "$CLOUD_URL" --workspace-id "$WORKSPACE_ID" --workspace-root "$WORKSPACE_ROOT" --bootstrap-token "$BOOTSTRAP_TOKEN" 2>&1)" \
  || fail "Bootstrap failed.\n$BOOTSTRAP_OUTPUT"
grep -q '"registration"' <<<"$BOOTSTRAP_OUTPUT" || fail "Bootstrap completed without a registration payload.\n$BOOTSTRAP_OUTPUT"
grep -q '"sync"' <<<"$BOOTSTRAP_OUTPUT" || fail "Bootstrap completed without the initial sync payload.\n$BOOTSTRAP_OUTPUT"

echo "Running a one-time sync check..."
SYNC_OUTPUT="$(agentgit-cloud-connector sync-once --workspace-root "$WORKSPACE_ROOT" 2>&1)" \
  || fail "sync-once failed.\n$SYNC_OUTPUT"
grep -q '"published"' <<<"$SYNC_OUTPUT" || fail "sync-once did not report published data.\n$SYNC_OUTPUT"

cat <<EOF
Success: the first connector is online.

Next steps:
1. Open AgentGit Cloud and confirm the connector shows as active.
2. Trigger one governed action so the approval and activity views populate.
3. Start the long-running daemon with:
   agentgit-cloud-connector run --workspace-root "$WORKSPACE_ROOT"
EOF
