import postgres from "postgres";

import { getDatabaseUrl } from "@/lib/db/client";

const statements = [
  `create table if not exists cloud_users (
    id text primary key,
    email text not null,
    name text not null,
    github_login text,
    image_url text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    last_signed_in_at timestamptz
  )`,
  `create unique index if not exists cloud_users_email_idx on cloud_users (email)`,
  `create unique index if not exists cloud_users_github_login_idx on cloud_users (github_login) where github_login is not null`,
  `create table if not exists cloud_workspaces (
    id text primary key,
    name text not null,
    slug text not null,
    default_notification_channel text not null,
    policy_pack text not null,
    launched_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  `create unique index if not exists cloud_workspaces_slug_idx on cloud_workspaces (slug)`,
  `create table if not exists cloud_workspace_memberships (
    workspace_id text not null references cloud_workspaces(id) on delete cascade,
    user_id text not null references cloud_users(id) on delete cascade,
    role text not null,
    joined_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint cloud_workspace_memberships_pk primary key (workspace_id, user_id)
  )`,
  `create table if not exists cloud_workspace_invites (
    id text primary key,
    workspace_id text not null references cloud_workspaces(id) on delete cascade,
    email text not null,
    name text not null,
    role text not null,
    invited_by_user_id text references cloud_users(id) on delete set null,
    invited_at timestamptz not null default now(),
    accepted_at timestamptz,
    revoked_at timestamptz
  )`,
  `create unique index if not exists cloud_workspace_invites_workspace_email_idx on cloud_workspace_invites (workspace_id, email)`,
  `create table if not exists cloud_workspace_repositories (
    workspace_id text not null references cloud_workspaces(id) on delete cascade,
    repository_id text not null,
    created_at timestamptz not null default now(),
    constraint cloud_workspace_repositories_pk primary key (workspace_id, repository_id)
  )`,
  `create table if not exists cloud_workspace_settings (
    workspace_id text primary key references cloud_workspaces(id) on delete cascade,
    settings jsonb not null,
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists cloud_workspace_billing (
    workspace_id text primary key references cloud_workspaces(id) on delete cascade,
    billing jsonb not null,
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists cloud_workspace_integrations (
    workspace_id text primary key references cloud_workspaces(id) on delete cascade,
    integrations jsonb not null,
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists cloud_workspace_integration_secrets (
    workspace_id text primary key references cloud_workspaces(id) on delete cascade,
    slack_webhook_url text,
    updated_at timestamptz not null default now()
  )`,
  `create table if not exists cloud_repository_policy_versions (
    id text primary key,
    workspace_id text not null references cloud_workspaces(id) on delete cascade,
    repository_id text not null,
    repository_owner text not null,
    repository_name text not null,
    policy_path text not null,
    document jsonb not null,
    document_hash text not null,
    profile_name text not null,
    policy_version text not null,
    rule_count integer not null,
    threshold_count integer not null,
    change_source text not null,
    actor_user_id text references cloud_users(id) on delete set null,
    actor_name text not null,
    actor_email text not null,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists cloud_repository_policy_versions_workspace_repo_created_idx on cloud_repository_policy_versions (workspace_id, repository_id, created_at)`,
  `create table if not exists cloud_rate_limit_buckets (
    bucket_key text primary key,
    scope text not null,
    identifier_hash text not null,
    count integer not null,
    reset_at timestamptz not null,
    updated_at timestamptz not null default now()
  )`,
  `create index if not exists cloud_rate_limit_buckets_reset_at_idx on cloud_rate_limit_buckets (reset_at)`,
  `create table if not exists cloud_identity_bootstrap_state (
    id text primary key default 'singleton',
    bootstrapped boolean not null default false,
    bootstrapped_at timestamptz
  )`,
];

async function main() {
  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set before running migrations.");
  }

  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  try {
    for (const statement of statements) {
      await sql.unsafe(statement);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
