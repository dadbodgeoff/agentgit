import "server-only";

import { createHash } from "node:crypto";

import {
  getWorkspaceConnectionState,
  saveWorkspaceConnectionState,
} from "@/lib/backend/workspace/cloud-state";
import { collectWorkspaceRepositoryRuntimeRecords } from "@/lib/backend/workspace/repository-inventory";
import {
  WorkspaceTeamSnapshotSchema,
  type OnboardingTeamInvite,
  type WorkspaceConnectionState,
  type WorkspaceSession,
  type WorkspaceTeamSaveResponse,
  type WorkspaceTeamSnapshot,
  type WorkspaceTeamUpdate,
} from "@/schemas/cloud";

export const WORKSPACE_TEAM_INVITE_LIMIT = 20;

function buildMemberId(email: string, status: "active" | "invited"): string {
  const digest = createHash("sha256").update(`${status}:${email}`, "utf8").digest("hex");
  return `member_${digest.slice(0, 12)}`;
}

function buildFallbackWorkspaceState(workspaceSession: WorkspaceSession): WorkspaceConnectionState {
  return {
    workspaceId: workspaceSession.activeWorkspace.id,
    workspaceName: workspaceSession.activeWorkspace.name,
    workspaceSlug: workspaceSession.activeWorkspace.slug,
    repositoryIds: collectWorkspaceRepositoryRuntimeRecords(workspaceSession.activeWorkspace.id).map(
      (record) => record.inventory.id,
    ),
    invites: [],
    defaultNotificationChannel: "in_app",
    policyPack: "guarded",
    launchedAt: new Date().toISOString(),
  };
}

function toWorkspaceTeamSnapshot(
  workspaceSession: WorkspaceSession,
  invites: OnboardingTeamInvite[],
  workspaceState: WorkspaceConnectionState,
): WorkspaceTeamSnapshot {
  return WorkspaceTeamSnapshotSchema.parse({
    workspaceId: workspaceState.workspaceId,
    workspaceName: workspaceState.workspaceName,
    workspaceSlug: workspaceState.workspaceSlug,
    inviteLimit: WORKSPACE_TEAM_INVITE_LIMIT,
    members: [
      {
        id: buildMemberId(workspaceSession.user.email, "active"),
        name: workspaceSession.user.name,
        email: workspaceSession.user.email,
        role: workspaceSession.activeWorkspace.role,
        status: "active",
      },
      ...invites.map((invite) => ({
        id: buildMemberId(invite.email, "invited"),
        name: invite.name,
        email: invite.email,
        role: invite.role,
        status: "invited" as const,
      })),
    ],
  });
}

export function resolveWorkspaceTeam(workspaceSession: WorkspaceSession): WorkspaceTeamSnapshot {
  const workspaceState =
    getWorkspaceConnectionState(workspaceSession.activeWorkspace.id) ?? buildFallbackWorkspaceState(workspaceSession);

  return toWorkspaceTeamSnapshot(workspaceSession, workspaceState.invites, workspaceState);
}

export function saveWorkspaceTeam(
  workspaceSession: WorkspaceSession,
  update: WorkspaceTeamUpdate,
): WorkspaceTeamSaveResponse {
  const currentState =
    getWorkspaceConnectionState(workspaceSession.activeWorkspace.id) ?? buildFallbackWorkspaceState(workspaceSession);

  const persistedState: WorkspaceConnectionState = {
    ...currentState,
    workspaceId: workspaceSession.activeWorkspace.id,
    workspaceName: workspaceSession.activeWorkspace.name,
    workspaceSlug: workspaceSession.activeWorkspace.slug,
    invites: update.invites,
  };

  const savedState = saveWorkspaceConnectionState(persistedState);
  const savedAt = new Date().toISOString();

  return {
    team: toWorkspaceTeamSnapshot(workspaceSession, savedState.invites, savedState),
    savedAt,
    message: "Team roster saved to workspace state.",
  };
}
