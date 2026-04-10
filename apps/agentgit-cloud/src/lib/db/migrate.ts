import { createHash } from "node:crypto";
import postgres, { type Sql } from "postgres";

import { getDatabaseUrl } from "@/lib/db/client";

type MigrationStep = (sql: Sql) => Promise<unknown>;

function migrationStepId(step: MigrationStep): string {
  return createHash("sha256").update(step.toString(), "utf8").digest("hex");
}

const migrationSteps: MigrationStep[] = [
  (sql) => sql`create table if not exists cloud_users (
    id text primary key,
    email text not null,
    name text not null,
    github_login text,
    image_url text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    last_signed_in_at timestamptz
  )`,
  (sql) => sql`create unique index if not exists cloud_users_email_idx on cloud_users (email)`,
  (sql) =>
    sql`create unique index if not exists cloud_users_github_login_idx on cloud_users (github_login) where github_login is not null`,
  (sql) => sql`create table if not exists cloud_workspaces (
    id text primary key,
    name text not null,
    slug text not null,
    default_notification_channel text not null,
    policy_pack text not null,
    launched_at timestamptz not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`,
  (sql) => sql`create unique index if not exists cloud_workspaces_slug_idx on cloud_workspaces (slug)`,
  (sql) => sql`create table if not exists cloud_workspace_memberships (
    workspace_id text not null references cloud_workspaces(id) on delete cascade,
    user_id text not null references cloud_users(id) on delete cascade,
    role text not null,
    joined_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint cloud_workspace_memberships_pk primary key (workspace_id, user_id),
    constraint cloud_workspace_memberships_role_check check (role in ('member', 'admin', 'owner'))
  )`,
  (sql) => sql`do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'cloud_workspace_memberships_role_check'
      ) then
        alter table cloud_workspace_memberships
        add constraint cloud_workspace_memberships_role_check
        check (role in ('member', 'admin', 'owner'));
      end if;
    end;
  $$`,
  (sql) => sql`create table if not exists cloud_workspace_invites (
    id text primary key,
    workspace_id text not null references cloud_workspaces(id) on delete cascade,
    email text not null,
    name text not null,
    role text not null,
    invited_by_user_id text references cloud_users(id) on delete set null,
    invited_at timestamptz not null default now(),
    accepted_at timestamptz,
    revoked_at timestamptz,
    constraint cloud_workspace_invites_role_check check (role in ('member', 'admin', 'owner'))
  )`,
  (sql) => sql`do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'cloud_workspace_invites_role_check'
      ) then
        alter table cloud_workspace_invites
        add constraint cloud_workspace_invites_role_check
        check (role in ('member', 'admin', 'owner'));
      end if;
    end;
  $$`,
  (sql) => sql`do $$
    begin
      alter table cloud_workspace_invites
      drop constraint if exists cloud_workspace_invites_invited_by_user_id_fkey;
      alter table cloud_workspace_invites
      add constraint cloud_workspace_invites_invited_by_user_id_fkey
      foreign key (invited_by_user_id) references cloud_users(id) on delete restrict;
    exception
      when duplicate_object then null;
    end;
  $$`,
  (sql) =>
    sql`create unique index if not exists cloud_workspace_invites_workspace_email_idx on cloud_workspace_invites (workspace_id, email)`,
  (sql) =>
    sql`create index if not exists cloud_workspace_memberships_user_idx on cloud_workspace_memberships (user_id)`,
  (sql) => sql`create index if not exists cloud_workspace_invites_email_idx on cloud_workspace_invites (email)`,
  (sql) => sql`create table if not exists cloud_workspace_repositories (
    workspace_id text not null references cloud_workspaces(id) on delete cascade,
    repository_id text not null,
    created_at timestamptz not null default now(),
    constraint cloud_workspace_repositories_pk primary key (workspace_id, repository_id)
  )`,
  (sql) =>
    sql`create index if not exists cloud_workspace_repositories_workspace_idx on cloud_workspace_repositories (workspace_id)`,
  (sql) => sql`create table if not exists cloud_workspace_settings (
    workspace_id text primary key references cloud_workspaces(id) on delete cascade,
    settings jsonb not null,
    updated_at timestamptz not null default now()
  )`,
  (sql) => sql`do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'cloud_workspace_settings_shape_check'
      ) then
        alter table cloud_workspace_settings
        add constraint cloud_workspace_settings_shape_check
        check (
          jsonb_typeof(settings) = 'object'
          and settings ? 'workspaceName'
          and settings ? 'workspaceSlug'
          and settings ? 'defaultNotificationChannel'
          and settings ? 'approvalTtlMinutes'
          and settings ? 'enterpriseSso'
        );
      end if;
    end;
  $$`,
  (sql) => sql`create table if not exists cloud_workspace_billing (
    workspace_id text primary key references cloud_workspaces(id) on delete cascade,
    billing jsonb not null,
    updated_at timestamptz not null default now()
  )`,
  (sql) => sql`do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'cloud_workspace_billing_shape_check'
      ) then
        alter table cloud_workspace_billing
        add constraint cloud_workspace_billing_shape_check
        check (
          jsonb_typeof(billing) = 'object'
          and billing ? 'workspaceId'
          and billing ? 'planTier'
          and billing ? 'billingCycle'
          and billing ? 'billingProvider'
          and billing ? 'billingAccessStatus'
        );
      end if;
    end;
  $$`,
  (sql) => sql`create table if not exists cloud_workspace_integrations (
    workspace_id text primary key references cloud_workspaces(id) on delete cascade,
    integrations jsonb not null,
    updated_at timestamptz not null default now()
  )`,
  (sql) => sql`do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'cloud_workspace_integrations_shape_check'
      ) then
        alter table cloud_workspace_integrations
        add constraint cloud_workspace_integrations_shape_check
        check (
          jsonb_typeof(integrations) = 'object'
          and integrations ? 'githubAppInstalled'
          and integrations ? 'githubAppStatus'
          and integrations ? 'webhookStatus'
          and integrations ? 'notificationEvents'
          and integrations ? 'notificationRules'
        );
      end if;
    end;
  $$`,
  (sql) => sql`create table if not exists cloud_workspace_integration_secrets (
    workspace_id text primary key references cloud_workspaces(id) on delete cascade,
    slack_webhook_url text,
    updated_at timestamptz not null default now()
  )`,
  (sql) => sql`create table if not exists cloud_repository_policy_versions (
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
    created_at timestamptz not null default now(),
    constraint cloud_repository_policy_versions_change_source_check check (change_source in ('save', 'rollback', 'seed'))
  )`,
  (sql) => sql`do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'cloud_repository_policy_versions_change_source_check'
      ) then
        alter table cloud_repository_policy_versions
        add constraint cloud_repository_policy_versions_change_source_check
        check (change_source in ('save', 'rollback', 'seed'));
      end if;
    end;
  $$`,
  (sql) => sql`do $$
    begin
      alter table cloud_repository_policy_versions
      drop constraint if exists cloud_repository_policy_versions_actor_user_id_fkey;
      alter table cloud_repository_policy_versions
      add constraint cloud_repository_policy_versions_actor_user_id_fkey
      foreign key (actor_user_id) references cloud_users(id) on delete restrict;
    exception
      when duplicate_object then null;
    end;
  $$`,
  (sql) => sql`do $$
    begin
      if not exists (
        select 1 from pg_constraint where conname = 'cloud_repository_policy_versions_document_shape_check'
      ) then
        alter table cloud_repository_policy_versions
        add constraint cloud_repository_policy_versions_document_shape_check
        check (jsonb_typeof(document) = 'string');
      end if;
    end;
  $$`,
  (sql) =>
    sql`create index if not exists cloud_repository_policy_versions_workspace_idx on cloud_repository_policy_versions (workspace_id)`,
  (sql) =>
    sql`create index if not exists cloud_repository_policy_versions_workspace_repo_created_idx on cloud_repository_policy_versions (workspace_id, repository_id, created_at)`,
  (sql) => sql`create table if not exists cloud_rate_limit_buckets (
    bucket_key text primary key,
    scope text not null,
    identifier_hash text not null,
    count integer not null,
    reset_at timestamptz not null,
    updated_at timestamptz not null default now()
  )`,
  (sql) => sql`create index if not exists cloud_rate_limit_buckets_reset_at_idx on cloud_rate_limit_buckets (reset_at)`,
  (sql) => sql`create table if not exists cloud_identity_bootstrap_state (
    id text primary key default 'singleton',
    bootstrapped boolean not null default false,
    bootstrapped_at timestamptz
  )`,
  (sql) => sql`create table if not exists cloud_processed_stripe_events (
    event_id text primary key,
    workspace_id text not null references cloud_workspaces(id) on delete cascade,
    event_type text not null,
    stripe_customer_id text,
    event_created_at timestamptz not null,
    processed_at timestamptz not null default now()
  )`,
  (sql) =>
    sql`create index if not exists cloud_processed_stripe_events_workspace_created_idx on cloud_processed_stripe_events (workspace_id, event_created_at)`,
  (sql) => sql`create table if not exists cloud_audit_events (
    id text primary key,
    workspace_id text not null references cloud_workspaces(id) on delete cascade,
    occurred_at timestamptz not null,
    actor_label text not null,
    actor_type text not null,
    category text not null,
    action text not null,
    target text not null,
    outcome text not null,
    repo text,
    run_id text,
    action_id text,
    detail_path text,
    external_url text,
    details text not null,
    created_at timestamptz not null default now(),
    constraint cloud_audit_events_actor_type_check check (actor_type in ('human', 'agent', 'system')),
    constraint cloud_audit_events_category_check check (category in ('approval', 'connector', 'run', 'recovery', 'policy', 'fleet')),
    constraint cloud_audit_events_outcome_check check (outcome in ('success', 'warning', 'failure', 'info'))
  )`,
  (sql) =>
    sql`create index if not exists cloud_audit_events_workspace_occurred_idx on cloud_audit_events (workspace_id, occurred_at)`,
  (sql) => sql`create or replace function cloud_forbid_audit_event_mutation() returns trigger as $$
    begin
      raise exception 'cloud_audit_events are append-only';
    end;
  $$ language plpgsql`,
  (sql) => sql`drop trigger if exists cloud_audit_events_immutable on cloud_audit_events`,
  (sql) => sql`create trigger cloud_audit_events_immutable
    before update or delete on cloud_audit_events
    for each row
    execute function cloud_forbid_audit_event_mutation()`,
  (sql) => sql`create or replace function cloud_guard_identity_bootstrap_state() returns trigger as $$
    begin
      if old.bootstrapped = true and new.bootstrapped = false then
        raise exception 'cloud_identity_bootstrap_state cannot transition from bootstrapped=true back to false';
      end if;
      return new;
    end;
  $$ language plpgsql`,
  (sql) => sql`drop trigger if exists cloud_identity_bootstrap_state_guard on cloud_identity_bootstrap_state`,
  (sql) => sql`create trigger cloud_identity_bootstrap_state_guard
    before update on cloud_identity_bootstrap_state
    for each row
    execute function cloud_guard_identity_bootstrap_state()`,
];

async function main() {
  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set before running migrations.");
  }

  const sql = postgres(databaseUrl, { max: 2, prepare: true });
  try {
    await sql`create table if not exists cloud_schema_migrations (
      migration_id text primary key,
      step_index integer not null,
      applied_at timestamptz not null default now()
    )`;

    for (const [index, step] of migrationSteps.entries()) {
      const migrationId = migrationStepId(step);
      await sql.begin(async (tx) => {
        const existing = await tx`
          select migration_id
          from cloud_schema_migrations
          where migration_id = ${migrationId}
          limit 1
        `;
        if (existing.length > 0) {
          return;
        }

        await step(tx as unknown as Sql);
        await tx`
          insert into cloud_schema_migrations (migration_id, step_index)
          values (${migrationId}, ${index})
        `;
      });
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
