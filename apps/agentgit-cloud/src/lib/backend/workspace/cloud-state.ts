import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { getCloudDatabase, hasDatabaseUrl } from "@/lib/db/client";
import {
  cloudUsers,
  cloudWorkspaces,
  cloudWorkspaceBilling,
  cloudWorkspaceIntegrations,
  cloudWorkspaceIntegrationSecrets,
  cloudWorkspaceInvites,
  cloudWorkspaceMemberships,
  cloudWorkspaceRepositories,
  cloudWorkspaceSsoSecrets,
  cloudWorkspaceSettings,
} from "@/lib/db/schema";
import {
  findStoredWorkspaceSettingsBySlugLocal,
  findWorkspaceConnectionStateBySlugLocal,
  getStoredWorkspaceBillingLocal,
  getStoredWorkspaceIntegrationsLocal,
  getStoredWorkspaceSettingsLocal,
  getWorkspaceIntegrationSecretsLocal,
  getWorkspaceSsoSecretsLocal,
  getWorkspaceConnectionStateLocal,
  listWorkspaceConnectionStatesLocal,
  listStoredWorkspaceBillingsLocal,
  saveStoredWorkspaceBillingLocal,
  saveStoredWorkspaceIntegrationsLocal,
  saveStoredWorkspaceSettingsLocal,
  saveWorkspaceIntegrationSecretsLocal,
  saveWorkspaceSsoSecretsLocal,
  saveWorkspaceConnectionStateLocal,
  type WorkspaceIntegrationSecrets,
  type WorkspaceSsoSecrets,
} from "@/lib/backend/workspace/cloud-state.local";
import {
  WorkspaceConnectionStateSchema,
  WorkspaceSettingsSchema,
  type OnboardingTeamInvite,
  type WorkspaceBilling,
  type WorkspaceConnectionState,
  type WorkspaceIntegrationSnapshot,
  type WorkspaceMembership,
  type WorkspaceRole,
  type WorkspaceSettings,
} from "@/schemas/cloud";

export type PersistedWorkspaceAccessMatch = {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  role: WorkspaceRole;
  source: "member" | "invite";
};

export type PersistedCloudUser = {
  id: string;
  email: string;
  name: string;
  githubLogin: string | null;
  imageUrl: string | null;
};

export type { WorkspaceSsoSecrets } from "@/lib/backend/workspace/cloud-state.local";

function normalizeEmail(value?: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeLogin(value?: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function createInviteId(workspaceId: string, email: string) {
  const digest = createHash("sha256").update(`${workspaceId}:${email}`, "utf8").digest("hex");
  return `win_${digest.slice(0, 16)}`;
}

async function hydrateWorkspaceConnectionState(workspaceId: string): Promise<WorkspaceConnectionState | null> {
  const db = getCloudDatabase();
  const workspace = await db.query.cloudWorkspaces.findFirst({
    where: eq(cloudWorkspaces.id, workspaceId),
  });

  if (!workspace) {
    return null;
  }

  const [membershipRows, inviteRows, repositoryRows] = await Promise.all([
    db
      .select({
        name: cloudUsers.name,
        email: cloudUsers.email,
        role: cloudWorkspaceMemberships.role,
      })
      .from(cloudWorkspaceMemberships)
      .innerJoin(cloudUsers, eq(cloudWorkspaceMemberships.userId, cloudUsers.id))
      .where(eq(cloudWorkspaceMemberships.workspaceId, workspace.id))
      .orderBy(asc(cloudWorkspaceMemberships.joinedAt)),
    db
      .select({
        name: cloudWorkspaceInvites.name,
        email: cloudWorkspaceInvites.email,
        role: cloudWorkspaceInvites.role,
      })
      .from(cloudWorkspaceInvites)
      .where(
        and(
          eq(cloudWorkspaceInvites.workspaceId, workspace.id),
          isNull(cloudWorkspaceInvites.acceptedAt),
          isNull(cloudWorkspaceInvites.revokedAt),
        ),
      )
      .orderBy(asc(cloudWorkspaceInvites.invitedAt)),
    db
      .select({
        repositoryId: cloudWorkspaceRepositories.repositoryId,
      })
      .from(cloudWorkspaceRepositories)
      .where(eq(cloudWorkspaceRepositories.workspaceId, workspace.id))
      .orderBy(asc(cloudWorkspaceRepositories.createdAt)),
  ]);

  return WorkspaceConnectionStateSchema.parse({
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceSlug: workspace.slug,
    repositoryIds: repositoryRows.map((row) => row.repositoryId),
    members: membershipRows satisfies WorkspaceMembership[],
    invites: inviteRows satisfies OnboardingTeamInvite[],
    defaultNotificationChannel: workspace.defaultNotificationChannel,
    policyPack: workspace.policyPack,
    launchedAt: workspace.launchedAt.toISOString(),
  });
}

async function listWorkspaceConnectionStatesFromDatabase(): Promise<WorkspaceConnectionState[]> {
  const db = getCloudDatabase();
  const workspaces = await db
    .select({
      id: cloudWorkspaces.id,
    })
    .from(cloudWorkspaces)
    .orderBy(asc(cloudWorkspaces.createdAt));

  const states = await Promise.all(workspaces.map((workspace) => hydrateWorkspaceConnectionState(workspace.id)));
  return states.filter((state): state is WorkspaceConnectionState => state !== null);
}

export async function getWorkspaceConnectionState(workspaceId: string): Promise<WorkspaceConnectionState | null> {
  if (!hasDatabaseUrl()) {
    return getWorkspaceConnectionStateLocal(workspaceId);
  }

  return hydrateWorkspaceConnectionState(workspaceId);
}

export async function listWorkspaceConnectionStates(): Promise<WorkspaceConnectionState[]> {
  if (!hasDatabaseUrl()) {
    return listWorkspaceConnectionStatesLocal();
  }

  return listWorkspaceConnectionStatesFromDatabase();
}

export async function findWorkspaceConnectionStateBySlug(
  workspaceSlug: string,
): Promise<WorkspaceConnectionState | null> {
  if (!hasDatabaseUrl()) {
    return findWorkspaceConnectionStateBySlugLocal(workspaceSlug);
  }

  const db = getCloudDatabase();
  const workspace = await db.query.cloudWorkspaces.findFirst({
    columns: { id: true },
    where: eq(cloudWorkspaces.slug, workspaceSlug),
  });

  if (!workspace) {
    return null;
  }

  return hydrateWorkspaceConnectionState(workspace.id);
}

export async function upsertCloudUser(params: {
  email: string;
  name: string;
  githubLogin?: string | null;
  imageUrl?: string | null;
  lastSignedInAt?: string;
}): Promise<PersistedCloudUser> {
  const normalizedEmail = normalizeEmail(params.email);
  if (!normalizedEmail) {
    throw new Error("Cloud users require a normalized email.");
  }

  if (!hasDatabaseUrl()) {
    return {
      id: normalizedEmail,
      email: normalizedEmail,
      name: params.name,
      githubLogin: normalizeLogin(params.githubLogin),
      imageUrl: params.imageUrl ?? null,
    };
  }

  const db = getCloudDatabase();
  const normalizedLogin = normalizeLogin(params.githubLogin);
  const [existing] = await db
    .select()
    .from(cloudUsers)
    .where(
      normalizedLogin
        ? or(eq(cloudUsers.email, normalizedEmail), eq(cloudUsers.githubLogin, normalizedLogin))
        : eq(cloudUsers.email, normalizedEmail),
    )
    .limit(1);

  const now = params.lastSignedInAt ? new Date(params.lastSignedInAt) : new Date();

  if (existing) {
    const [updated] = await db
      .update(cloudUsers)
      .set({
        email: normalizedEmail,
        name: params.name,
        githubLogin: normalizedLogin ?? existing.githubLogin,
        imageUrl: params.imageUrl ?? existing.imageUrl,
        lastSignedInAt: now,
        updatedAt: now,
      })
      .where(eq(cloudUsers.id, existing.id))
      .returning();

    return {
      id: updated!.id,
      email: updated!.email,
      name: updated!.name,
      githubLogin: updated!.githubLogin,
      imageUrl: updated!.imageUrl,
    };
  }

  const [created] = await db
    .insert(cloudUsers)
    .values({
      id: `usr_${randomUUID().replaceAll("-", "")}`,
      email: normalizedEmail,
      name: params.name,
      githubLogin: normalizedLogin,
      imageUrl: params.imageUrl ?? null,
      createdAt: now,
      updatedAt: now,
      lastSignedInAt: now,
    })
    .returning();

  return {
    id: created!.id,
    email: created!.email,
    name: created!.name,
    githubLogin: created!.githubLogin,
    imageUrl: created!.imageUrl,
  };
}

export async function findWorkspaceAccessMatchesForIdentity(identity: {
  email?: string | null;
  login?: string | null;
}): Promise<PersistedWorkspaceAccessMatch[]> {
  const email = normalizeEmail(identity.email);
  const login = normalizeLogin(identity.login);

  if (!email && !login) {
    return [];
  }

  if (!hasDatabaseUrl()) {
    const matches: PersistedWorkspaceAccessMatch[] = [];
    for (const workspace of email ? listWorkspaceConnectionStatesLocal() : []) {
      const member = workspace.members.find((entry) => normalizeEmail(entry.email) === email);
      if (member) {
        matches.push({
          workspaceId: workspace.workspaceId,
          workspaceName: workspace.workspaceName,
          workspaceSlug: workspace.workspaceSlug,
          role: member.role,
          source: "member",
        });
        continue;
      }

      const invite = workspace.invites.find((entry) => normalizeEmail(entry.email) === email);
      if (invite) {
        matches.push({
          workspaceId: workspace.workspaceId,
          workspaceName: workspace.workspaceName,
          workspaceSlug: workspace.workspaceSlug,
          role: invite.role,
          source: "invite",
        });
      }
    }

    return matches;
  }

  const db = getCloudDatabase();
  const users = await db
    .select({
      id: cloudUsers.id,
    })
    .from(cloudUsers)
    .where(
      login
        ? or(eq(cloudUsers.email, email ?? ""), eq(cloudUsers.githubLogin, login))
        : eq(cloudUsers.email, email ?? ""),
    );

  const userIds = users.map((user) => user.id);
  const matches: PersistedWorkspaceAccessMatch[] = [];

  if (userIds.length > 0) {
    const membershipRows = await db
      .select({
        workspaceId: cloudWorkspaces.id,
        workspaceName: cloudWorkspaces.name,
        workspaceSlug: cloudWorkspaces.slug,
        role: cloudWorkspaceMemberships.role,
      })
      .from(cloudWorkspaceMemberships)
      .innerJoin(cloudWorkspaces, eq(cloudWorkspaceMemberships.workspaceId, cloudWorkspaces.id))
      .where(inArray(cloudWorkspaceMemberships.userId, userIds));

    for (const membership of membershipRows) {
      matches.push({
        workspaceId: membership.workspaceId,
        workspaceName: membership.workspaceName,
        workspaceSlug: membership.workspaceSlug,
        role: membership.role,
        source: "member",
      });
    }
  }

  if (email) {
    const inviteRows = await db
      .select({
        workspaceId: cloudWorkspaces.id,
        workspaceName: cloudWorkspaces.name,
        workspaceSlug: cloudWorkspaces.slug,
        role: cloudWorkspaceInvites.role,
      })
      .from(cloudWorkspaceInvites)
      .innerJoin(cloudWorkspaces, eq(cloudWorkspaceInvites.workspaceId, cloudWorkspaces.id))
      .where(
        and(
          eq(cloudWorkspaceInvites.email, email),
          isNull(cloudWorkspaceInvites.acceptedAt),
          isNull(cloudWorkspaceInvites.revokedAt),
        ),
      );

    for (const invite of inviteRows) {
      if (matches.some((match) => match.workspaceId === invite.workspaceId && match.source === "member")) {
        continue;
      }

      matches.push({
        workspaceId: invite.workspaceId,
        workspaceName: invite.workspaceName,
        workspaceSlug: invite.workspaceSlug,
        role: invite.role,
        source: "invite",
      });
    }
  }

  return matches;
}

export async function saveWorkspaceConnectionState(state: WorkspaceConnectionState): Promise<WorkspaceConnectionState> {
  if (!hasDatabaseUrl()) {
    return saveWorkspaceConnectionStateLocal(state);
  }

  const db = getCloudDatabase();
  const normalizedMembers = state.members.map((member) => ({
    ...member,
    email: normalizeEmail(member.email) ?? member.email,
  }));
  const normalizedInvites = state.invites.map((invite) => ({
    ...invite,
    email: normalizeEmail(invite.email) ?? invite.email,
  }));
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx.execute(sql`set local transaction isolation level serializable`);

    const upsertMember = async (member: WorkspaceMembership) => {
      const [existing] = await tx.select().from(cloudUsers).where(eq(cloudUsers.email, member.email)).limit(1);
      if (existing) {
        const [updated] = await tx
          .update(cloudUsers)
          .set({
            name: member.name,
            updatedAt: now,
          })
          .where(eq(cloudUsers.id, existing.id))
          .returning();

        return updated!;
      }

      const [created] = await tx
        .insert(cloudUsers)
        .values({
          id: `usr_${randomUUID().replaceAll("-", "")}`,
          email: member.email,
          name: member.name,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return created!;
    };

    await tx
      .insert(cloudWorkspaces)
      .values({
        id: state.workspaceId,
        name: state.workspaceName,
        slug: state.workspaceSlug,
        defaultNotificationChannel: state.defaultNotificationChannel,
        policyPack: state.policyPack,
        launchedAt: new Date(state.launchedAt),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: cloudWorkspaces.id,
        set: {
          name: state.workspaceName,
          slug: state.workspaceSlug,
          defaultNotificationChannel: state.defaultNotificationChannel,
          policyPack: state.policyPack,
          launchedAt: new Date(state.launchedAt),
          updatedAt: now,
        },
      });

    await tx.delete(cloudWorkspaceRepositories).where(eq(cloudWorkspaceRepositories.workspaceId, state.workspaceId));
    if (state.repositoryIds.length > 0) {
      await tx.insert(cloudWorkspaceRepositories).values(
        state.repositoryIds.map((repositoryId) => ({
          workspaceId: state.workspaceId,
          repositoryId,
          createdAt: now,
        })),
      );
    }

    await tx.delete(cloudWorkspaceMemberships).where(eq(cloudWorkspaceMemberships.workspaceId, state.workspaceId));
    for (const member of normalizedMembers) {
      const user = await upsertMember(member);
      await tx.insert(cloudWorkspaceMemberships).values({
        workspaceId: state.workspaceId,
        userId: user.id,
        role: member.role,
        joinedAt: now,
        updatedAt: now,
      });
    }

    await tx.delete(cloudWorkspaceInvites).where(eq(cloudWorkspaceInvites.workspaceId, state.workspaceId));
    if (normalizedInvites.length > 0) {
      await tx.insert(cloudWorkspaceInvites).values(
        normalizedInvites.map((invite) => ({
          id: createInviteId(state.workspaceId, invite.email),
          workspaceId: state.workspaceId,
          email: invite.email,
          name: invite.name,
          role: invite.role,
          invitedAt: now,
        })),
      );
    }
  });

  const hydrated = await hydrateWorkspaceConnectionState(state.workspaceId);
  if (!hydrated) {
    throw new Error(`Failed to hydrate workspace ${state.workspaceId} after save.`);
  }

  return hydrated;
}

export async function getStoredWorkspaceSettings(workspaceId: string): Promise<WorkspaceSettings | null> {
  if (!hasDatabaseUrl()) {
    return getStoredWorkspaceSettingsLocal(workspaceId);
  }

  const db = getCloudDatabase();
  const row = await db.query.cloudWorkspaceSettings.findFirst({
    columns: { settings: true },
    where: eq(cloudWorkspaceSettings.workspaceId, workspaceId),
  });
  if (!row) {
    return null;
  }

  return WorkspaceSettingsSchema.parse(row.settings);
}

export async function saveStoredWorkspaceSettings(
  workspaceId: string,
  settings: WorkspaceSettings,
): Promise<WorkspaceSettings> {
  if (!hasDatabaseUrl()) {
    return saveStoredWorkspaceSettingsLocal(workspaceId, settings);
  }

  const db = getCloudDatabase();
  const now = new Date();
  await db
    .insert(cloudWorkspaceSettings)
    .values({
      workspaceId,
      settings,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: cloudWorkspaceSettings.workspaceId,
      set: {
        settings,
        updatedAt: now,
      },
    });

  return settings;
}

export async function findStoredWorkspaceSettingsBySlug(workspaceSlug: string): Promise<{
  workspaceId: string;
  settings: WorkspaceSettings;
} | null> {
  if (!hasDatabaseUrl()) {
    return findStoredWorkspaceSettingsBySlugLocal(workspaceSlug);
  }

  const db = getCloudDatabase();
  const workspace = await db.query.cloudWorkspaces.findFirst({
    columns: { id: true },
    where: eq(cloudWorkspaces.slug, workspaceSlug),
  });

  if (!workspace) {
    return null;
  }

  const settings = await getStoredWorkspaceSettings(workspace.id);
  if (!settings) {
    return null;
  }

  return {
    workspaceId: workspace.id,
    settings,
  };
}

export async function provisionWorkspaceMembershipForIdentity(params: {
  workspaceId: string;
  email: string;
  name: string;
  fallbackRole: WorkspaceRole;
  githubLogin?: string | null;
  imageUrl?: string | null;
}): Promise<PersistedWorkspaceAccessMatch | null> {
  const email = normalizeEmail(params.email);
  if (!email) {
    return null;
  }

  if (!hasDatabaseUrl()) {
    const workspace = getWorkspaceConnectionStateLocal(params.workspaceId);
    if (!workspace) {
      return null;
    }

    const existingMember = workspace.members.find((member) => normalizeEmail(member.email) === email);
    if (existingMember) {
      return {
        workspaceId: workspace.workspaceId,
        workspaceName: workspace.workspaceName,
        workspaceSlug: workspace.workspaceSlug,
        role: existingMember.role,
        source: "member",
      };
    }

    const invite = workspace.invites.find((entry) => normalizeEmail(entry.email) === email);
    const role = invite?.role ?? params.fallbackRole;
    saveWorkspaceConnectionStateLocal({
      ...workspace,
      members: [
        ...workspace.members,
        {
          name: params.name,
          email,
          role,
        },
      ],
      invites: workspace.invites.filter((entry) => normalizeEmail(entry.email) !== email),
    });

    return {
      workspaceId: workspace.workspaceId,
      workspaceName: workspace.workspaceName,
      workspaceSlug: workspace.workspaceSlug,
      role,
      source: invite ? "invite" : "member",
    };
  }

  const db = getCloudDatabase();
  const workspace = await db.query.cloudWorkspaces.findFirst({
    where: eq(cloudWorkspaces.id, params.workspaceId),
  });

  if (!workspace) {
    return null;
  }

  const user = await upsertCloudUser({
    email,
    name: params.name,
    githubLogin: params.githubLogin,
    imageUrl: params.imageUrl,
    lastSignedInAt: new Date().toISOString(),
  });

  const { role, source } = await db.transaction(async (tx) => {
    const now = new Date();
    const existingMembership = await tx.query.cloudWorkspaceMemberships.findFirst({
      where: and(
        eq(cloudWorkspaceMemberships.workspaceId, params.workspaceId),
        eq(cloudWorkspaceMemberships.userId, user.id),
      ),
    });

    const [acceptedInvite] = await tx
      .update(cloudWorkspaceInvites)
      .set({
        acceptedAt: now,
      })
      .where(
        and(
          eq(cloudWorkspaceInvites.workspaceId, params.workspaceId),
          eq(cloudWorkspaceInvites.email, email),
          isNull(cloudWorkspaceInvites.acceptedAt),
          isNull(cloudWorkspaceInvites.revokedAt),
        ),
      )
      .returning({
        role: cloudWorkspaceInvites.role,
      });

    const resolvedRole = existingMembership?.role ?? acceptedInvite?.role ?? params.fallbackRole;
    if (!existingMembership) {
      await tx
        .insert(cloudWorkspaceMemberships)
        .values({
          workspaceId: params.workspaceId,
          userId: user.id,
          role: resolvedRole,
          joinedAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }

    return {
      role: resolvedRole,
      source: acceptedInvite ? ("invite" as const) : ("member" as const),
    };
  });

  return {
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspaceSlug: workspace.slug,
    role,
    source,
  };
}

export async function getStoredWorkspaceBilling(workspaceId: string): Promise<WorkspaceBilling | null> {
  if (!hasDatabaseUrl()) {
    return getStoredWorkspaceBillingLocal(workspaceId);
  }

  const db = getCloudDatabase();
  const row = await db.query.cloudWorkspaceBilling.findFirst({
    columns: { billing: true },
    where: eq(cloudWorkspaceBilling.workspaceId, workspaceId),
  });
  return row?.billing ?? null;
}

export async function listStoredWorkspaceBillings(): Promise<WorkspaceBilling[]> {
  if (!hasDatabaseUrl()) {
    return listStoredWorkspaceBillingsLocal();
  }

  const db = getCloudDatabase();
  const rows = await db.query.cloudWorkspaceBilling.findMany({
    columns: { billing: true },
    orderBy: asc(cloudWorkspaceBilling.updatedAt),
  });

  return rows.map((row) => row.billing);
}

export async function saveStoredWorkspaceBilling(
  workspaceId: string,
  billing: WorkspaceBilling,
): Promise<WorkspaceBilling> {
  if (!hasDatabaseUrl()) {
    return saveStoredWorkspaceBillingLocal(workspaceId, billing);
  }

  const db = getCloudDatabase();
  const now = new Date();
  await db
    .insert(cloudWorkspaceBilling)
    .values({
      workspaceId,
      billing,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: cloudWorkspaceBilling.workspaceId,
      set: {
        billing,
        updatedAt: now,
      },
    });

  return billing;
}

export async function getStoredWorkspaceIntegrations(
  workspaceId: string,
): Promise<WorkspaceIntegrationSnapshot | null> {
  if (!hasDatabaseUrl()) {
    return getStoredWorkspaceIntegrationsLocal(workspaceId);
  }

  const db = getCloudDatabase();
  const row = await db.query.cloudWorkspaceIntegrations.findFirst({
    columns: { integrations: true },
    where: eq(cloudWorkspaceIntegrations.workspaceId, workspaceId),
  });
  return row?.integrations ?? null;
}

export async function saveStoredWorkspaceIntegrations(
  workspaceId: string,
  integrations: WorkspaceIntegrationSnapshot,
): Promise<WorkspaceIntegrationSnapshot> {
  if (!hasDatabaseUrl()) {
    return saveStoredWorkspaceIntegrationsLocal(workspaceId, integrations);
  }

  const db = getCloudDatabase();
  const now = new Date();
  await db
    .insert(cloudWorkspaceIntegrations)
    .values({
      workspaceId,
      integrations,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: cloudWorkspaceIntegrations.workspaceId,
      set: {
        integrations,
        updatedAt: now,
      },
    });

  return integrations;
}

export async function getWorkspaceIntegrationSecrets(workspaceId: string): Promise<WorkspaceIntegrationSecrets | null> {
  if (!hasDatabaseUrl()) {
    return getWorkspaceIntegrationSecretsLocal(workspaceId);
  }

  const db = getCloudDatabase();
  const row = await db.query.cloudWorkspaceIntegrationSecrets.findFirst({
    columns: { slackWebhookUrl: true },
    where: eq(cloudWorkspaceIntegrationSecrets.workspaceId, workspaceId),
  });

  if (!row) {
    return null;
  }

  return {
    slackWebhookUrl: row.slackWebhookUrl,
  };
}

export async function saveWorkspaceIntegrationSecrets(
  workspaceId: string,
  secrets: WorkspaceIntegrationSecrets,
): Promise<WorkspaceIntegrationSecrets> {
  if (!hasDatabaseUrl()) {
    return saveWorkspaceIntegrationSecretsLocal(workspaceId, secrets);
  }

  const db = getCloudDatabase();
  const now = new Date();
  await db
    .insert(cloudWorkspaceIntegrationSecrets)
    .values({
      workspaceId,
      slackWebhookUrl: secrets.slackWebhookUrl,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: cloudWorkspaceIntegrationSecrets.workspaceId,
      set: {
        slackWebhookUrl: secrets.slackWebhookUrl,
        updatedAt: now,
      },
    });

  return secrets;
}

export async function getWorkspaceSsoSecrets(workspaceId: string): Promise<WorkspaceSsoSecrets | null> {
  if (!hasDatabaseUrl()) {
    return getWorkspaceSsoSecretsLocal(workspaceId);
  }

  const db = getCloudDatabase();
  const row = await db.query.cloudWorkspaceSsoSecrets.findFirst({
    columns: { clientSecret: true },
    where: eq(cloudWorkspaceSsoSecrets.workspaceId, workspaceId),
  });

  if (!row) {
    return null;
  }

  return {
    clientSecret: row.clientSecret,
  };
}

export async function saveWorkspaceSsoSecrets(
  workspaceId: string,
  secrets: WorkspaceSsoSecrets,
): Promise<WorkspaceSsoSecrets> {
  if (!hasDatabaseUrl()) {
    return saveWorkspaceSsoSecretsLocal(workspaceId, secrets);
  }

  const db = getCloudDatabase();
  const now = new Date();
  await db
    .insert(cloudWorkspaceSsoSecrets)
    .values({
      workspaceId,
      clientSecret: secrets.clientSecret,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: cloudWorkspaceSsoSecrets.workspaceId,
      set: {
        clientSecret: secrets.clientSecret,
        updatedAt: now,
      },
    });

  return secrets;
}
