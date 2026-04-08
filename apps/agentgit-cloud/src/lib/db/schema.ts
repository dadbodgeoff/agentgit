import { relations, sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

import type {
  RepositoryPolicyChangeSource,
  StoredRepositoryPolicyVersion,
  WorkspaceBilling,
  WorkspaceIntegrationSnapshot,
  WorkspaceRole,
  WorkspaceSettings,
} from "@/schemas/cloud";

export const cloudUsers = pgTable(
  "cloud_users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    githubLogin: text("github_login"),
    imageUrl: text("image_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastSignedInAt: timestamp("last_signed_in_at", { withTimezone: true }),
  },
  (table) => ({
    emailUnique: uniqueIndex("cloud_users_email_idx").on(table.email),
    githubLoginUnique: uniqueIndex("cloud_users_github_login_idx")
      .on(table.githubLogin)
      .where(sql`${table.githubLogin} is not null`),
  }),
);

export const cloudWorkspaces = pgTable(
  "cloud_workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    defaultNotificationChannel: text("default_notification_channel").notNull(),
    policyPack: text("policy_pack").notNull(),
    launchedAt: timestamp("launched_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    slugUnique: uniqueIndex("cloud_workspaces_slug_idx").on(table.slug),
  }),
);

export const cloudWorkspaceMemberships = pgTable(
  "cloud_workspace_memberships",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => cloudWorkspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => cloudUsers.id, { onDelete: "cascade" }),
    role: text("role").$type<WorkspaceRole>().notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.userId], name: "cloud_workspace_memberships_pk" }),
  }),
);

export const cloudWorkspaceInvites = pgTable(
  "cloud_workspace_invites",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => cloudWorkspaces.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: text("role").$type<WorkspaceRole>().notNull(),
    invitedByUserId: text("invited_by_user_id").references(() => cloudUsers.id, { onDelete: "set null" }),
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => ({
    workspaceEmailUnique: uniqueIndex("cloud_workspace_invites_workspace_email_idx").on(table.workspaceId, table.email),
  }),
);

export const cloudWorkspaceRepositories = pgTable(
  "cloud_workspace_repositories",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => cloudWorkspaces.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.repositoryId], name: "cloud_workspace_repositories_pk" }),
  }),
);

export const cloudWorkspaceSettings = pgTable("cloud_workspace_settings", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => cloudWorkspaces.id, { onDelete: "cascade" }),
  settings: jsonb("settings").$type<WorkspaceSettings>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cloudWorkspaceBilling = pgTable("cloud_workspace_billing", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => cloudWorkspaces.id, { onDelete: "cascade" }),
  billing: jsonb("billing").$type<WorkspaceBilling>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cloudWorkspaceIntegrations = pgTable("cloud_workspace_integrations", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => cloudWorkspaces.id, { onDelete: "cascade" }),
  integrations: jsonb("integrations").$type<WorkspaceIntegrationSnapshot>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cloudWorkspaceIntegrationSecrets = pgTable("cloud_workspace_integration_secrets", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => cloudWorkspaces.id, { onDelete: "cascade" }),
  slackWebhookUrl: text("slack_webhook_url"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cloudWorkspaceSsoSecrets = pgTable("cloud_workspace_sso_secrets", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => cloudWorkspaces.id, { onDelete: "cascade" }),
  clientSecret: text("client_secret"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const cloudRepositoryPolicyVersions = pgTable(
  "cloud_repository_policy_versions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => cloudWorkspaces.id, { onDelete: "cascade" }),
    repositoryId: text("repository_id").notNull(),
    repositoryOwner: text("repository_owner").notNull(),
    repositoryName: text("repository_name").notNull(),
    policyPath: text("policy_path").notNull(),
    document: jsonb("document").$type<StoredRepositoryPolicyVersion["document"]>().notNull(),
    documentHash: text("document_hash").notNull(),
    profileName: text("profile_name").notNull(),
    policyVersion: text("policy_version").notNull(),
    ruleCount: integer("rule_count").notNull(),
    thresholdCount: integer("threshold_count").notNull(),
    changeSource: text("change_source").$type<RepositoryPolicyChangeSource>().notNull(),
    actorUserId: text("actor_user_id").references(() => cloudUsers.id, { onDelete: "set null" }),
    actorName: text("actor_name").notNull(),
    actorEmail: text("actor_email").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workspaceRepoCreatedIdx: index("cloud_repository_policy_versions_workspace_repo_created_idx").on(
      table.workspaceId,
      table.repositoryId,
      table.createdAt,
    ),
  }),
);

export const cloudRateLimitBuckets = pgTable(
  "cloud_rate_limit_buckets",
  {
    bucketKey: text("bucket_key").primaryKey(),
    scope: text("scope").notNull(),
    identifierHash: text("identifier_hash").notNull(),
    count: integer("count").notNull(),
    resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    resetAtIdx: index("cloud_rate_limit_buckets_reset_at_idx").on(table.resetAt),
  }),
);

export const cloudWorkspaceRelations = relations(cloudWorkspaces, ({ many, one }) => ({
  memberships: many(cloudWorkspaceMemberships),
  invites: many(cloudWorkspaceInvites),
  repositories: many(cloudWorkspaceRepositories),
  repositoryPolicyVersions: many(cloudRepositoryPolicyVersions),
  settings: one(cloudWorkspaceSettings, {
    fields: [cloudWorkspaces.id],
    references: [cloudWorkspaceSettings.workspaceId],
  }),
  billing: one(cloudWorkspaceBilling, {
    fields: [cloudWorkspaces.id],
    references: [cloudWorkspaceBilling.workspaceId],
  }),
  integrations: one(cloudWorkspaceIntegrations, {
    fields: [cloudWorkspaces.id],
    references: [cloudWorkspaceIntegrations.workspaceId],
  }),
  integrationSecrets: one(cloudWorkspaceIntegrationSecrets, {
    fields: [cloudWorkspaces.id],
    references: [cloudWorkspaceIntegrationSecrets.workspaceId],
  }),
  ssoSecrets: one(cloudWorkspaceSsoSecrets, {
    fields: [cloudWorkspaces.id],
    references: [cloudWorkspaceSsoSecrets.workspaceId],
  }),
}));

export const cloudUserRelations = relations(cloudUsers, ({ many }) => ({
  memberships: many(cloudWorkspaceMemberships),
  invitesIssued: many(cloudWorkspaceInvites),
}));

export const cloudWorkspaceMembershipRelations = relations(cloudWorkspaceMemberships, ({ one }) => ({
  workspace: one(cloudWorkspaces, {
    fields: [cloudWorkspaceMemberships.workspaceId],
    references: [cloudWorkspaces.id],
  }),
  user: one(cloudUsers, {
    fields: [cloudWorkspaceMemberships.userId],
    references: [cloudUsers.id],
  }),
}));

export const cloudWorkspaceInviteRelations = relations(cloudWorkspaceInvites, ({ one }) => ({
  workspace: one(cloudWorkspaces, {
    fields: [cloudWorkspaceInvites.workspaceId],
    references: [cloudWorkspaces.id],
  }),
  invitedBy: one(cloudUsers, {
    fields: [cloudWorkspaceInvites.invitedByUserId],
    references: [cloudUsers.id],
  }),
}));

export const cloudWorkspaceRepositoryRelations = relations(cloudWorkspaceRepositories, ({ one }) => ({
  workspace: one(cloudWorkspaces, {
    fields: [cloudWorkspaceRepositories.workspaceId],
    references: [cloudWorkspaces.id],
  }),
}));

export const cloudWorkspaceSettingsRelations = relations(cloudWorkspaceSettings, ({ one }) => ({
  workspace: one(cloudWorkspaces, {
    fields: [cloudWorkspaceSettings.workspaceId],
    references: [cloudWorkspaces.id],
  }),
}));

export const cloudRepositoryPolicyVersionRelations = relations(cloudRepositoryPolicyVersions, ({ one }) => ({
  workspace: one(cloudWorkspaces, {
    fields: [cloudRepositoryPolicyVersions.workspaceId],
    references: [cloudWorkspaces.id],
  }),
  actor: one(cloudUsers, {
    fields: [cloudRepositoryPolicyVersions.actorUserId],
    references: [cloudUsers.id],
  }),
}));

export const cloudWorkspaceBillingRelations = relations(cloudWorkspaceBilling, ({ one }) => ({
  workspace: one(cloudWorkspaces, {
    fields: [cloudWorkspaceBilling.workspaceId],
    references: [cloudWorkspaces.id],
  }),
}));

export const cloudWorkspaceIntegrationsRelations = relations(cloudWorkspaceIntegrations, ({ one }) => ({
  workspace: one(cloudWorkspaces, {
    fields: [cloudWorkspaceIntegrations.workspaceId],
    references: [cloudWorkspaces.id],
  }),
}));

export const cloudWorkspaceIntegrationSecretsRelations = relations(cloudWorkspaceIntegrationSecrets, ({ one }) => ({
  workspace: one(cloudWorkspaces, {
    fields: [cloudWorkspaceIntegrationSecrets.workspaceId],
    references: [cloudWorkspaces.id],
  }),
}));

export const cloudIdentityBootstrapState = pgTable("cloud_identity_bootstrap_state", {
  id: text("id").primaryKey().default("singleton"),
  bootstrapped: boolean("bootstrapped").notNull().default(false),
  bootstrappedAt: timestamp("bootstrapped_at", { withTimezone: true }),
});
