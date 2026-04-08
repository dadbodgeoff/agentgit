import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AuthorityClient } from "@agentgit/authority-sdk";
import { IntegrationState } from "@agentgit/integration-state";
import { RunJournal } from "@agentgit/run-journal";
import { ApprovalInboxItemSchema } from "@agentgit/schemas";
import { LocalSnapshotEngine } from "@agentgit/snapshot-engine";
import {
  ConnectorCommandAckRequestSchema,
  ConnectorCommandAckResponseSchema,
  ConnectorCommandEnvelopeSchema,
  ConnectorCommandPullRequestSchema,
  ConnectorCommandPullResponseSchema,
  ConnectorEventBatchRequestSchema,
  ConnectorEventBatchResponseSchema,
  ConnectorEventEnvelopeSchema,
  ConnectorHeartbeatRequestSchema,
  ConnectorHeartbeatResponseSchema,
  ConnectorLocalDaemonStatusSchema,
  ConnectorRegistrationRequestSchema,
  ConnectorRegistrationResponseSchema,
  CreateCommitCommandPayloadSchema,
  OpenPullRequestCommandPayloadSchema,
  ResolveApprovalCommandPayloadSchema,
  RestoreCommandPayloadSchema,
  PushBranchCommandPayloadSchema,
  type ConnectorCommandEnvelope,
  type ConnectorEventEnvelope,
  type RepositoryStateSnapshot,
} from "@agentgit/cloud-sync-protocol";
import { z } from "zod";

const CLOUD_SYNC_SCHEMA_VERSION = "cloud-sync.v1" as const;

export const CloudConnectorRegistrationStateSchema = z
  .object({
    cloudBaseUrl: z.string().url(),
    response: ConnectorRegistrationResponseSchema,
  })
  .strict();
export type CloudConnectorRegistrationState = z.infer<typeof CloudConnectorRegistrationStateSchema>;

export const CloudConnectorOutboxItemSchema = z
  .object({
    event: ConnectorEventEnvelopeSchema,
    submittedAt: z.string().datetime().nullable(),
    attempts: z.number().int().nonnegative(),
  })
  .strict();
export type CloudConnectorOutboxItem = z.infer<typeof CloudConnectorOutboxItemSchema>;

export const CloudConnectorMetadataSchema = z
  .object({
    nextSequence: z.number().int().positive(),
  })
  .strict();
export type CloudConnectorMetadata = z.infer<typeof CloudConnectorMetadataSchema>;

type CloudConnectorCollections = {
  registration: CloudConnectorRegistrationState;
  outbox: CloudConnectorOutboxItem;
  metadata: CloudConnectorMetadata;
};

function tryExecGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function normalizePathForComparison(input: string): string {
  const resolved = path.resolve(input);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isSameOrNestedPath(candidate: string, base: string): boolean {
  const normalizedCandidate = normalizePathForComparison(candidate);
  const normalizedBase = normalizePathForComparison(base);
  return normalizedCandidate === normalizedBase || normalizedCandidate.startsWith(`${normalizedBase}${path.sep}`);
}

function parseGitRemote(remoteUrl: string | null, repoRoot: string): {
  owner: string;
  name: string;
  provider: RepositoryStateSnapshot["provider"];
} {
  const fallback = {
    owner: path.basename(path.dirname(repoRoot)) || "local",
    name: path.basename(repoRoot) || "workspace",
    provider: "local" as const,
  };

  if (!remoteUrl) {
    return fallback;
  }

  const trimmed = remoteUrl.trim();
  const provider = trimmed.includes("github.com")
    ? "github"
    : trimmed.includes("gitlab")
      ? "gitlab"
      : trimmed.includes("bitbucket")
        ? "bitbucket"
        : "local";
  const sshMatch = trimmed.match(/^[^@]+@[^:]+:(.+)$/);
  const target = sshMatch ? sshMatch[1] : trimmed;

  try {
    const pathname = target.startsWith("http://") || target.startsWith("https://") ? new URL(target).pathname : target;
    const segments = pathname
      .replace(/^\/+/, "")
      .replace(/\.git$/, "")
      .split("/")
      .filter((segment) => segment.length > 0);

    if (segments.length >= 2) {
      return {
        owner: segments[segments.length - 2]!,
        name: segments[segments.length - 1]!,
        provider,
      };
    }
  } catch {
    return fallback;
  }

  return fallback;
}

function resolveDefaultBranch(repoRoot: string): string {
  const remoteHead = tryExecGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repoRoot);
  if (remoteHead?.includes("/")) {
    return remoteHead.split("/").pop() ?? "main";
  }

  const currentBranch = tryExecGit(["branch", "--show-current"], repoRoot);
  if (currentBranch) {
    return currentBranch;
  }

  return "main";
}

function resolveAheadBehind(repoRoot: string): { aheadBy: number; behindBy: number } {
  const upstream = tryExecGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], repoRoot);
  if (!upstream) {
    return { aheadBy: 0, behindBy: 0 };
  }

  const counts = tryExecGit(["rev-list", "--left-right", "--count", `${upstream}...HEAD`], repoRoot);
  if (!counts) {
    return { aheadBy: 0, behindBy: 0 };
  }

  const [behind, ahead] = counts.split(/\s+/).map((value) => Number.parseInt(value, 10));
  return {
    aheadBy: Number.isFinite(ahead) ? ahead : 0,
    behindBy: Number.isFinite(behind) ? behind : 0,
  };
}

function detectRepositoryRoot(workspaceRoot: string): string {
  const repoRoot = tryExecGit(["rev-parse", "--show-toplevel"], workspaceRoot);
  if (!repoRoot) {
    throw new Error(`Could not resolve a git repository from ${workspaceRoot}.`);
  }

  return repoRoot;
}

function createEventId(prefix: string, identity: string): string {
  const digest = createHash("sha256").update(`${prefix}:${identity}`, "utf8").digest("hex");
  return `evt_${digest.slice(0, 24)}`;
}

function createDocumentDigest(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function getFetchHeadTimestamp(repoRoot: string): string | null {
  const fetchHeadPath = path.join(repoRoot, ".git", "FETCH_HEAD");
  if (!fs.existsSync(fetchHeadPath)) {
    return null;
  }

  return fs.statSync(fetchHeadPath).mtime.toISOString();
}

function getAuthorityPaths(repoRoot: string) {
  return {
    journalPath: path.join(repoRoot, ".agentgit", "state", "authority.db"),
    snapshotRootPath: path.join(repoRoot, ".agentgit", "state", "snapshots"),
    policyPath: path.join(repoRoot, ".agentgit", "policy.toml"),
    generatedPolicyPath: path.join(repoRoot, ".agentgit", "policy.calibration.generated.json"),
  };
}

function getSnapshotRoot(repoRoot: string) {
  return path.join(repoRoot, ".agentgit", "state", "snapshots");
}

function getGitHubAccessToken(): string | null {
  const token = process.env.AGENTGIT_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? null;
  return token && token.trim().length > 0 ? token.trim() : null;
}

export function detectRepositoryState(workspaceRoot: string): RepositoryStateSnapshot {
  const repoRoot = detectRepositoryRoot(workspaceRoot);
  const remoteUrl = tryExecGit(["config", "--get", "remote.origin.url"], repoRoot);
  const identity = parseGitRemote(remoteUrl, repoRoot);
  const currentBranch = tryExecGit(["branch", "--show-current"], repoRoot) ?? resolveDefaultBranch(repoRoot);
  const headSha = tryExecGit(["rev-parse", "HEAD"], repoRoot);

  if (!headSha) {
    throw new Error(`Could not resolve HEAD for ${repoRoot}.`);
  }

  const dirtyState = tryExecGit(["status", "--porcelain"], repoRoot);
  const aheadBehind = resolveAheadBehind(repoRoot);

  return {
    provider: identity.provider,
    repo: {
      owner: identity.owner,
      name: identity.name,
    },
    remoteUrl,
    defaultBranch: resolveDefaultBranch(repoRoot),
    currentBranch,
    headSha,
    isDirty: Boolean(dirtyState && dirtyState.length > 0),
    aheadBy: aheadBehind.aheadBy,
    behindBy: aheadBehind.behindBy,
    workspaceRoot: repoRoot,
    lastFetchedAt: getFetchHeadTimestamp(repoRoot),
  };
}

export function detectLocalDaemonStatus(workspaceRoot: string) {
  const repoRoot = detectRepositoryRoot(workspaceRoot);
  const paths = getAuthorityPaths(repoRoot);

  return ConnectorLocalDaemonStatusSchema.parse({
    reachable: fs.existsSync(paths.journalPath),
    socketPath: process.env.AGENTGIT_AUTHORITY_SOCKET_PATH ?? null,
    journalPath: fs.existsSync(paths.journalPath) ? paths.journalPath : null,
    snapshotRootPath: fs.existsSync(paths.snapshotRootPath) ? paths.snapshotRootPath : null,
  });
}

type RegisterConnectorOptions = {
  sessionCookie?: string;
  bootstrapToken?: string;
};

export class CloudConnectorStateStore {
  private readonly store: IntegrationState<CloudConnectorCollections>;

  constructor(dbPath: string) {
    this.store = new IntegrationState<CloudConnectorCollections>({
      dbPath,
      collections: {
        registration: {
          parse(_key, value) {
            return CloudConnectorRegistrationStateSchema.parse(value);
          },
        },
        outbox: {
          parse(_key, value) {
            return CloudConnectorOutboxItemSchema.parse(value);
          },
        },
        metadata: {
          parse(_key, value) {
            return CloudConnectorMetadataSchema.parse(value);
          },
        },
      },
    });
  }

  close() {
    this.store.close();
  }

  saveRegistration(registration: CloudConnectorRegistrationState) {
    return this.store.put("registration", "active", registration);
  }

  getRegistration() {
    return this.store.get("registration", "active");
  }

  hasEvent(eventId: string) {
    return this.store.get("outbox", eventId) !== null;
  }

  claimNextSequence() {
    const metadata = this.store.get("metadata", "default") ?? {
      nextSequence: 1,
    };
    this.store.put("metadata", "default", {
      nextSequence: metadata.nextSequence + 1,
    });
    return metadata.nextSequence;
  }

  enqueueEvent(event: ConnectorEventEnvelope) {
    return this.store.putIfAbsent("outbox", event.eventId, {
      event,
      submittedAt: null,
      attempts: 0,
    });
  }

  listPendingEvents() {
    return this.store
      .list("outbox")
      .filter((item) => item.submittedAt === null)
      .sort((left, right) => left.event.sequence - right.event.sequence);
  }

  markSubmitted(eventIds: string[], submittedAt: string) {
    for (const eventId of eventIds) {
      const current = this.store.get("outbox", eventId);
      if (!current) {
        continue;
      }

      this.store.put("outbox", eventId, {
        ...current,
        submittedAt,
        attempts: current.attempts + 1,
      });
    }
  }
}

export class CloudSyncClient {
  constructor(private readonly baseUrl: string) {}

  get cloudBaseUrl() {
    return this.baseUrl;
  }

  private async request<T>(pathName: string, init: RequestInit, parser: z.ZodType<T>): Promise<T> {
    const response = await fetch(new URL(pathName, this.baseUrl), {
      ...init,
      headers: {
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      throw new Error(`Cloud sync request failed with ${response.status}.`);
    }

    const json = await response.json();
    return parser.parse(json);
  }

  async registerConnector(input: z.infer<typeof ConnectorRegistrationRequestSchema>, options: RegisterConnectorOptions = {}) {
    const headers: Record<string, string> = {};
    if (options.sessionCookie) {
      headers.cookie = options.sessionCookie;
    }
    if (options.bootstrapToken) {
      headers.authorization = `Bearer ${options.bootstrapToken}`;
    }

    return this.request(
      "/api/v1/sync/register",
      {
        method: "POST",
        body: JSON.stringify(ConnectorRegistrationRequestSchema.parse(input)),
        headers,
      },
      ConnectorRegistrationResponseSchema,
    );
  }

  async sendHeartbeat(input: z.infer<typeof ConnectorHeartbeatRequestSchema>, accessToken: string) {
    return this.request(
      "/api/v1/sync/heartbeat",
      {
        method: "POST",
        body: JSON.stringify(ConnectorHeartbeatRequestSchema.parse(input)),
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      },
      ConnectorHeartbeatResponseSchema,
    );
  }

  async publishEvents(input: z.infer<typeof ConnectorEventBatchRequestSchema>, accessToken: string) {
    return this.request(
      "/api/v1/sync/events",
      {
        method: "POST",
        body: JSON.stringify(ConnectorEventBatchRequestSchema.parse(input)),
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      },
      ConnectorEventBatchResponseSchema,
    );
  }

  async pullCommands(input: z.infer<typeof ConnectorCommandPullRequestSchema>, accessToken: string) {
    return this.request(
      "/api/v1/sync/commands/pull",
      {
        method: "POST",
        body: JSON.stringify(ConnectorCommandPullRequestSchema.parse(input)),
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      },
      ConnectorCommandPullResponseSchema,
    );
  }

  async ackCommand(commandId: string, input: z.infer<typeof ConnectorCommandAckRequestSchema>, accessToken: string) {
    return this.request(
      `/api/v1/sync/commands/${commandId}/ack`,
      {
        method: "POST",
        body: JSON.stringify(ConnectorCommandAckRequestSchema.parse(input)),
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      },
      ConnectorCommandAckResponseSchema,
    );
  }
}

export class CloudConnectorService {
  constructor(
    private readonly stateStore: CloudConnectorStateStore,
    private readonly client: CloudSyncClient,
  ) {}

  getRegistration() {
    return this.stateStore.getRegistration();
  }

  async register(input: z.infer<typeof ConnectorRegistrationRequestSchema>, options: RegisterConnectorOptions = {}) {
    const response = await this.client.registerConnector(input, options);
    this.stateStore.saveRegistration({
      cloudBaseUrl: this.client.cloudBaseUrl,
      response,
    });
    return response;
  }

  enqueueEvent(event: ConnectorEventEnvelope) {
    return this.stateStore.enqueueEvent(event);
  }

  async flushOutbox(sentAt: string) {
    const registration = this.stateStore.getRegistration();
    if (!registration) {
      throw new Error("Cloud connector is not registered.");
    }

    const pending = this.stateStore.listPendingEvents();
    if (pending.length === 0) {
      return null;
    }

    const response = await this.client.publishEvents(
      {
        connectorId: registration.response.connector.id,
        sentAt,
        events: pending.map((item) => item.event),
      },
      registration.response.accessToken,
    );
    this.stateStore.markSubmitted(
      pending.map((item) => item.event.eventId),
      response.acceptedAt,
    );
    return response;
  }

  async sendHeartbeat(input: z.infer<typeof ConnectorHeartbeatRequestSchema>) {
    const registration = this.stateStore.getRegistration();
    if (!registration) {
      throw new Error("Cloud connector is not registered.");
    }

    return this.client.sendHeartbeat(input, registration.response.accessToken);
  }

  async pullCommands(sentAt: string) {
    const registration = this.stateStore.getRegistration();
    if (!registration) {
      throw new Error("Cloud connector is not registered.");
    }

    return this.client.pullCommands(
      {
        connectorId: registration.response.connector.id,
        sentAt,
      },
      registration.response.accessToken,
    );
  }

  async acknowledgeCommand(commandId: string, status: "acked" | "completed" | "failed", acknowledgedAt: string, message?: string) {
    return this.acknowledgeCommandWithResult(commandId, status, acknowledgedAt, message);
  }

  async acknowledgeCommandWithResult(
    commandId: string,
    status: "acked" | "completed" | "failed",
    acknowledgedAt: string,
    message?: string,
    result?: z.infer<typeof ConnectorCommandAckRequestSchema>["result"],
  ) {
    const registration = this.stateStore.getRegistration();
    if (!registration) {
      throw new Error("Cloud connector is not registered.");
    }

    return this.client.ackCommand(
      commandId,
      {
        connectorId: registration.response.connector.id,
        commandId,
        acknowledgedAt,
        status,
        message,
        result,
      },
      registration.response.accessToken,
    );
  }
}

export type CloudConnectorRuntimeOptions = {
  stateStore: CloudConnectorStateStore;
  service: CloudConnectorService;
  workspaceRoot: string;
  connectorVersion: string;
  now?: () => string;
};

export class CloudConnectorRuntime {
  private readonly now: () => string;

  constructor(private readonly options: CloudConnectorRuntimeOptions) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private get workspaceRoot() {
    return this.options.workspaceRoot;
  }

  private buildEvent(repository: RepositoryStateSnapshot, type: ConnectorEventEnvelope["type"], eventId: string, occurredAt: string, payload: Record<string, unknown>) {
    const registration = this.options.service.getRegistration();
    if (!registration) {
      throw new Error("Cloud connector is not registered.");
    }

    return ConnectorEventEnvelopeSchema.parse({
      schemaVersion: CLOUD_SYNC_SCHEMA_VERSION,
      eventId,
      connectorId: registration.response.connector.id,
      workspaceId: registration.response.connector.workspaceId,
      repository: repository.repo,
      sequence: this.options.stateStore.claimNextSequence(),
      occurredAt,
      type,
      payload,
    });
  }

  private emitEvent(repository: RepositoryStateSnapshot, type: ConnectorEventEnvelope["type"], identity: string, occurredAt: string, payload: Record<string, unknown>) {
    const eventId = createEventId(type, identity);
    if (this.options.stateStore.hasEvent(eventId)) {
      return false;
    }

    return this.options.service.enqueueEvent(this.buildEvent(repository, type, eventId, occurredAt, payload));
  }

  private collectPolicyEvents(repository: RepositoryStateSnapshot) {
    const paths = getAuthorityPaths(repository.workspaceRoot);
    const policyFiles = [
      { kind: "workspace_policy", filePath: paths.policyPath },
      { kind: "calibration_policy", filePath: paths.generatedPolicyPath },
    ];

    for (const candidate of policyFiles) {
      if (!fs.existsSync(candidate.filePath)) {
        continue;
      }

      const document = fs.readFileSync(candidate.filePath, "utf8");
      const digest = createDocumentDigest(document);
      this.emitEvent(
        repository,
        "policy.state",
        `${candidate.kind}:${digest}`,
        fs.statSync(candidate.filePath).mtime.toISOString(),
        {
          kind: candidate.kind,
          path: candidate.filePath,
          digest,
        },
      );
    }
  }

  private collectSnapshotManifestEvents(repository: RepositoryStateSnapshot) {
    const manifestRoot = path.join(repository.workspaceRoot, ".agentgit", "state", "snapshots", "metadata");
    if (!fs.existsSync(manifestRoot)) {
      return;
    }

    const manifests = fs
      .readdirSync(manifestRoot)
      .filter((entry) => entry.endsWith(".json"))
      .sort((left, right) => left.localeCompare(right));

    for (const fileName of manifests) {
      const manifestPath = path.join(manifestRoot, fileName);
      const raw = fs.readFileSync(manifestPath, "utf8");
      const manifest = JSON.parse(raw) as Record<string, unknown>;
      const snapshotId = typeof manifest.snapshot_id === "string" ? manifest.snapshot_id : fileName.replace(/\.json$/, "");
      const createdAt =
        typeof manifest.created_at === "string" ? manifest.created_at : fs.statSync(manifestPath).mtime.toISOString();
      this.emitEvent(repository, "snapshot.manifest", `snapshot:${snapshotId}`, createdAt, manifest);
    }
  }

  private collectRunHistoryEvents(repository: RepositoryStateSnapshot, includeSnapshots = true) {
    const journalPath = getAuthorityPaths(repository.workspaceRoot).journalPath;
    if (!fs.existsSync(journalPath)) {
      return;
    }

    const journal = new RunJournal({ dbPath: journalPath });

    try {
      const runs = journal
        .listAllRuns()
        .filter((run) => run.workspace_roots.some((workspaceRoot) => isSameOrNestedPath(workspaceRoot, repository.workspaceRoot)));

      for (const run of runs) {
        const latestMarker = run.latest_event?.occurred_at ?? run.started_at;
        this.emitEvent(repository, "run.lifecycle", `run:${run.run_id}:${latestMarker}`, latestMarker, {
          runId: run.run_id,
          summary: run,
        });

        for (const event of journal.listRunEvents(run.run_id)) {
          this.emitEvent(repository, "run.event", `run-event:${run.run_id}:${event.sequence}`, event.occurred_at, {
            runId: run.run_id,
            event,
          });
        }
      }

      for (const approval of journal.listApprovals()) {
        const stored = journal.getStoredApproval(approval.approval_id);
        const run = journal.getRunSummary(approval.run_id);

        if (!stored || !run) {
          continue;
        }

        const firstReason = stored.policy_outcome.reasons[0];
        const payload = ApprovalInboxItemSchema.parse({
          approval_id: approval.approval_id,
          run_id: approval.run_id,
          workflow_name: run.workflow_name,
          action_id: approval.action_id,
          action_summary: approval.action_summary,
          action_domain: stored.action.operation.domain,
          side_effect_level: stored.action.risk_hints.side_effect_level,
          status: approval.status,
          requested_at: approval.requested_at,
          resolved_at: approval.resolved_at,
          resolution_note: approval.resolution_note,
          decision_requested: approval.decision_requested,
          snapshot_required: stored.policy_outcome.preconditions.snapshot_required,
          reason_summary: firstReason?.message ?? null,
          primary_reason: firstReason
            ? {
                code: firstReason.code,
                message: firstReason.message,
              }
            : null,
          target_locator: stored.action.target.primary.locator,
          target_label: stored.action.target.primary.label ?? null,
        });

        if (approval.status === "pending" || !approval.resolved_at) {
          this.emitEvent(
            repository,
            "approval.requested",
            `approval:${approval.approval_id}:pending:${approval.requested_at}`,
            approval.requested_at,
            payload,
          );
          continue;
        }

        this.emitEvent(
          repository,
          "approval.resolution",
          `approval:${approval.approval_id}:${approval.status}:${approval.resolved_at}`,
          approval.resolved_at,
          payload,
        );
      }
    } finally {
      journal.close();
    }

    if (includeSnapshots) {
      this.collectSnapshotManifestEvents(repository);
    }
  }

  private collectRepositorySnapshotEvent(repository: RepositoryStateSnapshot) {
    const digest = createDocumentDigest(
      JSON.stringify({
        branch: repository.currentBranch,
        headSha: repository.headSha,
        dirty: repository.isDirty,
        aheadBy: repository.aheadBy,
        behindBy: repository.behindBy,
      }),
    );

    this.emitEvent(repository, "repo_state.snapshot", `repo:${digest}`, this.now(), repository);
  }

  buildRegistrationRequest(params: {
    workspaceId: string;
    connectorName?: string;
    machineName?: string;
    capabilities?: z.infer<typeof ConnectorRegistrationRequestSchema>["capabilities"];
  }) {
    const repository = detectRepositoryState(this.workspaceRoot);

    return ConnectorRegistrationRequestSchema.parse({
      workspaceId: params.workspaceId,
      connectorName: params.connectorName ?? `${os.hostname()} connector`,
      machineName: params.machineName ?? os.hostname(),
      connectorVersion: this.options.connectorVersion,
      platform: {
        os: process.platform,
        arch: process.arch,
        hostname: os.hostname(),
      },
      capabilities: params.capabilities ?? [
        "repo_state_sync",
        "run_event_sync",
        "snapshot_manifest_sync",
        "approval_resolution",
        "git_commit",
        "git_push",
        "pull_request_open",
      ],
      repository,
    });
  }

  async bootstrapRegister(params: {
    cloudBaseUrl: string;
    workspaceId: string;
    bootstrapToken: string;
    connectorName?: string;
    machineName?: string;
  }) {
    return this.options.service.register(
      this.buildRegistrationRequest({
        workspaceId: params.workspaceId,
        connectorName: params.connectorName,
        machineName: params.machineName,
      }),
      {
        bootstrapToken: params.bootstrapToken,
      },
    );
  }

  async sendHeartbeat() {
    const registration = this.options.service.getRegistration();
    if (!registration) {
      throw new Error("Cloud connector is not registered.");
    }

    const repository = detectRepositoryState(this.workspaceRoot);
    return this.options.service.sendHeartbeat(
      {
        connectorId: registration.response.connector.id,
        sentAt: this.now(),
        repository,
        localDaemon: detectLocalDaemonStatus(this.workspaceRoot),
      },
    );
  }

  async publishLocalState(options: { includeSnapshots?: boolean } = {}) {
    const repository = detectRepositoryState(this.workspaceRoot);
    this.collectRepositorySnapshotEvent(repository);
    this.collectPolicyEvents(repository);
    this.collectRunHistoryEvents(repository, options.includeSnapshots ?? true);
    const published = await this.options.service.flushOutbox(this.now());
    return {
      repository,
      published,
    };
  }

  private executeCreateCommit(command: ConnectorCommandEnvelope): {
    status: "completed" | "failed";
    message: string;
    result?: z.infer<typeof ConnectorCommandAckRequestSchema>["result"];
  } {
    const payload = CreateCommitCommandPayloadSchema.parse(command.payload);
    const repoRoot = detectRepositoryRoot(this.workspaceRoot);
    const status = tryExecGit(["status", "--porcelain"], repoRoot);
    if (!status || status.length === 0) {
      return {
        status: "failed",
        message: "No local changes were available to commit.",
        result: {
          type: "create_commit",
        },
      };
    }

    if (payload.stageAll) {
      execFileSync("git", ["add", "--all"], { cwd: repoRoot, stdio: "ignore" });
    } else if (payload.paths && payload.paths.length > 0) {
      execFileSync("git", ["add", "--", ...payload.paths], { cwd: repoRoot, stdio: "ignore" });
    } else {
      return {
        status: "failed",
        message: "Create-commit command requires stageAll=true or a non-empty paths list.",
        result: {
          type: "create_commit",
        },
      };
    }

    execFileSync("git", ["commit", "-m", payload.message], { cwd: repoRoot, stdio: "ignore" });
    const headSha = tryExecGit(["rev-parse", "HEAD"], repoRoot) ?? "unknown";
    const branch = tryExecGit(["branch", "--show-current"], repoRoot) ?? "current branch";
    return {
      status: "completed",
      message: `Created commit ${headSha.slice(0, 12)} on ${branch}.`,
      result: {
        type: "create_commit",
        commitSha: headSha,
        branch,
      },
    };
  }

  private executePushBranch(command: ConnectorCommandEnvelope): {
    status: "completed" | "failed";
    message: string;
    result?: z.infer<typeof ConnectorCommandAckRequestSchema>["result"];
  } {
    const payload = PushBranchCommandPayloadSchema.parse(command.payload);
    const repoRoot = detectRepositoryRoot(this.workspaceRoot);
    const branch = payload.branch ?? (tryExecGit(["branch", "--show-current"], repoRoot) ?? null);
    if (!branch) {
      return {
        status: "failed",
        message: "Could not determine a branch to push.",
        result: {
          type: "push_branch",
          remoteName: "origin",
        },
      };
    }

    const args = ["push"];
    if (payload.setUpstream) {
      args.push("--set-upstream", "origin", branch);
    } else {
      args.push("origin", branch);
    }

    execFileSync("git", args, { cwd: repoRoot, stdio: "ignore" });
    return {
      status: "completed",
      message: `Pushed ${branch} to origin.`,
      result: {
        type: "push_branch",
        branch,
        remoteName: "origin",
      },
    };
  }

  private async executeOpenPullRequest(
    command: ConnectorCommandEnvelope,
  ): Promise<{
    status: "completed" | "failed";
    message: string;
    result?: z.infer<typeof ConnectorCommandAckRequestSchema>["result"];
  }> {
    const payload = OpenPullRequestCommandPayloadSchema.parse(command.payload);
    const repoState = detectRepositoryState(this.workspaceRoot);
    if (repoState.provider !== "github") {
      return {
        status: "failed",
        message: `Pull request creation is only implemented for GitHub-backed repositories. Current provider: ${repoState.provider}.`,
        result: {
          type: "open_pull_request",
          provider: repoState.provider,
          baseBranch: payload.baseBranch ?? repoState.defaultBranch,
          headBranch: payload.headBranch ?? repoState.currentBranch,
          draft: payload.draft ?? false,
        },
      };
    }

    const token = getGitHubAccessToken();
    if (!token) {
      return {
        status: "failed",
        message: "GitHub pull request creation requires AGENTGIT_GITHUB_TOKEN or GITHUB_TOKEN in the connector environment.",
        result: {
          type: "open_pull_request",
          provider: "github",
          baseBranch: payload.baseBranch ?? repoState.defaultBranch,
          headBranch: payload.headBranch ?? repoState.currentBranch,
          draft: payload.draft ?? false,
        },
      };
    }

    const head = payload.headBranch ?? repoState.currentBranch;
    const base = payload.baseBranch ?? repoState.defaultBranch;
    if (head === base) {
      return {
        status: "failed",
        message: "Pull request head and base branches must differ.",
        result: {
          type: "open_pull_request",
          provider: "github",
          baseBranch: base,
          headBranch: head,
          draft: payload.draft ?? false,
        },
      };
    }

    const response = await fetch(`https://api.github.com/repos/${repoState.repo.owner}/${repoState.repo.name}/pulls`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({
        title: payload.title,
        body: payload.body,
        head,
        base,
        draft: payload.draft ?? false,
      }),
    });

    if (!response.ok) {
      let details = "";
      try {
        const parsed = (await response.json()) as { message?: string };
        details = parsed.message ? ` ${parsed.message}` : "";
      } catch {
        // Ignore parse failures and fall back to status text.
      }

      return {
        status: "failed",
        message: `GitHub pull request creation failed with ${response.status}.${details}`.trim(),
        result: {
          type: "open_pull_request",
          provider: "github",
          baseBranch: base,
          headBranch: head,
          draft: payload.draft ?? false,
        },
      };
    }

    const parsed = (await response.json()) as { html_url?: string; number?: number };
    const descriptor = parsed.number ? `#${parsed.number}` : "pull request";
    return {
      status: "completed",
      message: parsed.html_url
        ? `Opened GitHub PR ${descriptor}: ${parsed.html_url}`
        : `Opened GitHub PR ${descriptor}.`,
      result: {
        type: "open_pull_request",
        provider: "github",
        pullRequestUrl: parsed.html_url,
        pullRequestNumber: parsed.number,
        baseBranch: base,
        headBranch: head,
        draft: payload.draft ?? false,
      },
    };
  }

  private async executeRestore(command: ConnectorCommandEnvelope): Promise<{
    status: "completed" | "failed";
    message: string;
    result?: z.infer<typeof ConnectorCommandAckRequestSchema>["result"];
  }> {
    const payload = RestoreCommandPayloadSchema.parse(command.payload);
    const repoRoot = detectRepositoryRoot(this.workspaceRoot);
    const engine = new LocalSnapshotEngine({
      rootDir: getSnapshotRoot(repoRoot),
    });
    const manifest = await engine.getSnapshotManifest(payload.snapshotId);

    if (!manifest) {
      return {
        status: "failed",
        message: `Snapshot ${payload.snapshotId} was not found in local connector storage.`,
        result: {
          type: "execute_restore",
          snapshotId: payload.snapshotId,
        },
      };
    }

    const restored = await engine.restore(payload.snapshotId);
    const journalPath = getAuthorityPaths(repoRoot).journalPath;
    if (fs.existsSync(journalPath)) {
      const journal = new RunJournal({ dbPath: journalPath });
      try {
        journal.appendRunEvent(manifest.run_id, {
          event_type: "recovery.executed",
          occurred_at: this.now(),
          recorded_at: this.now(),
          payload: {
            action_id: manifest.action_id,
            snapshot_id: payload.snapshotId,
            outcome: restored ? "restored" : "compensated",
            recovery_class: restored ? "reversible" : "manual_followup",
            strategy: "restore_snapshot",
          },
        });
      } finally {
        journal.close();
      }
    }

    return {
      status: restored ? "completed" : "failed",
      message: restored
        ? `Restored snapshot ${payload.snapshotId} through the local connector.`
        : `Snapshot ${payload.snapshotId} did not report a successful local restore.`,
      result: {
        type: "execute_restore",
        snapshotId: payload.snapshotId,
        restored,
        outcome: restored ? "restored" : "compensated",
        runId: manifest.run_id,
        actionId: manifest.action_id,
      },
    };
  }

  private async executeResolveApproval(command: ConnectorCommandEnvelope): Promise<{
    status: "completed" | "failed";
    message: string;
    result?: z.infer<typeof ConnectorCommandAckRequestSchema>["result"];
  }> {
    const payload = ResolveApprovalCommandPayloadSchema.parse(command.payload);
    const repoRoot = detectRepositoryRoot(this.workspaceRoot);
    const client = new AuthorityClient({
      clientType: "sdk_ts",
      clientVersion: this.options.connectorVersion,
      defaultWorkspaceRoots: [repoRoot],
      socketPath: process.env.AGENTGIT_AUTHORITY_SOCKET_PATH ?? path.join(repoRoot, ".agentgit", "authority.sock"),
    });

    await client.hello([repoRoot]);
    const response = await client.resolveApproval(payload.approvalId, payload.resolution, payload.note);
    const approval = response.approval_request;
    const resolution = approval.status === "denied" ? "denied" : "approved";

    return {
      status: "completed",
      message:
        resolution === "approved"
          ? `Approval ${approval.approval_id} resolved locally and the governed run can continue.`
          : `Approval ${approval.approval_id} was denied locally and the governed run remains blocked.`,
      result: {
        type: "resolve_approval",
        approvalId: approval.approval_id,
        runId: approval.run_id,
        actionId: approval.action_id,
        resolution,
        resolvedAt: approval.resolved_at ?? this.now(),
      },
    };
  }

  private async executeCommand(command: ConnectorCommandEnvelope): Promise<{
    status: "completed" | "failed";
    message: string;
    result?: z.infer<typeof ConnectorCommandAckRequestSchema>["result"];
  }> {
    switch (command.type) {
      case "refresh_repo_state":
        {
          const published = await this.publishLocalState({ includeSnapshots: true });
          return {
            status: "completed",
            message: "Repository state refreshed and published.",
            result: {
              type: "refresh_repo_state",
              publishedEventCount: published.published?.acceptedCount ?? 0,
              includesSnapshots: true,
              syncedAt: this.now(),
            },
          };
        }
      case "sync_run_history":
        {
          const includeSnapshots =
            typeof command.payload.includeSnapshots === "boolean" ? command.payload.includeSnapshots : true;
          const published = await this.publishLocalState({
            includeSnapshots,
          });
          return {
            status: "completed",
            message: "Run history synchronized.",
            result: {
              type: "sync_run_history",
              publishedEventCount: published.published?.acceptedCount ?? 0,
              includesSnapshots: includeSnapshots,
              syncedAt: this.now(),
            },
          };
        }
      case "resolve_approval":
        return this.executeResolveApproval(command);
      case "create_commit":
        return this.executeCreateCommit(command);
      case "push_branch":
        return this.executePushBranch(command);
      case "execute_restore":
        return this.executeRestore(command);
      case "open_pull_request":
        return this.executeOpenPullRequest(command);
      default:
        return {
          status: "failed",
          message: `Connector command ${command.type} is not implemented yet.`,
        };
    }
  }

  async processCommands() {
    const commands = await this.options.service.pullCommands(this.now());
    const processed: Array<{
      commandId: string;
      status: "completed" | "failed";
      message: string;
      result?: z.infer<typeof ConnectorCommandAckRequestSchema>["result"];
    }> = [];

    for (const command of commands.commands) {
      await this.options.service.acknowledgeCommand(command.commandId, "acked", this.now(), "Connector received command.");
      let result: {
        status: "completed" | "failed";
        message: string;
        result?: z.infer<typeof ConnectorCommandAckRequestSchema>["result"];
      };
      try {
        result = await this.executeCommand(command);
      } catch (error) {
        result = {
          status: "failed",
          message: error instanceof Error ? error.message : "Connector command execution failed unexpectedly.",
        };
      }
      await this.options.service.acknowledgeCommandWithResult(
        command.commandId,
        result.status,
        this.now(),
        result.message,
        result.result,
      );
      if (result.status === "completed") {
        await this.publishLocalState({ includeSnapshots: true });
      }
      processed.push({
        commandId: command.commandId,
        status: result.status,
        message: result.message,
      });
    }

    return processed;
  }

  async syncOnce() {
    const heartbeat = await this.sendHeartbeat();
    const published = await this.publishLocalState({ includeSnapshots: true });
    const commands = await this.processCommands();

    return {
      heartbeat,
      published,
      commands,
    };
  }
}
