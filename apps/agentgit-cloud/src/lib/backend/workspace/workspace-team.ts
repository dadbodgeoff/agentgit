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
  type WorkspaceMembership,
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
    // Before onboarding persists workspace scope, seed visibility from the
    // discovered local repository inventory instead of an empty workspace filter.
    repositoryIds: collectWorkspaceRepositoryRuntimeRecords().map((record) => record.inventory.id),
    members: [
      {
        name: workspaceSession.user.name,
        email: workspaceSession.user.email,
        role: workspaceSession.activeWorkspace.role,
      },
    ],
    invites: [],
    defaultNotificationChannel: "in_app",
    policyPack: "guarded",
    launchedAt: new Date().toISOString(),
  };
}

function ensureWorkspaceMember(
  members: WorkspaceMembership[],
  workspaceSession: WorkspaceSession,
): WorkspaceMembership[] {
  const identity = workspaceSession.user.email.trim().toLowerCase();
  const retained = members.filter((member) => member.email.trim().toLowerCase() !== identity);

  return [
    ...retained,
    {
      name: workspaceSession.user.name,
      email: workspaceSession.user.email,
      role: workspaceSession.activeWorkspace.role,
    },
  ];
}

function toWorkspaceTeamSnapshot(
  members: WorkspaceMembership[],
  invites: OnboardingTeamInvite[],
  workspaceState: WorkspaceConnectionState,
): WorkspaceTeamSnapshot {
  return WorkspaceTeamSnapshotSchema.parse({
    workspaceId: workspaceState.workspaceId,
    workspaceName: workspaceState.workspaceName,
    workspaceSlug: workspaceState.workspaceSlug,
    inviteLimit: WORKSPACE_TEAM_INVITE_LIMIT,
    members: [
      ...members.map((member) => ({
        id: buildMemberId(member.email, "active"),
        name: member.name,
        email: member.email,
        role: member.role,
        status: "active" as const,
      })),
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

  return toWorkspaceTeamSnapshot(
    ensureWorkspaceMember(workspaceState.members, workspaceSession),
    workspaceState.invites,
    workspaceState,
  );
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
    members: ensureWorkspaceMember(currentState.members, workspaceSession),
    invites: update.invites,
  };

  const savedState = saveWorkspaceConnectionState(persistedState);
  const savedAt = new Date().toISOString();

  return {
    team: toWorkspaceTeamSnapshot(savedState.members, savedState.invites, savedState),
    savedAt,
    message: "Team roster saved to workspace state.",
  };
}
