import "server-only";

import { getWorkspaceConnectionState, saveWorkspaceConnectionState } from "@/lib/backend/workspace/cloud-state";
import { assertWorkspaceUsageWithinBillingLimits } from "@/lib/backend/workspace/workspace-billing";
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

function buildMemberId(status: "active" | "invited", index: number): string {
  return `member_${status}_${index + 1}`;
}

async function buildFallbackWorkspaceState(workspaceSession: WorkspaceSession): Promise<WorkspaceConnectionState> {
  return {
    workspaceId: workspaceSession.activeWorkspace.id,
    workspaceName: workspaceSession.activeWorkspace.name,
    workspaceSlug: workspaceSession.activeWorkspace.slug,
    repositoryIds: [],
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
      ...members.map((member, index) => ({
        id: buildMemberId("active", index),
        name: member.name,
        email: member.email,
        role: member.role,
        status: "active" as const,
      })),
      ...invites.map((invite, index) => ({
        id: buildMemberId("invited", index),
        name: invite.name,
        email: invite.email,
        role: invite.role,
        status: "invited" as const,
      })),
    ],
  });
}

export async function resolveWorkspaceTeam(workspaceSession: WorkspaceSession): Promise<WorkspaceTeamSnapshot> {
  const workspaceState =
    (await getWorkspaceConnectionState(workspaceSession.activeWorkspace.id)) ??
    (await buildFallbackWorkspaceState(workspaceSession));

  return toWorkspaceTeamSnapshot(
    ensureWorkspaceMember(workspaceState.members, workspaceSession),
    workspaceState.invites,
    workspaceState,
  );
}

export async function saveWorkspaceTeam(
  workspaceSession: WorkspaceSession,
  update: WorkspaceTeamUpdate,
): Promise<WorkspaceTeamSaveResponse> {
  const currentState =
    (await getWorkspaceConnectionState(workspaceSession.activeWorkspace.id)) ??
    (await buildFallbackWorkspaceState(workspaceSession));

  const persistedState: WorkspaceConnectionState = {
    ...currentState,
    workspaceId: workspaceSession.activeWorkspace.id,
    workspaceName: workspaceSession.activeWorkspace.name,
    workspaceSlug: workspaceSession.activeWorkspace.slug,
    members: ensureWorkspaceMember(currentState.members, workspaceSession),
    invites: update.invites,
  };

  await assertWorkspaceUsageWithinBillingLimits(workspaceSession, {
    usageOverrides: {
      seatsUsed: persistedState.members.length + persistedState.invites.length,
    },
    dimensions: ["seats"],
  });

  const savedState = await saveWorkspaceConnectionState(persistedState);
  const savedAt = new Date().toISOString();

  return {
    team: toWorkspaceTeamSnapshot(savedState.members, savedState.invites, savedState),
    savedAt,
    message: "Team roster saved to workspace state.",
  };
}
