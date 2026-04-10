import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { AuthorityClient, AuthorityClientTransportError } from "@agentgit/authority-sdk";
import {
  resolveAuthorityDaemonRuntimeConfig,
  runAuthorityDaemon,
  type StartedAuthorityDaemon,
} from "@agentgit/authority-daemon";
import { createFileBackedSecretKeyProvider, LocalEncryptedSecretStore } from "@agentgit/credential-broker";
import { AgentGitError, type RecoveryTarget, type RunCheckpointKind } from "@agentgit/schemas";

import {
  createAdapterContext,
  createAdapterRegistry,
  detectBestRuntime,
  planSetup,
  type AdapterContext,
  type RuntimeAdapter,
} from "./adapters.js";
import { prependPathEntry } from "./assets.js";
import {
  createWorkspaceProjection,
  deriveContainedEgressAssurance,
  deriveContainedEgressMode,
  diffWorkspaceProjection,
  readProjectionFileText,
  resolveContainedBackendRuntime,
} from "./containment.js";
import { startContainedEgressProxy } from "./egress-proxy.js";
import {
  ProductStateStore,
  createContainedRunId,
  createContainedRunRoot,
  createDemoRunId,
  createRunCheckpointId,
  createDemoWorkspaceRoot,
  createRestoreShortcutId,
} from "./state.js";
import type {
  AssuranceLevel,
  ContainedRunDocument,
  ContainedCredentialMode,
  ContainedEgressAssurance,
  ContainedEgressMode,
  ContainerNetworkPolicy,
  DefaultCheckpointPolicy,
  DemoRunDocument,
  DetectionResult,
  GovernanceGuarantee,
  GovernanceMode,
  InstallPlan,
  RuntimeCredentialBindingDocument,
  RunCheckpointDocument,
  RestoreShortcutDocument,
  RuntimeProfileDocument,
  SetupPreferences,
  VerifyResult,
} from "./types.js";
import { DefaultCommandRunner, type CommandRunner, resolveWorkspaceRoot } from "./utils.js";

const PRODUCT_CLIENT_VERSION = "0.1.0";
const CONTAINED_SECRET_MOUNT_ROOT = "/run/agentgit-secrets";
const CHILD_CLEANUP_TIMEOUT_MS = 5_000;

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function ensurePrivateDirectory(directoryPath: string): void {
  fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(directoryPath, 0o700);
  const stats = fs.lstatSync(directoryPath);
  if (!stats.isDirectory()) {
    throw new AgentGitError(
      "AgentGit runtime expected a directory but found another file type.",
      "PRECONDITION_FAILED",
      {
        path: directoryPath,
      },
    );
  }

  const uid = currentUid();
  if (uid !== null && stats.uid !== uid) {
    throw new AgentGitError("AgentGit runtime directory is not owned by the current user.", "PRECONDITION_FAILED", {
      path: directoryPath,
      expected_uid: uid,
      actual_uid: stats.uid,
    });
  }
}

function writeSecureTextFile(filePath: string, content: string): void {
  ensurePrivateDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const handle = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.writeFileSync(handle, content, "utf8");
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(tempPath, filePath);
  fs.chmodSync(filePath, 0o600);
}

function resolveContainedSecretTarget(secretFileRoot: string, relativePath: string): string {
  const normalizedRelativePath = relativePath.replace(/^\/+/, "");
  const targetPath = path.join(secretFileRoot, normalizedRelativePath);
  const relativeToRoot = path.relative(secretFileRoot, targetPath);
  if (
    relativeToRoot.length === 0 ||
    relativeToRoot === "." ||
    relativeToRoot.startsWith(`..${path.sep}`) ||
    relativeToRoot === ".." ||
    path.isAbsolute(relativeToRoot)
  ) {
    throw new AgentGitError(
      `Contained secret file binding escapes the managed mount root: ${relativePath}`,
      "BAD_REQUEST",
      { relative_path: relativePath },
    );
  }

  return targetPath;
}

function assertPathWithinRoot(rootPath: string, candidatePath: string, envKey: string): string {
  const resolvedRoot = path.resolve(rootPath);
  const resolvedCandidate = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(resolvedRoot, candidatePath);
  if (resolvedCandidate !== resolvedRoot && !resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new AgentGitError(
      `AgentGit rejected ${envKey} because it escapes the managed runtime root.`,
      "PRECONDITION_FAILED",
      {
        env_key: envKey,
        candidate_path: candidatePath,
        resolved_root: resolvedRoot,
        resolved_candidate_path: resolvedCandidate,
      },
    );
  }

  return resolvedCandidate;
}

function resolveRuntimeScopedPath(
  rootPath: string,
  configuredValue: string | undefined,
  fallbackPath: string,
  envKey: string,
): string {
  const trimmed = configuredValue?.trim();
  if (!trimmed) {
    return fallbackPath;
  }

  return assertPathWithinRoot(rootPath, trimmed, envKey);
}

function isConnectFailure(error: unknown): boolean {
  return (
    error instanceof AuthorityClientTransportError &&
    (error.code === "SOCKET_CONNECT_FAILED" ||
      error.code === "SOCKET_CONNECT_TIMEOUT" ||
      error.code === "SOCKET_CLOSED")
  );
}

function buildAuthorityClient(socketPath: string): AuthorityClient {
  return new AuthorityClient({
    clientType: "cli",
    clientVersion: PRODUCT_CLIENT_VERSION,
    socketPath,
    connectTimeoutMs: 500,
    responseTimeoutMs: 5_000,
    maxConnectRetries: 3,
    connectRetryDelayMs: 100,
  });
}

const AUTHORITY_SESSION_MAX_ATTEMPTS = 4;
const AUTHORITY_SESSION_RETRY_DELAY_MS = 100;

function resolveSocketAuthTokenPath(socketPath: string): string {
  return `${socketPath}.token`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAddressInUseFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("EADDRINUSE") ||
      ("code" in error && typeof error.code === "string" && error.code === "EADDRINUSE"))
  );
}

export interface AuthoritySession {
  client: AuthorityClient;
  session_id: string;
  daemon_config: ReturnType<typeof resolveAuthorityDaemonRuntimeConfig>;
  daemon_started: boolean;
  daemon?: StartedAuthorityDaemon;
  runtime_lock_release?: () => void;
}

interface AuthoritySessionRuntime {
  build_client: (socketPath: string) => AuthorityClient;
  start_daemon: (config: ReturnType<typeof resolveAuthorityDaemonRuntimeConfig>) => Promise<StartedAuthorityDaemon>;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_AUTHORITY_SESSION_RUNTIME: AuthoritySessionRuntime = {
  build_client: buildAuthorityClient,
  start_daemon: (config) => suppressRuntimeNoise(() => runAuthorityDaemon(config)),
  sleep,
};

function runtimeHash(workspaceRoot: string): string {
  return createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 12);
}

function acquireRuntimeLock(runtimeRoot: string): (() => void) | null {
  const lockPath = path.join(runtimeRoot, "authority.lock");

  try {
    const handle = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(handle, String(process.pid), "utf8");
    fs.closeSync(handle);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return null;
    }
    throw error;
  }

  return () => {
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      // Best-effort cleanup for short-lived runtime lock files.
    }
  };
}

function buildAuthorityEnvironmentForWorkspace(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
  runtimeRoot: string,
): NodeJS.ProcessEnv {
  const mcpRoot = path.join(runtimeRoot, "mcp");
  ensurePrivateDirectory(runtimeRoot);
  ensurePrivateDirectory(mcpRoot);
  return {
    ...env,
    AGENTGIT_ROOT: workspaceRoot,
    AGENTGIT_SOCKET_PATH: path.join(runtimeRoot, "authority.sock"),
    AGENTGIT_JOURNAL_PATH: path.join(runtimeRoot, "authority.db"),
    AGENTGIT_SNAPSHOT_ROOT: path.join(runtimeRoot, "snapshots"),
    AGENTGIT_MCP_REGISTRY_PATH: path.join(mcpRoot, "registry.db"),
    AGENTGIT_MCP_SECRET_STORE_PATH: resolveRuntimeScopedPath(
      mcpRoot,
      env.AGENTGIT_MCP_SECRET_STORE_PATH,
      path.join(mcpRoot, "secret-store.db"),
      "AGENTGIT_MCP_SECRET_STORE_PATH",
    ),
    AGENTGIT_MCP_SECRET_KEY_PATH: resolveRuntimeScopedPath(
      mcpRoot,
      env.AGENTGIT_MCP_SECRET_KEY_PATH,
      path.join(mcpRoot, "secret-store.key"),
      "AGENTGIT_MCP_SECRET_KEY_PATH",
    ),
    AGENTGIT_MCP_HOST_POLICY_PATH: path.join(mcpRoot, "host-policies.db"),
    AGENTGIT_MCP_CONCURRENCY_LEASE_PATH: path.join(mcpRoot, "concurrency.db"),
    AGENTGIT_MCP_HOSTED_WORKER_ENDPOINT: `unix:${path.join(mcpRoot, "hosted-worker.sock")}`,
    AGENTGIT_MCP_HOSTED_WORKER_ATTESTATION_KEY_PATH: path.join(mcpRoot, "hosted-worker-attestation-key.json"),
    AGENTGIT_POLICY_WORKSPACE_CONFIG_PATH: path.join(runtimeRoot, "policy.toml"),
    AGENTGIT_POLICY_CALIBRATION_CONFIG_PATH: path.join(runtimeRoot, "policy.calibration.generated.json"),
  };
}

function createWorkspaceSecretStore(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
  runtimeRoot: string,
): LocalEncryptedSecretStore {
  const authorityEnv = buildAuthorityEnvironmentForWorkspace(workspaceRoot, env, runtimeRoot);
  const dbPath =
    authorityEnv.AGENTGIT_MCP_SECRET_STORE_PATH?.trim() || path.join(runtimeRoot, "mcp", "secret-store.db");
  if (!dbPath) {
    throw new AgentGitError(
      "Contained secret resolution is unavailable because the AgentGit secret store path is missing.",
      "BROKER_UNAVAILABLE",
      {
        workspace_root: workspaceRoot,
      },
    );
  }

  const keyPath =
    authorityEnv.AGENTGIT_MCP_SECRET_KEY_PATH?.trim() || path.join(runtimeRoot, "mcp", "secret-store.key");
  return new LocalEncryptedSecretStore({
    dbPath,
    keyPath,
    keyProvider: createFileBackedSecretKeyProvider(),
  });
}

async function ensureAuthoritySession(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
  runtimeRoot: string,
  runtime: AuthoritySessionRuntime = DEFAULT_AUTHORITY_SESSION_RUNTIME,
): Promise<AuthoritySession> {
  ensurePrivateDirectory(path.dirname(runtimeRoot));
  ensurePrivateDirectory(runtimeRoot);
  const daemonEnv = buildAuthorityEnvironmentForWorkspace(workspaceRoot, env, runtimeRoot);
  const daemonConfig = resolveAuthorityDaemonRuntimeConfig(daemonEnv, workspaceRoot);
  let lastError: unknown;

  for (let attempt = 1; attempt <= AUTHORITY_SESSION_MAX_ATTEMPTS; attempt += 1) {
    let client = runtime.build_client(daemonConfig.socketPath);

    try {
      const hello = await client.hello([workspaceRoot]);
      return {
        client,
        session_id: hello.session_id,
        daemon_config: daemonConfig,
        daemon_started: false,
      };
    } catch (error) {
      if (!isConnectFailure(error)) {
        throw error;
      }
      lastError = error;
    }

    const releaseRuntimeLock = acquireRuntimeLock(runtimeRoot);
    if (!releaseRuntimeLock) {
      if (attempt < AUTHORITY_SESSION_MAX_ATTEMPTS) {
        await runtime.sleep(AUTHORITY_SESSION_RETRY_DELAY_MS);
        continue;
      }
      break;
    }

    client = runtime.build_client(daemonConfig.socketPath);
    try {
      const hello = await client.hello([workspaceRoot]);
      releaseRuntimeLock();
      return {
        client,
        session_id: hello.session_id,
        daemon_config: daemonConfig,
        daemon_started: false,
      };
    } catch (error) {
      if (!isConnectFailure(error)) {
        releaseRuntimeLock();
        throw error;
      }
      lastError = error;
    }

    let daemon: StartedAuthorityDaemon | undefined;
    try {
      daemon = await runtime.start_daemon(daemonConfig);
    } catch (error) {
      releaseRuntimeLock();
      lastError = error;
      if (isAddressInUseFailure(error) && attempt < AUTHORITY_SESSION_MAX_ATTEMPTS) {
        await runtime.sleep(AUTHORITY_SESSION_RETRY_DELAY_MS);
        continue;
      }
      throw error;
    }

    client = runtime.build_client(daemonConfig.socketPath);
    try {
      const hello = await client.hello([workspaceRoot]);
      return {
        client,
        session_id: hello.session_id,
        daemon_config: daemonConfig,
        daemon_started: true,
        daemon,
        runtime_lock_release: releaseRuntimeLock,
      };
    } catch (error) {
      lastError = error;
      await daemon.shutdown().catch(() => undefined);
      releaseRuntimeLock();
      if (isConnectFailure(error) && attempt < AUTHORITY_SESSION_MAX_ATTEMPTS) {
        await runtime.sleep(AUTHORITY_SESSION_RETRY_DELAY_MS);
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new AgentGitError("AgentGit could not establish a local authority daemon session.", "INTERNAL_ERROR", {
        workspace_root: workspaceRoot,
      });
}

export const __testables = {
  ensureAuthoritySession,
  createWorkspaceSecretStore,
  isAddressInUseFailure,
  deriveRestoreTargetFromStep,
  buildRestoreCommand,
  summarizeRestoreTarget,
  describeRestoreBoundary,
  explainRestoreBoundary,
  planRestorePresentation,
};

async function suppressRuntimeNoise<T>(callback: () => Promise<T>): Promise<T> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((..._args: unknown[]) => true) as typeof process.stdout.write;
  try {
    return await callback();
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
}

async function withAuthoritySession<T>(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv,
  runtimeRoot: string,
  callback: (session: AuthoritySession) => Promise<T>,
): Promise<T> {
  const session = await ensureAuthoritySession(workspaceRoot, env, runtimeRoot);
  try {
    return await callback(session);
  } finally {
    if (session.daemon) {
      await session.daemon.shutdown();
    }
    session.runtime_lock_release?.();
  }
}

function adapterByRuntimeId(runtimeId: RuntimeProfileDocument["runtime_id"]): RuntimeAdapter {
  const adapter = createAdapterRegistry().find((candidate) => candidate.runtime_id === runtimeId);
  if (!adapter) {
    throw new AgentGitError(`No AgentGit adapter is registered for ${runtimeId}.`, "INTERNAL_ERROR", {
      runtime_id: runtimeId,
    });
  }

  return adapter;
}

function createFilesystemWriteAttempt(runId: string, workspaceRoot: string, targetPath: string, content: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "write_file",
      tool_kind: "filesystem" as const,
    },
    raw_call: {
      operation: "write",
      path: targetPath,
      content,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "none" as const,
    },
    framework_context: {
      agent_name: "agentgit-product-cli",
      agent_framework: "product_cli",
    },
    received_at: new Date().toISOString(),
  };
}

function createFilesystemDeleteAttempt(runId: string, workspaceRoot: string, targetPath: string) {
  return {
    run_id: runId,
    tool_registration: {
      tool_name: "delete_file",
      tool_kind: "filesystem" as const,
    },
    raw_call: {
      operation: "delete",
      path: targetPath,
    },
    environment_context: {
      workspace_roots: [workspaceRoot],
      cwd: workspaceRoot,
      credential_mode: "none" as const,
    },
    framework_context: {
      agent_name: "agentgit-product-cli",
      agent_framework: "product_cli",
    },
    received_at: new Date().toISOString(),
  };
}

function changedPathCandidates(step: Awaited<ReturnType<AuthorityClient["queryTimeline"]>>["steps"][number]): string[] {
  const candidates = [];
  if (step.related.target_locator) {
    candidates.push(step.related.target_locator);
  }
  if (Array.isArray(step.related.recovery_scope_paths)) {
    candidates.push(...step.related.recovery_scope_paths);
  }
  if (Array.isArray(step.related.overlapping_paths)) {
    candidates.push(...step.related.overlapping_paths);
  }
  return Array.from(
    new Set(candidates.filter((value): value is string => typeof value === "string" && value.length > 0)),
  );
}

function chooseInspectStep(
  timeline: Awaited<ReturnType<AuthorityClient["queryTimeline"]>>,
  preferredActionId?: string,
) {
  if (preferredActionId) {
    const exact = timeline.steps.find((step) => step.action_id === preferredActionId);
    if (exact) {
      return exact;
    }
  }

  const latestGoverned = [...timeline.steps].reverse().filter((step) => step.provenance === "governed");
  return (
    latestGoverned.find(
      (step) =>
        step.reversibility_class !== "irreversible" ||
        step.status === "blocked" ||
        step.status === "awaiting_approval" ||
        step.status === "failed",
    ) ??
    latestGoverned[0] ??
    [...timeline.steps].reverse()[0] ??
    null
  );
}

function summarizeLatestRunWithoutGovernedStep(
  profile: RuntimeProfileDocument | null,
  runSummary: Awaited<ReturnType<AuthorityClient["getRunSummary"]>>,
): {
  summary: string;
  action_title: string;
  action_status: string;
} {
  const runtimeName = profile?.runtime_display_name ?? runSummary.run.agent_name;
  const eventCount = runSummary.run.event_count;
  const latestEvent = runSummary.run.latest_event?.event_type ?? "run.registered";
  return {
    summary:
      eventCount <= 1
        ? `AgentGit launched ${runtimeName}, but no governed file, shell, or MCP action was captured inside that run yet.`
        : `AgentGit launched ${runtimeName}. The latest recorded run event is ${latestEvent}, but no governed restorable action is available yet.`,
    action_title: "Launch command",
    action_status: latestEvent,
  };
}

function summarizeRunCheckpoint(runCheckpoint: RunCheckpointDocument): {
  summary: string;
  action_title: string;
  action_status: string;
} {
  const checkpointLabel = runCheckpoint.checkpoint_kind === "hard_checkpoint" ? "hard checkpoint" : "checkpoint";
  const checkpointPrefix = runCheckpoint.trigger === "default_policy" ? "automatic" : "deliberate";
  return {
    summary: runCheckpoint.reason
      ? `AgentGit captured an ${checkpointPrefix} ${checkpointLabel} before the run continued: ${runCheckpoint.reason}`
      : `AgentGit captured an ${checkpointPrefix} ${checkpointLabel} before the run continued, so you can restore back to that boundary even if no narrower governed action was captured later.`,
    action_title: "Workspace checkpoint",
    action_status: `${runCheckpoint.trigger}:${runCheckpoint.checkpoint_kind}`,
  };
}

function latestCheckpointByTrigger(
  checkpoints: RunCheckpointDocument[],
  trigger: RunCheckpointDocument["trigger"],
): RunCheckpointDocument | null {
  return (
    [...checkpoints]
      .filter((checkpoint) => checkpoint.trigger === trigger)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))[0] ?? null
  );
}

function shouldCreateDefaultCheckpoint(profile: RuntimeProfileDocument, degradedReasons: string[]): boolean {
  if (profile.default_checkpoint_policy === "always_before_run") {
    return true;
  }

  if (profile.default_checkpoint_policy !== "risky_runs") {
    return false;
  }

  return (
    profile.assurance_level !== "integrated" ||
    profile.execution_mode === "docker_contained" ||
    degradedReasons.length > 0
  );
}

function checkpointReasonFromProfile(profile: RuntimeProfileDocument, fallback: string): string {
  const template = profile.checkpoint_reason_template?.trim();
  return template && template.length > 0 ? template : fallback;
}

function isCheckpointPlaceholderStep(
  step: Awaited<ReturnType<AuthorityClient["queryTimeline"]>>["steps"][number] | null,
): boolean {
  if (!step) {
    return false;
  }

  return step.summary.includes("checkpoint.created") || step.title.toLowerCase().includes("checkpoint.created");
}

function defaultRestoreTarget(
  shortcut: RestoreShortcutDocument | null,
  demoRun: DemoRunDocument | null,
  runCheckpoint: RunCheckpointDocument | null,
): RecoveryTarget | null {
  if (shortcut) {
    return shortcut.preferred_restore_target;
  }

  if (demoRun) {
    if (demoRun.restore_boundary_id.startsWith("snap_")) {
      return {
        type: "snapshot_id",
        snapshot_id: demoRun.restore_boundary_id,
      };
    }
    return {
      type: "action_boundary",
      action_id: demoRun.dangerous_action_id,
    };
  }

  if (runCheckpoint) {
    return {
      type: "run_checkpoint",
      run_checkpoint: runCheckpoint.run_checkpoint,
    };
  }

  return null;
}

function buildContainedDetails(source: {
  execution_mode: RuntimeProfileDocument["execution_mode"];
  containment_backend?: RuntimeProfileDocument["containment_backend"];
  container_network_policy?: ContainerNetworkPolicy;
  contained_egress_mode?: ContainedEgressMode;
  contained_egress_assurance?: ContainedEgressAssurance;
  contained_credential_mode?: ContainedCredentialMode;
  runtime_credential_bindings?: RuntimeProfileDocument["runtime_credential_bindings"];
  credential_passthrough_env_keys?: string[];
  contained_secret_env_bindings?: RuntimeProfileDocument["contained_secret_env_bindings"];
  contained_secret_file_bindings?: RuntimeProfileDocument["contained_secret_file_bindings"];
  contained_proxy_allowlist_hosts?: RuntimeProfileDocument["contained_proxy_allowlist_hosts"];
  capability_snapshot?: RuntimeProfileDocument["capability_snapshot"];
}): ProductContainedDetails | undefined {
  if (source.execution_mode !== "docker_contained" || !source.containment_backend) {
    return undefined;
  }

  const credentialEnvKeys =
    source.contained_credential_mode === "brokered_bindings"
      ? (source.runtime_credential_bindings ?? [])
          .filter(
            (binding): binding is RuntimeCredentialBindingDocument & { target: { surface: "env"; env_key: string } } =>
              binding.target.surface === "env",
          )
          .map((binding) => `${binding.kind}:${binding.target.env_key}`)
      : [...(source.credential_passthrough_env_keys ?? [])];
  const credentialFilePaths =
    source.contained_credential_mode === "brokered_bindings"
      ? (source.runtime_credential_bindings ?? [])
          .filter(
            (
              binding,
            ): binding is RuntimeCredentialBindingDocument & { target: { surface: "file"; relative_path: string } } =>
              binding.target.surface === "file",
          )
          .map(
            (binding) =>
              `${binding.kind}:${CONTAINED_SECRET_MOUNT_ROOT}/${binding.target.relative_path.replace(/^\/+/, "")}`,
          )
      : [];

  return {
    backend: source.containment_backend,
    network_policy: source.container_network_policy ?? "inherit",
    egress_mode:
      source.contained_egress_mode ??
      deriveContainedEgressMode({
        network_policy: source.container_network_policy,
        egress_allowlist_hosts: source.contained_proxy_allowlist_hosts,
      }),
    egress_assurance:
      source.contained_egress_assurance ??
      deriveContainedEgressAssurance({
        egress_mode:
          source.contained_egress_mode ??
          deriveContainedEgressMode({
            network_policy: source.container_network_policy,
            egress_allowlist_hosts: source.contained_proxy_allowlist_hosts,
          }),
        backend_supports_enforced_allowlist: source.capability_snapshot?.backend_enforced_allowlist_supported ?? false,
      }),
    credential_mode: source.contained_credential_mode ?? "none",
    credential_env_keys: credentialEnvKeys,
    credential_file_paths: credentialFilePaths,
    egress_allowlist_hosts: [...(source.contained_proxy_allowlist_hosts ?? [])],
    capability_snapshot: source.capability_snapshot,
  };
}

function deriveRestoreTargetFromStep(
  step: Awaited<ReturnType<AuthorityClient["queryTimeline"]>>["steps"][number] | null,
): RecoveryTarget | null {
  if (!step) {
    return null;
  }

  if (step.related.recovery_target_type === "path_subset" && step.related.snapshot_id) {
    const paths =
      step.related.recovery_scope_paths && step.related.recovery_scope_paths.length > 0
        ? step.related.recovery_scope_paths
        : step.related.target_locator
          ? [step.related.target_locator]
          : [];
    if (paths.length > 0) {
      return {
        type: "path_subset",
        snapshot_id: step.related.snapshot_id,
        paths,
      };
    }
  }

  if (step.related.recovery_target_type === "action_boundary" && step.action_id) {
    return {
      type: "action_boundary",
      action_id: step.action_id,
    };
  }

  if (!step.related.snapshot_id && step.action_id && step.reversibility_class === "review_only") {
    return {
      type: "action_boundary",
      action_id: step.action_id,
    };
  }

  if (step.related.snapshot_id) {
    return {
      type: "snapshot_id",
      snapshot_id: step.related.snapshot_id,
    };
  }

  return null;
}

function buildRestoreCommand(target: ProductRestoreTarget | null): string | null {
  if (!target) {
    return null;
  }

  if (isContainedProjectionTarget(target)) {
    return buildContainedProjectionRestoreCommand(target.contained_run_id);
  }

  if (target.type === "path_subset" && target.paths.length === 1) {
    return `agentgit restore --path ${JSON.stringify(target.paths[0])}`;
  }

  if (target.type === "path_subset") {
    return "agentgit restore";
  }

  if (target.type === "action_boundary") {
    return `agentgit restore --action-id ${target.action_id}`;
  }

  if (target.type === "snapshot_id") {
    return `agentgit restore --snapshot-id ${target.snapshot_id}`;
  }

  if (target.type === "run_checkpoint") {
    return `agentgit restore --checkpoint ${target.run_checkpoint}`;
  }

  if (target.type === "branch_point") {
    return `agentgit restore --branch-point ${target.run_id}#${target.sequence}`;
  }

  return "agentgit restore";
}

function summarizeRestoreTarget(target: ProductRestoreTarget): string {
  if (isContainedProjectionTarget(target)) {
    return `discard unpublished contained changes for ${target.contained_run_id}`;
  }

  switch (target.type) {
    case "path_subset":
      return target.paths.join(", ");
    case "action_boundary":
      return `action ${target.action_id}`;
    case "snapshot_id":
      return `snapshot ${target.snapshot_id}`;
    case "external_object":
      return `external object ${target.external_object_id}`;
    case "run_checkpoint":
      return `run checkpoint ${target.run_checkpoint}`;
    case "branch_point":
      return `branch point ${target.run_id}:${target.sequence}`;
  }
}

function describeRestoreBoundary(target: ProductRestoreTarget, recoveryClass: string | null = null): string {
  if (isContainedProjectionTarget(target)) {
    return "contained projection discard";
  }

  if (recoveryClass === "review_only") {
    switch (target.type) {
      case "path_subset":
        return "review-only targeted path restore";
      case "snapshot_id":
        return "review-only snapshot boundary";
      case "action_boundary":
        return "review-only action boundary";
      case "run_checkpoint":
        return "review-only checkpoint boundary";
      case "branch_point":
        return "review-only branch-point boundary";
      case "external_object":
        return "review-only external object recovery";
    }
  }

  switch (target.type) {
    case "path_subset":
      return "targeted path restore";
    case "snapshot_id":
      return "snapshot restore";
    case "action_boundary":
      return "action boundary restore";
    case "run_checkpoint":
      return "checkpoint restore";
    case "branch_point":
      return "branch point restore";
    case "external_object":
      return "external object compensation";
  }
}

function explainRestoreBoundary(target: ProductRestoreTarget, recoveryClass: string | null = null): string {
  if (isContainedProjectionTarget(target)) {
    return "AgentGit can discard unpublished projected changes directly because they have not been applied to the real workspace.";
  }

  if (recoveryClass === "review_only") {
    switch (target.type) {
      case "path_subset":
        return target.paths.length === 1
          ? "AgentGit can point manual review at the recorded changed path, but this boundary is not trusted for exact automatic restore."
          : "AgentGit can point manual review at the recorded changed paths, but this boundary is not trusted for exact automatic restore.";
      case "snapshot_id":
        return "AgentGit can inspect the captured snapshot boundary, but this restore still requires manual review instead of exact automatic replay.";
      case "action_boundary":
        return "AgentGit can inspect the governed action boundary, but this restore still requires manual review instead of exact automatic replay.";
      case "run_checkpoint":
        return "AgentGit can inspect the checkpoint boundary, but this restore still requires manual review instead of exact automatic replay.";
      case "branch_point":
        return "AgentGit can inspect the branch-point boundary, but this restore still requires manual review instead of exact automatic replay.";
      case "external_object":
        return "AgentGit can inspect the external-object boundary, but applying recovery still depends on manual review or adapter-specific compensation.";
    }
  }

  switch (target.type) {
    case "path_subset":
      return target.paths.length === 1
        ? "AgentGit can safely target the recorded changed path without widening the restore scope."
        : "AgentGit can safely target the recorded changed paths without widening the restore scope.";
    case "snapshot_id":
      return "AgentGit needs the broader captured snapshot because a narrower targeted restore boundary was not available.";
    case "action_boundary":
      return "AgentGit is restoring the full governed action boundary because the safest recoverable scope is the action itself.";
    case "run_checkpoint":
      return "AgentGit is restoring from a deliberate run checkpoint boundary captured before later changes.";
    case "branch_point":
      return "AgentGit is restoring from a broader branch-point boundary captured before the run diverged.";
    case "external_object":
      return "This restore depends on adapter-specific compensation rather than a direct filesystem snapshot replay.";
  }
}

interface RestorePresentation {
  restore_available: boolean;
  recovery_class: string | null;
  restore_boundary: string | null;
  restore_guidance: string | null;
}

async function planRestorePresentation(
  client: AuthorityClient,
  target: ProductRestoreTarget | null,
): Promise<RestorePresentation> {
  if (!target || isContainedProjectionTarget(target)) {
    return {
      restore_available: Boolean(target),
      recovery_class: null,
      restore_boundary: target ? describeRestoreBoundary(target) : null,
      restore_guidance: target ? explainRestoreBoundary(target) : null,
    };
  }

  try {
    const planResult = await client.planRecovery(target);
    const recoveryClass = planResult.recovery_plan.recovery_class;
    return {
      restore_available: true,
      recovery_class: recoveryClass,
      restore_boundary: describeRestoreBoundary(target, recoveryClass),
      restore_guidance: explainRestoreBoundary(target, recoveryClass),
    };
  } catch {
    return {
      restore_available: false,
      recovery_class: null,
      restore_boundary: null,
      restore_guidance: null,
    };
  }
}

function describeRestoreVsCheckpoint(
  target: ProductRestoreTarget | null,
  latestCheckpoint: RunCheckpointDocument | null,
): string | null {
  if (!target || !latestCheckpoint) {
    return null;
  }

  if (isContainedProjectionTarget(target)) {
    return "Contained projection discard is separate from the latest checkpoint boundary.";
  }

  if (target.type === "path_subset" || target.type === "action_boundary") {
    return "Recommended restore target is narrower than the latest checkpoint boundary.";
  }

  if (target.type === "run_checkpoint" && target.run_checkpoint === latestCheckpoint.run_checkpoint) {
    return "Recommended restore target matches the latest checkpoint boundary.";
  }

  if (target.type === "snapshot_id" || target.type === "branch_point" || target.type === "run_checkpoint") {
    return "Recommended restore target is as broad as or broader than the latest checkpoint boundary.";
  }

  return null;
}

function explainRestorePreview(recoveryClass: string, conflictDetected: boolean, previewOnly: boolean): string | null {
  if (!previewOnly) {
    return null;
  }

  if (recoveryClass === "review_only") {
    return "AgentGit is previewing only because this recovery boundary is not trusted for exact automatic restore.";
  }

  if (conflictDetected) {
    return "AgentGit is previewing only because applying this restore would overwrite newer workspace changes.";
  }

  return "AgentGit is previewing the planned restore before applying it.";
}

interface ContainedProjectionTarget {
  type: "contained_projection";
  contained_run_id: string;
}

type ProductRestoreTarget = RecoveryTarget | ContainedProjectionTarget;

function isContainedProjectionTarget(target: ProductRestoreTarget): target is ContainedProjectionTarget {
  return target.type === "contained_projection";
}

function buildContainedProjectionRestoreCommand(containedRunId: string): string {
  return `agentgit restore --contained-run-id ${containedRunId}`;
}

function parseBranchPointToken(token: string): { run_id: string; sequence: number } {
  const separatorIndex = token.lastIndexOf("#");
  if (separatorIndex <= 0 || separatorIndex === token.length - 1) {
    throw new AgentGitError("Malformed branch point target.", "BAD_REQUEST", {
      branch_point: token,
      expected_format: "<run_id>#<snapshot_sequence>",
    });
  }

  const runId = token.slice(0, separatorIndex);
  const sequence = Number.parseInt(token.slice(separatorIndex + 1), 10);
  if (!Number.isInteger(sequence) || sequence <= 0) {
    throw new AgentGitError("Malformed branch point target.", "BAD_REQUEST", {
      branch_point: token,
      expected_format: "<run_id>#<snapshot_sequence>",
    });
  }

  return {
    run_id: runId,
    sequence,
  };
}

function detectPathOverwriteConflict(target: RecoveryTarget): boolean {
  if (target.type !== "path_subset") {
    return false;
  }

  return target.paths.some((targetPath) => fs.existsSync(targetPath));
}

function governedShimBinDirFromProfile(profile: RuntimeProfileDocument): string | null {
  const metadata = profile.adapter_metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const shimBinDir = (metadata as Record<string, unknown>).shim_bin_dir;
  return typeof shimBinDir === "string" && shimBinDir.length > 0 ? shimBinDir : null;
}

function commandWords(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  let tokenStarted = false;

  for (const character of command.trim()) {
    if (escaping) {
      current += character;
      escaping = false;
      tokenStarted = true;
      continue;
    }

    if (character === "\\") {
      escaping = true;
      tokenStarted = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      tokenStarted = true;
      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      tokenStarted = true;
      continue;
    }

    if (/\s/u.test(character)) {
      if (tokenStarted) {
        words.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }

    current += character;
    tokenStarted = true;
  }

  if (escaping || quote) {
    throw new AgentGitError("Launch command contains an unterminated escape or quote.", "PRECONDITION_FAILED", {
      launch_command: command,
    });
  }

  if (tokenStarted) {
    words.push(current);
  }

  return words.filter((value) => value.length > 0);
}

function parseLaunchCommand(command: string): { command: string; args: string[] } {
  const words = commandWords(command);
  if (words.length === 0) {
    throw new AgentGitError("Launch command is empty.", "PRECONDITION_FAILED", {
      launch_command: command,
    });
  }

  return {
    command: words[0]!,
    args: words.slice(1),
  };
}

function resolveLaunchExecutable(command: string, cwd: string, pathValue: string | undefined): string {
  if (path.isAbsolute(command)) {
    return command;
  }

  if (command.includes(path.sep)) {
    return path.resolve(cwd, command);
  }

  const pathEntries = (pathValue ?? process.env.PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const entry of pathEntries) {
    const candidate = path.join(entry, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  return command;
}

async function terminateChildProcessIfNeeded(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };

    const timeout = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      finish();
    }, CHILD_CLEANUP_TIMEOUT_MS);

    child.once("close", () => {
      clearTimeout(timeout);
      finish();
    });

    child.kill("SIGTERM");
  });
}

function assuranceCeilingForProfile(
  profile: Pick<RuntimeProfileDocument, "runtime_id" | "execution_mode" | "containment_backend" | "assurance_level">,
): AssuranceLevel {
  if (profile.runtime_id === "openclaw") {
    return "integrated";
  }

  if (
    profile.runtime_id === "generic-command" &&
    (profile.execution_mode === "docker_contained" ||
      profile.containment_backend === "docker" ||
      profile.assurance_level === "contained")
  ) {
    return "contained";
  }

  return "attached";
}

export interface ProductSetupResult {
  action: "setup" | "remove" | "repair";
  runtime: string | null;
  workspace_root: string;
  assurance_level: AssuranceLevel | null;
  assurance_ceiling: AssuranceLevel | null;
  governance_mode: GovernanceMode | null;
  guarantees: GovernanceGuarantee[];
  governed_surfaces: string[];
  degraded_reasons: string[];
  default_checkpoint_policy: DefaultCheckpointPolicy | null;
  checkpoint_intent: RuntimeProfileDocument["checkpoint_intent"] | null;
  checkpoint_reason_template: string | null;
  changed: boolean;
  next_command: string | null;
  health_checks: VerifyResult["health_checks"];
  preserved_user_changes: string[];
  contained_details?: ProductContainedDetails;
}

export interface ProductDemoResult {
  workspace_root: string;
  demo_workspace_root: string;
  run_id: string;
  dangerous_action_id: string;
  restore_boundary_id: string;
  deleted_path: string;
  inspect_command: string;
  restore_command: string;
}

export interface ProductInspectResult {
  workspace_root: string;
  governed_workspace_root: string | null;
  run_id: string | null;
  found: boolean;
  assurance_level: AssuranceLevel | null;
  governance_mode: GovernanceMode | null;
  guarantees: GovernanceGuarantee[];
  summary: string;
  action_title: string | null;
  action_status: string | null;
  changed_paths: string[];
  restore_available: boolean;
  restore_command: string | null;
  restore_boundary: string | null;
  restore_guidance: string | null;
  default_checkpoint_policy: DefaultCheckpointPolicy | null;
  checkpoint_intent: RuntimeProfileDocument["checkpoint_intent"] | null;
  checkpoint_reason_template: string | null;
  latest_explicit_checkpoint: RunCheckpointDocument | null;
  latest_automatic_checkpoint: RunCheckpointDocument | null;
  restore_vs_checkpoint: string | null;
  degraded_reasons: string[];
  contained_details?: ProductContainedDetails;
}

export interface ProductContainedDetails {
  backend: string;
  network_policy: ContainerNetworkPolicy;
  egress_mode: ContainedEgressMode;
  egress_assurance: ContainedEgressAssurance;
  credential_mode: ContainedCredentialMode;
  credential_env_keys: string[];
  credential_file_paths: string[];
  egress_allowlist_hosts: string[];
  capability_snapshot?: RuntimeProfileDocument["capability_snapshot"];
}

export interface ProductRestoreResult {
  workspace_root: string;
  governed_workspace_root: string;
  preview_only: boolean;
  restored: boolean;
  conflict_detected: boolean;
  recovery_class: string;
  target: ProductRestoreTarget;
  target_summary: string;
  restore_source: string;
  restore_boundary: string;
  restore_guidance: string;
  exactness: "exact" | "review_only";
  preview_reason: string | null;
  deletes_files: boolean | null;
  changed_path_count: number | null;
  overlapping_paths: string[];
  restore_command: string;
  advanced_command?: string;
}

export interface ProductRunResult {
  workspace_root: string;
  runtime: string;
  run_id: string;
  exit_code: number;
  signal?: NodeJS.Signals;
  daemon_started: boolean;
  run_checkpoint?: string;
  checkpoint_kind?: RunCheckpointKind;
  checkpoint_trigger?: RunCheckpointDocument["trigger"];
  checkpoint_reason?: string;
  checkpoint_restore_command?: string;
}

export interface ProductCommandEnvironment {
  cwd: string;
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  spawn_process: typeof spawn;
}

export interface ProductSetupOptions {
  user_command?: string;
  setup_preferences?: SetupPreferences;
}

export class AgentRuntimeIntegrationService {
  private readonly state: ProductStateStore;
  private readonly runner: CommandRunner;
  private readonly env: NodeJS.ProcessEnv;
  private readonly cwd: string;
  private readonly spawnProcess: typeof spawn;

  constructor(options: Partial<ProductCommandEnvironment> = {}) {
    this.cwd = options.cwd ?? process.cwd();
    this.env = options.env ?? process.env;
    this.runner = options.runner ?? new DefaultCommandRunner();
    this.spawnProcess = options.spawn_process ?? spawn;
    this.state = new ProductStateStore(this.env);
  }

  close(): void {
    this.state.close();
  }

  resolveWorkspaceRoot(explicitWorkspaceRoot?: string): string {
    return explicitWorkspaceRoot ? path.resolve(explicitWorkspaceRoot) : resolveWorkspaceRoot(this.cwd, this.runner);
  }

  createAdapterContext(
    workspaceRoot: string,
    userCommand?: string,
    setupPreferences?: SetupPreferences,
  ): AdapterContext {
    return createAdapterContext({
      workspace_root: workspaceRoot,
      cwd: this.cwd,
      env: this.env,
      runner: this.runner,
      state: this.state,
      user_command: userCommand,
      setup_preferences: setupPreferences,
    });
  }

  private createRepairAdapterContext(
    workspaceRoot: string,
    userCommand?: string,
    setupPreferences?: SetupPreferences,
  ): AdapterContext {
    return createAdapterContext({
      workspace_root: workspaceRoot,
      cwd: this.cwd,
      env: this.env,
      runner: this.runner,
      state: this.state,
      user_command: userCommand,
      repair_mode: true,
      setup_preferences: setupPreferences,
    });
  }

  private runtimeRootForWorkspace(workspaceRoot: string): string {
    if (process.platform !== "win32") {
      return path.join("/tmp", "agentgit-runtime", runtimeHash(workspaceRoot));
    }

    return path.join(this.state.paths.state_root, "authority-runtime", runtimeHash(workspaceRoot));
  }

  detectRuntime(
    workspaceRoot: string,
    userCommand?: string,
    setupPreferences?: SetupPreferences,
  ): {
    adapter: RuntimeAdapter;
    detection: DetectionResult;
  } | null {
    return detectBestRuntime(this.createAdapterContext(workspaceRoot, userCommand, setupPreferences));
  }

  previewSetup(workspaceRoot: string, options: ProductSetupOptions = {}) {
    const context = this.createAdapterContext(workspaceRoot, options.user_command, options.setup_preferences);
    return planSetup(context);
  }

  private validateContainedRuntimeBindings(
    workspaceRoot: string,
    source: Pick<
      InstallPlan | RuntimeProfileDocument,
      "execution_mode" | "contained_credential_mode" | "runtime_credential_bindings"
    >,
  ): void {
    if (source.execution_mode !== "docker_contained" || source.contained_credential_mode !== "brokered_bindings") {
      return;
    }

    const runtimeBindings = source.runtime_credential_bindings ?? [];
    if (runtimeBindings.length === 0) {
      throw new AgentGitError(
        "Brokered contained credentials were requested, but no runtime credential bindings were provided.",
        "PRECONDITION_FAILED",
        {
          workspace_root: workspaceRoot,
          recommended_command:
            "agentgit setup --repair --credentials brokered-bindings --secret-env OPENAI_API_KEY=<secret-id> --secret-file openai.key=<secret-id>",
        },
      );
    }

    const secretStore = createWorkspaceSecretStore(
      workspaceRoot,
      this.env,
      this.runtimeRootForWorkspace(workspaceRoot),
    );
    try {
      for (const binding of runtimeBindings) {
        secretStore.resolveRuntimeCredentialBinding(binding);
      }
    } finally {
      secretStore.close();
    }
  }

  private writeResolvedContainedBindingArtifacts(
    workspaceRoot: string,
    profile: RuntimeProfileDocument,
    containedRoot: string,
  ): { env_file_path?: string; secret_file_root?: string } {
    if (profile.contained_credential_mode !== "brokered_bindings") {
      return {};
    }

    const runtimeBindings = profile.runtime_credential_bindings ?? [];
    if (runtimeBindings.length === 0) {
      throw new AgentGitError(
        "Contained runtime is configured for brokered runtime bindings, but no bindings are saved in this profile.",
        "PRECONDITION_FAILED",
        {
          workspace_root: workspaceRoot,
          recommended_command: "agentgit setup --repair",
        },
      );
    }

    const secretStore = createWorkspaceSecretStore(
      workspaceRoot,
      this.env,
      this.runtimeRootForWorkspace(workspaceRoot),
    );
    try {
      const resolved: { env_file_path?: string; secret_file_root?: string } = {};
      const envBindings = runtimeBindings.filter(
        (binding): binding is RuntimeCredentialBindingDocument & { target: { surface: "env"; env_key: string } } =>
          binding.target.surface === "env",
      );
      const fileBindings = runtimeBindings.filter(
        (
          binding,
        ): binding is RuntimeCredentialBindingDocument & { target: { surface: "file"; relative_path: string } } =>
          binding.target.surface === "file",
      );
      if (envBindings.length > 0) {
        const envFilePath = path.join(containedRoot, "brokered-env.list");
        const lines = envBindings.map((binding) => {
          const resolvedBinding = secretStore.resolveRuntimeCredentialBinding(binding);
          return `${binding.target.env_key}=${resolvedBinding.resolved_value}`;
        });
        writeSecureTextFile(envFilePath, `${lines.join("\n")}\n`);
        resolved.env_file_path = envFilePath;
      }

      if (fileBindings.length > 0) {
        const secretFileRoot = path.join(containedRoot, "brokered-secrets");
        ensurePrivateDirectory(secretFileRoot);
        for (const binding of fileBindings) {
          const targetPath = resolveContainedSecretTarget(secretFileRoot, binding.target.relative_path);
          const resolvedBinding = secretStore.resolveRuntimeCredentialBinding(binding);
          writeSecureTextFile(targetPath, `${resolvedBinding.resolved_value}\n`);
        }
        resolved.secret_file_root = secretFileRoot;
      }

      return resolved;
    } finally {
      secretStore.close();
    }
  }

  private cleanupWorkspaceArtifacts(workspaceRoot: string, options: { keep_backups?: boolean } = {}): void {
    if (!options.keep_backups) {
      for (const backup of this.state.listConfigBackups(workspaceRoot)) {
        fs.rmSync(backup.backup_path, { force: true });
        this.state.deleteConfigBackup(backup.backup_id);
      }
    }

    for (const shortcut of this.state.listRestoreShortcuts(workspaceRoot)) {
      this.state.deleteRestoreShortcut(shortcut.shortcut_id);
    }

    for (const demoRun of this.state.listDemoRuns(workspaceRoot)) {
      this.state.deleteDemoRun(demoRun.demo_run_id);
    }

    for (const checkpoint of this.state.listRunCheckpoints(workspaceRoot)) {
      this.state.deleteRunCheckpoint(checkpoint.checkpoint_id);
    }

    for (const containedRun of this.state.listContainedRuns(workspaceRoot)) {
      fs.rmSync(path.dirname(containedRun.projection_root), { recursive: true, force: true });
      this.state.deleteContainedRun(containedRun.contained_run_id);
    }

    fs.rmSync(createDemoWorkspaceRoot(this.state.paths, workspaceRoot), { recursive: true, force: true });
  }

  private resolveRecentRunContext(workspaceRoot: string): {
    run_id: string | null;
    governed_workspace_root: string | null;
    shortcut: RestoreShortcutDocument | null;
    demo_run: DemoRunDocument | null;
    run_checkpoint: RunCheckpointDocument | null;
    profile: RuntimeProfileDocument | null;
    contained_run: ContainedRunDocument | null;
  } {
    const shortcut = this.state.latestRestoreShortcut(workspaceRoot);
    const demoRun = this.state.latestDemoRun(workspaceRoot);
    const runCheckpoint = this.state.latestRunCheckpoint(workspaceRoot);
    const profile = this.state.getProfileForWorkspace(workspaceRoot);
    const containedRun = this.state.latestContainedRun(workspaceRoot);
    return {
      run_id:
        shortcut?.run_id ??
        demoRun?.run_id ??
        runCheckpoint?.run_id ??
        containedRun?.run_id ??
        profile?.last_run_id ??
        null,
      governed_workspace_root:
        shortcut?.governed_workspace_root ??
        demoRun?.demo_workspace_root ??
        runCheckpoint?.governed_workspace_root ??
        workspaceRoot,
      shortcut,
      demo_run: demoRun,
      run_checkpoint: runCheckpoint,
      profile,
      contained_run: containedRun,
    };
  }

  private setupPreferencesFromProfile(profile: RuntimeProfileDocument): SetupPreferences {
    const adapterMetadata =
      profile.adapter_metadata &&
      typeof profile.adapter_metadata === "object" &&
      !Array.isArray(profile.adapter_metadata)
        ? (profile.adapter_metadata as Record<string, unknown>)
        : {};

    return {
      experience: adapterMetadata.setup_experience === "advanced" ? "advanced" : "recommended",
      policy_strictness: adapterMetadata.policy_strictness === "strict" ? "strict" : "balanced",
      install_scope: profile.install_scope,
      assurance_target: profile.assurance_level,
      default_checkpoint_policy: profile.default_checkpoint_policy,
      checkpoint_intent: profile.checkpoint_intent,
      checkpoint_reason_template: profile.checkpoint_reason_template,
      containment_backend: profile.containment_backend,
      container_image: profile.container_image,
      container_network_policy: profile.container_network_policy,
      contained_egress_mode: profile.contained_egress_mode,
      contained_egress_assurance: profile.contained_egress_assurance,
      contained_credential_mode: profile.contained_credential_mode,
      runtime_credential_bindings: profile.runtime_credential_bindings,
      credential_passthrough_env_keys: profile.credential_passthrough_env_keys,
      contained_secret_env_bindings: profile.contained_secret_env_bindings,
      contained_secret_file_bindings: profile.contained_secret_file_bindings,
      contained_proxy_allowlist_hosts: profile.contained_proxy_allowlist_hosts,
    };
  }

  private planAndVerifyProfileCurrentState(
    workspaceRoot: string,
    profile: RuntimeProfileDocument,
  ): {
    plan: InstallPlan;
    verify_result: VerifyResult;
    contained_details?: ProductContainedDetails;
  } {
    const adapter = adapterByRuntimeId(profile.runtime_id);
    const context = this.createAdapterContext(
      workspaceRoot,
      profile.launch_command,
      this.setupPreferencesFromProfile(profile),
    );
    const detection = adapter.detect(context) ?? {
      runtime_id: profile.runtime_id,
      confidence: 1,
      workspace_root: profile.workspace_root,
      install_scope_candidates: [profile.install_scope],
      evidence: [{ kind: "existing_profile" as const, detail: "Inspecting saved AgentGit profile." }],
      assurance_ceiling: assuranceCeilingForProfile(profile),
      runtime_display_name: profile.runtime_display_name ?? profile.runtime_id,
      launch_command: profile.launch_command,
      runtime_config_path: profile.runtime_config_path,
      adapter_metadata: profile.adapter_metadata,
    };
    const plan = adapter.plan(context, detection);
    const verifyResult = adapter.verify(context, plan);
    return {
      plan,
      verify_result: verifyResult,
      contained_details: buildContainedDetails(plan),
    };
  }

  private verifyProfileCurrentState(
    workspaceRoot: string,
    profile: RuntimeProfileDocument,
  ): {
    degraded_reasons: string[];
    contained_details?: ProductContainedDetails;
  } {
    try {
      const current = this.planAndVerifyProfileCurrentState(workspaceRoot, profile);
      try {
        this.validateContainedRuntimeBindings(workspaceRoot, current.plan);
      } catch (error) {
        const degradedReason =
          error instanceof Error ? `Current runtime verification failed: ${error.message}` : String(error);
        return {
          degraded_reasons: [...new Set([...current.verify_result.degraded_reasons, degradedReason])],
          contained_details: current.contained_details,
        };
      }
      return {
        degraded_reasons: current.verify_result.degraded_reasons,
        contained_details: current.contained_details,
      };
    } catch (error) {
      const degradedReason =
        error instanceof Error ? `Current runtime verification failed: ${error.message}` : String(error);
      return {
        degraded_reasons: [...new Set([...profile.degraded_reasons, degradedReason])],
        contained_details: buildContainedDetails(profile),
      };
    }
  }

  private async publishContainedProjection(
    client: AuthorityClient,
    workspaceRoot: string,
    runId: string,
    containedRun: ContainedRunDocument,
  ): Promise<ContainedRunDocument> {
    const diff = diffWorkspaceProjection(
      workspaceRoot,
      containedRun.projection_root,
      containedRun.baseline_manifest_path,
    );
    if (diff.conflicting_paths.length > 0) {
      return this.state.saveContainedRun({
        ...containedRun,
        status: "publish_conflict",
        changed_paths: diff.changes.map((change) => change.absolute_workspace_path),
        conflicting_paths: diff.conflicting_paths,
        governed_action_ids: [],
      });
    }

    const governedActionIds: string[] = [];
    try {
      for (const change of diff.changes) {
        if (change.kind === "write") {
          const result = await client.submitActionAttempt(
            createFilesystemWriteAttempt(
              runId,
              workspaceRoot,
              change.absolute_workspace_path,
              readProjectionFileText(change.absolute_projection_path),
            ),
          );
          governedActionIds.push(result.action.action_id);
          continue;
        }

        const result = await client.submitActionAttempt(
          createFilesystemDeleteAttempt(runId, workspaceRoot, change.absolute_workspace_path),
        );
        governedActionIds.push(result.action.action_id);
      }

      return this.state.saveContainedRun({
        ...containedRun,
        status: "published",
        changed_paths: diff.changes.map((change) => change.absolute_workspace_path),
        conflicting_paths: [],
        governed_action_ids: governedActionIds,
      });
    } catch (error) {
      return this.state.saveContainedRun({
        ...containedRun,
        status: "publish_failed",
        changed_paths: diff.changes.map((change) => change.absolute_workspace_path),
        conflicting_paths: [],
        governed_action_ids: governedActionIds,
        publication_error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async runDockerContainedProfile(
    workspaceRoot: string,
    profile: RuntimeProfileDocument,
    session: AuthoritySession,
    runId: string,
  ): Promise<ProductRunResult> {
    const backend = resolveContainedBackendRuntime(profile.containment_backend ?? "docker");
    if (!profile.container_image) {
      throw new AgentGitError(
        "Contained runtime profile is missing a container image. Re-run setup --repair.",
        "PRECONDITION_FAILED",
        {
          workspace_root: workspaceRoot,
          recommended_command: "agentgit setup --repair",
        },
      );
    }

    const containedRoot = createContainedRunRoot(this.state.paths, workspaceRoot, runId);
    const projectionRoot = path.join(containedRoot, "workspace");
    const projection = createWorkspaceProjection(workspaceRoot, projectionRoot);
    let containedRun = this.state.saveContainedRun({
      contained_run_id: createContainedRunId(runId),
      workspace_root: workspaceRoot,
      run_id: runId,
      projection_root: projection.projection_root,
      baseline_manifest_path: projection.baseline_manifest_path,
      status: "projection_ready",
      launch_command: profile.launch_command,
      container_image: profile.container_image,
      container_network_policy: profile.container_network_policy,
      contained_egress_mode: profile.contained_egress_mode,
      contained_egress_assurance: profile.contained_egress_assurance,
      contained_credential_mode: profile.contained_credential_mode,
      runtime_credential_bindings: profile.runtime_credential_bindings,
      credential_passthrough_env_keys: profile.credential_passthrough_env_keys,
      contained_secret_env_bindings: profile.contained_secret_env_bindings,
      contained_secret_file_bindings: profile.contained_secret_file_bindings,
      contained_proxy_allowlist_hosts: profile.contained_proxy_allowlist_hosts,
      changed_paths: [],
      conflicting_paths: [],
      governed_action_ids: [],
    });

    const resolvedSecretArtifacts = this.writeResolvedContainedBindingArtifacts(workspaceRoot, profile, containedRoot);
    const egressProxy =
      profile.contained_egress_mode === "proxy_http_https" &&
      profile.contained_proxy_allowlist_hosts &&
      profile.contained_proxy_allowlist_hosts.length > 0
        ? await startContainedEgressProxy(profile.contained_proxy_allowlist_hosts)
        : null;
    const launch = backend.prepare_launch({
      profile,
      projection_root: projection.projection_root,
      host_env: this.env,
      resolved_secret_env_file_path: resolvedSecretArtifacts.env_file_path,
      resolved_secret_file_root: resolvedSecretArtifacts.secret_file_root,
      egress_proxy_port: egressProxy?.port,
      secret_mount_root: CONTAINED_SECRET_MOUNT_ROOT,
    });
    const child = this.spawnProcess(launch.command, launch.args, {
      cwd: workspaceRoot,
      env: launch.env,
      stdio: "inherit",
    });

    let forwardedSignal: NodeJS.Signals | undefined;
    const forwardSignal = (signal: NodeJS.Signals) => {
      forwardedSignal = signal;
      child.kill(signal);
    };
    const signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [
      { signal: "SIGINT", handler: () => forwardSignal("SIGINT") },
      { signal: "SIGTERM", handler: () => forwardSignal("SIGTERM") },
    ];
    const detachSignalHandlers = () => {
      for (const entry of signalHandlers) {
        process.off(entry.signal, entry.handler);
      }
    };
    for (const entry of signalHandlers) {
      process.on(entry.signal, entry.handler);
    }

    try {
      let childOutcome: { exit_code: number; signal?: NodeJS.Signals };
      try {
        childOutcome = await new Promise<{ exit_code: number; signal?: NodeJS.Signals }>((resolve, reject) => {
          child.once("error", (error) => {
            reject(
              new AgentGitError("Contained Docker process failed to start.", "CAPABILITY_UNAVAILABLE", {
                cause: error.message,
                launch_command: profile.launch_command,
                container_image: profile.container_image,
              }),
            );
          });
          child.once("close", (code, signal) => {
            resolve({
              exit_code: code ?? (signal ? 1 : 0),
              signal: signal ?? forwardedSignal,
            });
          });
        });
      } catch (error) {
        this.state.deleteContainedRun(containedRun.contained_run_id);
        fs.rmSync(containedRoot, { recursive: true, force: true });
        throw error;
      }

      containedRun = await this.publishContainedProjection(session.client, workspaceRoot, runId, containedRun);
      const finalExitCode =
        containedRun.status === "publish_conflict" || containedRun.status === "publish_failed"
          ? childOutcome.exit_code === 0
            ? 2
            : childOutcome.exit_code
          : childOutcome.exit_code;

      return {
        workspace_root: workspaceRoot,
        runtime: profile.runtime_display_name ?? profile.runtime_id,
        run_id: runId,
        exit_code: finalExitCode,
        signal: childOutcome.signal,
        daemon_started: session.daemon_started,
      };
    } finally {
      await terminateChildProcessIfNeeded(child);
      if (resolvedSecretArtifacts.env_file_path) {
        fs.rmSync(resolvedSecretArtifacts.env_file_path, { force: true });
      }
      if (resolvedSecretArtifacts.secret_file_root) {
        fs.rmSync(resolvedSecretArtifacts.secret_file_root, { recursive: true, force: true });
      }
      if (egressProxy) {
        await egressProxy.close();
      }
      detachSignalHandlers();
    }
  }

  setup(workspaceRoot: string, options: ProductSetupOptions = {}): ProductSetupResult {
    const context = this.createAdapterContext(workspaceRoot, options.user_command, options.setup_preferences);
    const { adapter, plan } = planSetup(context);
    this.validateContainedRuntimeBindings(workspaceRoot, plan);
    const applyResult = adapter.apply(context, plan);
    const verifyResult = adapter.verify(context, plan);
    return {
      action: "setup",
      runtime: plan.runtime_display_name,
      workspace_root: workspaceRoot,
      assurance_level: plan.assurance_level,
      assurance_ceiling: verifyResult.assurance_ceiling,
      governance_mode: plan.governance_mode,
      guarantees: plan.guarantees,
      governed_surfaces: plan.governed_surfaces,
      degraded_reasons: verifyResult.degraded_reasons,
      default_checkpoint_policy: plan.default_checkpoint_policy ?? null,
      checkpoint_intent: plan.checkpoint_intent ?? null,
      checkpoint_reason_template: plan.checkpoint_reason_template ?? null,
      changed: applyResult.changed,
      next_command: verifyResult.recommended_next_command,
      health_checks: verifyResult.health_checks,
      preserved_user_changes: [],
      contained_details: buildContainedDetails(plan),
    };
  }

  remove(workspaceRoot: string): ProductSetupResult {
    const profile = this.state.getProfileForWorkspace(workspaceRoot);
    if (!profile) {
      this.cleanupWorkspaceArtifacts(workspaceRoot);
      return {
        action: "remove",
        runtime: null,
        workspace_root: workspaceRoot,
        assurance_level: null,
        assurance_ceiling: null,
        governance_mode: null,
        guarantees: [],
        governed_surfaces: [],
        degraded_reasons: [],
        default_checkpoint_policy: null,
        checkpoint_intent: null,
        checkpoint_reason_template: null,
        changed: false,
        next_command: "agentgit setup",
        health_checks: [],
        preserved_user_changes: [],
        contained_details: undefined,
      };
    }

    const install = this.state.latestRuntimeInstall(workspaceRoot);
    if (!install) {
      this.state.deleteRuntimeProfile(profile.profile_id);
      this.cleanupWorkspaceArtifacts(workspaceRoot);
      return {
        action: "remove",
        runtime: profile.runtime_display_name ?? profile.runtime_id,
        workspace_root: workspaceRoot,
        assurance_level: profile.assurance_level,
        assurance_ceiling: assuranceCeilingForProfile(profile),
        governance_mode: profile.governance_mode,
        guarantees: profile.guarantees,
        governed_surfaces: profile.governed_surfaces,
        degraded_reasons: profile.degraded_reasons,
        default_checkpoint_policy: profile.default_checkpoint_policy ?? null,
        checkpoint_intent: profile.checkpoint_intent ?? null,
        checkpoint_reason_template: profile.checkpoint_reason_template ?? null,
        changed: false,
        next_command: "agentgit setup",
        health_checks: [],
        preserved_user_changes: [],
        contained_details: buildContainedDetails(profile),
      };
    }

    const adapter = adapterByRuntimeId(profile.runtime_id);
    const result = adapter.rollback(this.createAdapterContext(workspaceRoot), install, profile);
    this.cleanupWorkspaceArtifacts(workspaceRoot, {
      keep_backups: result.preserved_user_changes.length > 0,
    });
    return {
      action: "remove",
      runtime: profile.runtime_display_name ?? profile.runtime_id,
      workspace_root: workspaceRoot,
      assurance_level: profile.assurance_level,
      assurance_ceiling: assuranceCeilingForProfile(profile),
      governance_mode: profile.governance_mode,
      guarantees: profile.guarantees,
      governed_surfaces: profile.governed_surfaces,
      degraded_reasons: profile.degraded_reasons,
      default_checkpoint_policy: profile.default_checkpoint_policy ?? null,
      checkpoint_intent: profile.checkpoint_intent ?? null,
      checkpoint_reason_template: profile.checkpoint_reason_template ?? null,
      changed: result.changed || result.removed_install || result.removed_profile,
      next_command: "agentgit setup",
      health_checks: [],
      preserved_user_changes: result.preserved_user_changes,
      contained_details: buildContainedDetails(profile),
    };
  }

  repair(workspaceRoot: string, userCommand?: string, setupPreferences?: SetupPreferences): ProductSetupResult {
    const profile = this.state.getProfileForWorkspace(workspaceRoot);
    const effectiveSetupPreferences =
      setupPreferences ?? (profile ? this.setupPreferencesFromProfile(profile) : undefined);
    const context = this.createRepairAdapterContext(
      workspaceRoot,
      userCommand ?? profile?.launch_command,
      effectiveSetupPreferences,
    );
    const adapter = profile ? adapterByRuntimeId(profile.runtime_id) : planSetup(context).adapter;
    const detection =
      adapter.detect(context) ??
      (profile
        ? {
            runtime_id: profile.runtime_id,
            confidence: 1,
            workspace_root: profile.workspace_root,
            install_scope_candidates: [profile.install_scope],
            evidence: [{ kind: "existing_profile" as const, detail: "Repairing saved AgentGit profile." }],
            assurance_ceiling: assuranceCeilingForProfile(profile),
            runtime_display_name: profile.runtime_display_name ?? profile.runtime_id,
            launch_command: profile.launch_command,
            runtime_config_path: profile.runtime_config_path,
            adapter_metadata: profile.adapter_metadata,
          }
        : null);

    if (!detection) {
      throw new AgentGitError("AgentGit could not find anything to repair in this workspace.", "NOT_FOUND", {
        workspace_root: workspaceRoot,
      });
    }

    const plan = adapter.plan(context, detection);
    this.validateContainedRuntimeBindings(workspaceRoot, plan);
    adapter.apply(context, plan);
    const verifyResult = adapter.verify(context, plan);
    return {
      action: "repair",
      runtime: plan.runtime_display_name,
      workspace_root: workspaceRoot,
      assurance_level: plan.assurance_level,
      assurance_ceiling: verifyResult.assurance_ceiling,
      governance_mode: plan.governance_mode,
      guarantees: plan.guarantees,
      governed_surfaces: plan.governed_surfaces,
      degraded_reasons: verifyResult.degraded_reasons,
      default_checkpoint_policy: plan.default_checkpoint_policy ?? null,
      checkpoint_intent: plan.checkpoint_intent ?? null,
      checkpoint_reason_template: plan.checkpoint_reason_template ?? null,
      changed: true,
      next_command: verifyResult.recommended_next_command,
      health_checks: verifyResult.health_checks,
      preserved_user_changes: [],
      contained_details: buildContainedDetails(plan),
    };
  }

  async demo(workspaceRoot: string): Promise<ProductDemoResult> {
    const demoWorkspaceRoot = createDemoWorkspaceRoot(this.state.paths, workspaceRoot);
    fs.rmSync(demoWorkspaceRoot, { recursive: true, force: true });
    fs.mkdirSync(demoWorkspaceRoot, { recursive: true });
    this.runner.run("git", ["init"], { cwd: demoWorkspaceRoot });

    return withAuthoritySession(
      demoWorkspaceRoot,
      this.env,
      this.runtimeRootForWorkspace(demoWorkspaceRoot),
      async ({ client }) => {
        const registerResult = await client.registerRun({
          workflow_name: "agentgit-demo",
          agent_framework: "product_cli",
          agent_name: "agentgit-demo",
          workspace_roots: [demoWorkspaceRoot],
          client_metadata: {
            launched_from_workspace: workspaceRoot,
          },
        });
        const targetPath = path.join(demoWorkspaceRoot, "important-plan.md");
        await client.submitActionAttempt(
          createFilesystemWriteAttempt(
            registerResult.run_id,
            demoWorkspaceRoot,
            targetPath,
            "# Important plan\n\nKeep this file safe.\n",
          ),
        );
        const deleteResult = await client.submitActionAttempt(
          createFilesystemDeleteAttempt(registerResult.run_id, demoWorkspaceRoot, targetPath),
        );
        if (!deleteResult.snapshot_record) {
          throw new AgentGitError("Demo delete did not produce a restorable snapshot boundary.", "INTERNAL_ERROR", {
            run_id: registerResult.run_id,
            action_id: deleteResult.action.action_id,
          });
        }

        const restoreTarget: RecoveryTarget = {
          type: "path_subset",
          snapshot_id: deleteResult.snapshot_record.snapshot_id,
          paths: [targetPath],
        };
        const demoRun = this.state.saveDemoRun({
          demo_run_id: createDemoRunId(workspaceRoot),
          workspace_root: workspaceRoot,
          demo_workspace_root: demoWorkspaceRoot,
          run_id: registerResult.run_id,
          dangerous_action_id: deleteResult.action.action_id,
          restore_boundary_id: deleteResult.snapshot_record.snapshot_id,
          deleted_path: targetPath,
        });
        this.state.saveRestoreShortcut({
          shortcut_id: createRestoreShortcutId(deleteResult.action.action_id),
          workspace_root: workspaceRoot,
          governed_workspace_root: demoWorkspaceRoot,
          run_id: registerResult.run_id,
          action_id: deleteResult.action.action_id,
          preferred_restore_target: restoreTarget,
          restore_boundary_id: deleteResult.snapshot_record.snapshot_id,
          display_path: targetPath,
        });

        return {
          workspace_root: workspaceRoot,
          demo_workspace_root: demoWorkspaceRoot,
          run_id: demoRun.run_id,
          dangerous_action_id: demoRun.dangerous_action_id,
          restore_boundary_id: demoRun.restore_boundary_id,
          deleted_path: demoRun.deleted_path,
          inspect_command: "agentgit inspect",
          restore_command: "agentgit restore",
        };
      },
    );
  }

  async inspect(workspaceRoot: string): Promise<ProductInspectResult> {
    const allCheckpoints = this.state.listRunCheckpoints(workspaceRoot);
    const latestExplicitCheckpoint = latestCheckpointByTrigger(allCheckpoints, "explicit_run_flag");
    const latestAutomaticCheckpoint = latestCheckpointByTrigger(allCheckpoints, "default_policy");
    const {
      run_id: runId,
      governed_workspace_root: governedWorkspaceRoot,
      shortcut,
      demo_run: demoRun,
      run_checkpoint: runCheckpoint,
      profile,
      contained_run: containedRun,
    } = this.resolveRecentRunContext(workspaceRoot);
    const liveProfileState = profile ? this.verifyProfileCurrentState(workspaceRoot, profile) : null;
    const degradedReasons = liveProfileState?.degraded_reasons ?? profile?.degraded_reasons ?? [];
    const containedDetails =
      liveProfileState?.contained_details ?? (profile ? buildContainedDetails(profile) : undefined);
    if (!runId || !governedWorkspaceRoot) {
      return {
        workspace_root: workspaceRoot,
        governed_workspace_root: null,
        run_id: null,
        found: false,
        assurance_level: profile?.assurance_level ?? null,
        governance_mode: profile?.governance_mode ?? null,
        guarantees: profile?.guarantees ?? [],
        summary: "No dangerous governed run is available yet in this workspace. Try agentgit demo first.",
        action_title: null,
        action_status: null,
        changed_paths: [],
        restore_available: false,
        restore_command: null,
        restore_boundary: null,
        restore_guidance: null,
        default_checkpoint_policy: profile?.default_checkpoint_policy ?? null,
        checkpoint_intent: profile?.checkpoint_intent ?? null,
        checkpoint_reason_template: profile?.checkpoint_reason_template ?? null,
        latest_explicit_checkpoint: latestExplicitCheckpoint,
        latest_automatic_checkpoint: latestAutomaticCheckpoint,
        restore_vs_checkpoint: null,
        degraded_reasons: degradedReasons,
        contained_details: containedDetails,
      };
    }

    return withAuthoritySession(
      governedWorkspaceRoot,
      this.env,
      this.runtimeRootForWorkspace(governedWorkspaceRoot),
      async ({ client }) => {
        const timeline = await client.queryTimeline(runId, "user");
        const step = chooseInspectStep(timeline, shortcut?.action_id ?? demoRun?.dangerous_action_id);
        const restoreTarget =
          shortcut?.preferred_restore_target ??
          deriveRestoreTargetFromStep(step) ??
          (runCheckpoint ? { type: "run_checkpoint", run_checkpoint: runCheckpoint.run_checkpoint } : null);
        const restorePresentation = await planRestorePresentation(client, restoreTarget);
        const restoreVsCheckpoint = describeRestoreVsCheckpoint(restoreTarget, runCheckpoint);
        if (!step || (runCheckpoint && isCheckpointPlaceholderStep(step))) {
          if (containedRun?.status === "publish_conflict" || containedRun?.status === "publish_failed") {
            return {
              workspace_root: workspaceRoot,
              governed_workspace_root: governedWorkspaceRoot,
              run_id: runId,
              found: true,
              assurance_level: profile?.assurance_level ?? null,
              governance_mode: profile?.governance_mode ?? null,
              guarantees: profile?.guarantees ?? [],
              summary:
                containedRun.status === "publish_conflict"
                  ? "A contained run finished with unpublished changes that were not applied because they would overwrite newer workspace changes."
                  : `A contained run finished, but AgentGit could not publish the projected changes: ${containedRun.publication_error ?? "unknown error"}.`,
              action_title: "Contained publication",
              action_status: containedRun.status,
              changed_paths: containedRun.changed_paths,
              restore_available: true,
              restore_command: buildContainedProjectionRestoreCommand(containedRun.contained_run_id),
              restore_boundary: describeRestoreBoundary({
                type: "contained_projection",
                contained_run_id: containedRun.contained_run_id,
              }),
              restore_guidance: explainRestoreBoundary({
                type: "contained_projection",
                contained_run_id: containedRun.contained_run_id,
              }),
              default_checkpoint_policy: profile?.default_checkpoint_policy ?? null,
              checkpoint_intent: profile?.checkpoint_intent ?? null,
              checkpoint_reason_template: profile?.checkpoint_reason_template ?? null,
              latest_explicit_checkpoint: latestExplicitCheckpoint,
              latest_automatic_checkpoint: latestAutomaticCheckpoint,
              restore_vs_checkpoint: describeRestoreVsCheckpoint(
                { type: "contained_projection", contained_run_id: containedRun.contained_run_id },
                runCheckpoint,
              ),
              degraded_reasons: degradedReasons,
              contained_details: containedDetails,
            };
          }
          if (runCheckpoint) {
            const checkpointSummary = summarizeRunCheckpoint(runCheckpoint);
            return {
              workspace_root: workspaceRoot,
              governed_workspace_root: governedWorkspaceRoot,
              run_id: runId,
              found: true,
              assurance_level: profile?.assurance_level ?? null,
              governance_mode: profile?.governance_mode ?? null,
              guarantees: profile?.guarantees ?? [],
              summary: checkpointSummary.summary,
              action_title: checkpointSummary.action_title,
              action_status: checkpointSummary.action_status,
              changed_paths: [],
              restore_available: true,
              restore_command: buildRestoreCommand({
                type: "run_checkpoint",
                run_checkpoint: runCheckpoint.run_checkpoint,
              }),
              restore_boundary: "checkpoint restore",
              restore_guidance:
                runCheckpoint.trigger === "default_policy"
                  ? "AgentGit can restore back to the automatic checkpoint captured because this run matched the profile checkpoint default."
                  : "AgentGit can restore back to the deliberate checkpoint captured before this run continued.",
              default_checkpoint_policy: profile?.default_checkpoint_policy ?? null,
              checkpoint_intent: profile?.checkpoint_intent ?? null,
              checkpoint_reason_template: profile?.checkpoint_reason_template ?? null,
              latest_explicit_checkpoint: latestExplicitCheckpoint,
              latest_automatic_checkpoint: latestAutomaticCheckpoint,
              restore_vs_checkpoint: restoreVsCheckpoint,
              degraded_reasons: degradedReasons,
              contained_details: containedDetails,
            };
          }
          const runSummary = await client.getRunSummary(runId);
          const fallback = summarizeLatestRunWithoutGovernedStep(profile, runSummary);
          return {
            workspace_root: workspaceRoot,
            governed_workspace_root: governedWorkspaceRoot,
            run_id: runId,
            found: true,
            assurance_level: profile?.assurance_level ?? null,
            governance_mode: profile?.governance_mode ?? null,
            guarantees: profile?.guarantees ?? [],
            summary: fallback.summary,
            action_title: fallback.action_title,
            action_status: fallback.action_status,
            changed_paths: [],
            restore_available: restorePresentation.restore_available,
            restore_command: buildRestoreCommand(restoreTarget),
            restore_boundary: restorePresentation.restore_boundary,
            restore_guidance: restorePresentation.restore_guidance,
            default_checkpoint_policy: profile?.default_checkpoint_policy ?? null,
            checkpoint_intent: profile?.checkpoint_intent ?? null,
            checkpoint_reason_template: profile?.checkpoint_reason_template ?? null,
            latest_explicit_checkpoint: latestExplicitCheckpoint,
            latest_automatic_checkpoint: latestAutomaticCheckpoint,
            restore_vs_checkpoint: restoreVsCheckpoint,
            degraded_reasons: degradedReasons,
            contained_details: containedDetails,
          };
        }

        const changedPaths = shortcut?.display_path ? [shortcut.display_path] : changedPathCandidates(step);
        return {
          workspace_root: workspaceRoot,
          governed_workspace_root: governedWorkspaceRoot,
          run_id: runId,
          found: true,
          assurance_level: profile?.assurance_level ?? null,
          governance_mode: profile?.governance_mode ?? null,
          guarantees: profile?.guarantees ?? [],
          summary: step.summary,
          action_title: step.title,
          action_status: step.status,
          changed_paths: changedPaths,
          restore_available: restorePresentation.restore_available,
          restore_command: buildRestoreCommand(restoreTarget),
          restore_boundary: restorePresentation.restore_boundary,
          restore_guidance: restorePresentation.restore_guidance,
          default_checkpoint_policy: profile?.default_checkpoint_policy ?? null,
          checkpoint_intent: profile?.checkpoint_intent ?? null,
          checkpoint_reason_template: profile?.checkpoint_reason_template ?? null,
          latest_explicit_checkpoint: latestExplicitCheckpoint,
          latest_automatic_checkpoint: latestAutomaticCheckpoint,
          restore_vs_checkpoint: restoreVsCheckpoint,
          degraded_reasons: degradedReasons,
          contained_details: containedDetails,
        };
      },
    );
  }

  async restore(
    workspaceRoot: string,
    options: {
      preview?: boolean;
      force?: boolean;
      path?: string;
      action_id?: string;
      snapshot_id?: string;
      run_checkpoint?: string;
      branch_point?: string;
      contained_run_id?: string;
    } = {},
  ): Promise<ProductRestoreResult> {
    const {
      run_id: runId,
      governed_workspace_root: governedWorkspaceRoot,
      shortcut,
      demo_run: demoRun,
      run_checkpoint: runCheckpoint,
      contained_run: containedRun,
    } = this.resolveRecentRunContext(workspaceRoot);
    if (!governedWorkspaceRoot) {
      throw new AgentGitError("No restorable dangerous action is available yet for this workspace.", "NOT_FOUND", {
        workspace_root: workspaceRoot,
        recommended_command: "agentgit demo",
      });
    }

    let target: ProductRestoreTarget | null = null;
    if (options.path) {
      if (shortcut?.preferred_restore_target.type === "path_subset") {
        target = {
          type: "path_subset",
          snapshot_id: shortcut.preferred_restore_target.snapshot_id,
          paths: [path.resolve(options.path)],
        };
      } else if (demoRun?.restore_boundary_id.startsWith("snap_")) {
        target = {
          type: "path_subset",
          snapshot_id: demoRun.restore_boundary_id,
          paths: [path.resolve(options.path)],
        };
      }
    } else if (options.action_id) {
      target = {
        type: "action_boundary",
        action_id: options.action_id,
      };
    } else if (options.snapshot_id) {
      target = {
        type: "snapshot_id",
        snapshot_id: options.snapshot_id,
      };
    } else if (options.run_checkpoint) {
      target = {
        type: "run_checkpoint",
        run_checkpoint: options.run_checkpoint,
      };
    } else if (options.branch_point) {
      target = {
        type: "branch_point",
        ...parseBranchPointToken(options.branch_point),
      };
    } else if (options.contained_run_id) {
      target = {
        type: "contained_projection",
        contained_run_id: options.contained_run_id,
      };
    }

    if (
      !target &&
      containedRun &&
      (containedRun.status === "publish_conflict" || containedRun.status === "publish_failed")
    ) {
      target = {
        type: "contained_projection",
        contained_run_id: containedRun.contained_run_id,
      };
    }

    if (target && isContainedProjectionTarget(target)) {
      const targetContainedRunId = target.contained_run_id;
      const targetContainedRun =
        containedRun?.contained_run_id === targetContainedRunId
          ? containedRun
          : (this.state
              .listContainedRuns(workspaceRoot)
              .find((entry) => entry.contained_run_id === targetContainedRunId) ?? null);
      if (!targetContainedRun) {
        throw new AgentGitError("AgentGit could not find the contained run projection to discard.", "NOT_FOUND", {
          workspace_root: workspaceRoot,
        });
      }

      const targetSummary = summarizeRestoreTarget(target);
      if (options.preview || !options.force) {
        const previewReason = explainRestorePreview(
          "contained_projection",
          targetContainedRun.conflicting_paths.length > 0,
          true,
        );
        return {
          workspace_root: workspaceRoot,
          governed_workspace_root: workspaceRoot,
          preview_only: true,
          restored: false,
          conflict_detected: targetContainedRun.conflicting_paths.length > 0,
          recovery_class: "contained_projection",
          target,
          target_summary: targetSummary,
          restore_source: "contained projection",
          restore_boundary: describeRestoreBoundary(target),
          restore_guidance: explainRestoreBoundary(target),
          exactness: "exact",
          preview_reason: previewReason,
          deletes_files: false,
          changed_path_count: targetContainedRun.changed_paths.length,
          overlapping_paths: targetContainedRun.conflicting_paths,
          restore_command: `${buildContainedProjectionRestoreCommand(targetContainedRunId)} --force`,
        };
      }

      fs.rmSync(path.dirname(targetContainedRun.projection_root), { recursive: true, force: true });
      const discarded = this.state.saveContainedRun({
        ...targetContainedRun,
        status: "discarded",
      });
      return {
        workspace_root: workspaceRoot,
        governed_workspace_root: workspaceRoot,
        preview_only: false,
        restored: true,
        conflict_detected: discarded.conflicting_paths.length > 0,
        recovery_class: "contained_projection",
        target,
        target_summary: targetSummary,
        restore_source: "contained projection",
        restore_boundary: describeRestoreBoundary(target),
        restore_guidance: explainRestoreBoundary(target),
        exactness: "exact",
        preview_reason: null,
        deletes_files: false,
        changed_path_count: discarded.changed_paths.length,
        overlapping_paths: discarded.conflicting_paths,
        restore_command: buildContainedProjectionRestoreCommand(targetContainedRunId),
      };
    }

    return withAuthoritySession(
      governedWorkspaceRoot,
      this.env,
      this.runtimeRootForWorkspace(governedWorkspaceRoot),
      async ({ client }) => {
        let resolvedDefaultTarget = defaultRestoreTarget(shortcut, demoRun, runCheckpoint);
        if (!target && runId) {
          const timeline = await client.queryTimeline(runId, "user");
          const step = chooseInspectStep(timeline, shortcut?.action_id ?? demoRun?.dangerous_action_id);
          resolvedDefaultTarget ??= deriveRestoreTargetFromStep(step);
        }
        target ??= resolvedDefaultTarget;
        if (!target) {
          throw new AgentGitError("AgentGit could not resolve a safe default restore target.", "NOT_FOUND", {
            workspace_root: workspaceRoot,
            recommended_command: "agentgit inspect",
          });
        }
        if (isContainedProjectionTarget(target)) {
          throw new AgentGitError(
            "Contained projection restores must be handled before recovery planning.",
            "INTERNAL_ERROR",
          );
        }

        const planResult = await client.planRecovery(target);
        const conflictDetected =
          planResult.recovery_plan.impact_preview.later_actions_affected > 0 ||
          planResult.recovery_plan.impact_preview.overlapping_paths.length > 0 ||
          detectPathOverwriteConflict(target);
        const targetSummary = summarizeRestoreTarget(target);
        const restoreSource = `${planResult.recovery_plan.target.type} via ${planResult.recovery_plan.strategy}`;
        const previewOnly =
          Boolean(options.preview) ||
          (conflictDetected && !options.force) ||
          planResult.recovery_plan.recovery_class === "review_only";
        const restoreBoundary = describeRestoreBoundary(target, planResult.recovery_plan.recovery_class);
        const restoreGuidance = explainRestoreBoundary(target, planResult.recovery_plan.recovery_class);
        const previewReason = explainRestorePreview(
          planResult.recovery_plan.recovery_class,
          conflictDetected,
          previewOnly,
        );
        if (previewOnly) {
          return {
            workspace_root: workspaceRoot,
            governed_workspace_root: governedWorkspaceRoot,
            preview_only: true,
            restored: false,
            conflict_detected: conflictDetected,
            recovery_class: planResult.recovery_plan.recovery_class,
            target,
            target_summary: targetSummary,
            restore_source: restoreSource,
            restore_boundary: restoreBoundary,
            restore_guidance: restoreGuidance,
            exactness: planResult.recovery_plan.recovery_class === "review_only" ? "review_only" : "exact",
            preview_reason: previewReason,
            deletes_files: null,
            changed_path_count: planResult.recovery_plan.impact_preview.paths_to_change ?? null,
            overlapping_paths: planResult.recovery_plan.impact_preview.overlapping_paths,
            restore_command:
              conflictDetected && !options.force
                ? `${buildRestoreCommand(target) ?? "agentgit restore"} --force`
                : (buildRestoreCommand(target) ?? "agentgit restore"),
            advanced_command:
              planResult.recovery_plan.recovery_class === "review_only"
                ? "agentgit-authority plan-recovery <target>"
                : undefined,
          };
        }

        if (conflictDetected && !options.force) {
          throw new AgentGitError(
            "Restore would overwrite later changes. Previewed only; rerun with --force to apply it.",
            "CONFLICT",
            {
              overlapping_paths: planResult.recovery_plan.impact_preview.overlapping_paths,
            },
          );
        }

        const executeResult = await client.executeRecovery(target);
        return {
          workspace_root: workspaceRoot,
          governed_workspace_root: governedWorkspaceRoot,
          preview_only: false,
          restored: executeResult.restored,
          conflict_detected: conflictDetected,
          recovery_class: executeResult.recovery_plan.recovery_class,
          target,
          target_summary: targetSummary,
          restore_source: restoreSource,
          restore_boundary: restoreBoundary,
          restore_guidance: restoreGuidance,
          exactness: executeResult.recovery_plan.recovery_class === "review_only" ? "review_only" : "exact",
          preview_reason: null,
          deletes_files: null,
          changed_path_count: executeResult.recovery_plan.impact_preview.paths_to_change ?? null,
          overlapping_paths: executeResult.recovery_plan.impact_preview.overlapping_paths,
          restore_command: buildRestoreCommand(target) ?? "agentgit restore",
          advanced_command:
            executeResult.recovery_plan.recovery_class === "review_only"
              ? "agentgit-authority plan-recovery <target>"
              : undefined,
        };
      },
    );
  }

  private async createRunCheckpoint(
    workspaceRoot: string,
    runId: string,
    client: AuthorityClient,
    options: {
      kind?: RunCheckpointKind;
      reason?: string;
      trigger?: RunCheckpointDocument["trigger"];
      checkpoint_policy?: DefaultCheckpointPolicy;
      checkpoint_intent?: RuntimeProfileDocument["checkpoint_intent"];
    } = {},
  ): Promise<RunCheckpointDocument> {
    const kind = options.kind ?? "branch_point";
    const reason = options.reason ?? "Pre-run checkpoint before agent launch.";
    const trigger = options.trigger ?? "explicit_run_flag";
    const checkpointResult = await client.createRunCheckpoint(
      {
        run_id: runId,
        checkpoint_kind: kind,
        workspace_root: workspaceRoot,
        reason,
      },
      {
        idempotencyKey: `checkpoint:${runId}:${kind}`,
      },
    );

    return this.state.saveRunCheckpoint({
      checkpoint_id: createRunCheckpointId(checkpointResult.run_checkpoint),
      workspace_root: workspaceRoot,
      governed_workspace_root: workspaceRoot,
      run_id: runId,
      run_checkpoint: checkpointResult.run_checkpoint,
      snapshot_id: checkpointResult.snapshot_record.snapshot_id,
      sequence: checkpointResult.branch_point.sequence,
      checkpoint_kind: checkpointResult.checkpoint_kind,
      trigger,
      checkpoint_policy: options.checkpoint_policy,
      checkpoint_intent: options.checkpoint_intent,
      reason,
    });
  }

  async run(
    workspaceRoot: string,
    options: {
      checkpoint?: boolean;
      checkpoint_kind?: RunCheckpointKind;
      checkpoint_reason?: string;
    } = {},
  ): Promise<ProductRunResult> {
    const profile = this.state.getProfileForWorkspace(workspaceRoot);
    if (!profile) {
      throw new AgentGitError(
        "AgentGit has no active runtime profile for this workspace. Run agentgit setup first.",
        "NOT_FOUND",
        {
          workspace_root: workspaceRoot,
          recommended_command: "agentgit setup",
        },
      );
    }

    const current = this.planAndVerifyProfileCurrentState(workspaceRoot, profile);
    if (!current.verify_result.ready) {
      const failingChecks = current.verify_result.health_checks.filter((check) => !check.ok);
      throw new AgentGitError(
        failingChecks[0]?.detail ??
          "AgentGit verified this runtime profile and found that it is not ready to launch safely.",
        "PRECONDITION_FAILED",
        {
          workspace_root: workspaceRoot,
          recommended_command: current.verify_result.recommended_next_command,
          degraded_reasons: current.verify_result.degraded_reasons,
          failing_health_checks: failingChecks.map((check) => ({
            label: check.label,
            detail: check.detail,
          })),
        },
      );
    }
    this.validateContainedRuntimeBindings(workspaceRoot, current.plan);

    const session = await ensureAuthoritySession(workspaceRoot, this.env, this.runtimeRootForWorkspace(workspaceRoot));
    try {
      const registerResult = await session.client.registerRun({
        workflow_name: `${profile.runtime_id}-launch`,
        agent_framework: "product_cli",
        agent_name: profile.runtime_display_name ?? profile.runtime_id,
        workspace_roots: [workspaceRoot],
        client_metadata: {
          runtime_profile_id: profile.profile_id,
          launch_command: profile.launch_command,
        },
      });
      const createExplicitCheckpoint = options.checkpoint;
      const createPolicyCheckpoint =
        !createExplicitCheckpoint && shouldCreateDefaultCheckpoint(profile, current.verify_result.degraded_reasons);
      const checkpointRecord =
        createExplicitCheckpoint || createPolicyCheckpoint
          ? await this.createRunCheckpoint(workspaceRoot, registerResult.run_id, session.client, {
              kind: createExplicitCheckpoint ? (options.checkpoint_kind ?? "branch_point") : "branch_point",
              reason: createExplicitCheckpoint
                ? (options.checkpoint_reason ?? "Pre-run checkpoint before agent launch.")
                : checkpointReasonFromProfile(
                    profile,
                    profile.default_checkpoint_policy === "always_before_run"
                      ? "Automatic pre-run checkpoint created by the runtime profile default."
                      : "Automatic pre-run checkpoint created because this run matched the risky-run checkpoint default.",
                  ),
              trigger: createExplicitCheckpoint ? "explicit_run_flag" : "default_policy",
              checkpoint_policy: createPolicyCheckpoint ? profile.default_checkpoint_policy : undefined,
              checkpoint_intent: createPolicyCheckpoint ? profile.checkpoint_intent : undefined,
            })
          : null;
      if (profile.execution_mode === "docker_contained") {
        const containedResult = await this.runDockerContainedProfile(
          workspaceRoot,
          profile,
          session,
          registerResult.run_id,
        );
        this.state.saveRuntimeProfile({
          ...profile,
          last_run_id: registerResult.run_id,
        });
        return {
          ...containedResult,
          run_checkpoint: checkpointRecord?.run_checkpoint,
          checkpoint_kind: checkpointRecord?.checkpoint_kind,
          checkpoint_trigger: checkpointRecord?.trigger,
          checkpoint_reason: checkpointRecord?.reason,
          checkpoint_restore_command: checkpointRecord
            ? (buildRestoreCommand({
                type: "run_checkpoint",
                run_checkpoint: checkpointRecord.run_checkpoint,
              }) ?? undefined)
            : undefined,
        };
      }

      const shimBinDir = governedShimBinDirFromProfile(profile);
      const parsedLaunch = parseLaunchCommand(profile.launch_command);
      const resolvedLaunchCommand = resolveLaunchExecutable(parsedLaunch.command, workspaceRoot, this.env.PATH);
      const socketAuthTokenPath = resolveSocketAuthTokenPath(session.daemon_config.socketPath);
      const socketAuthToken = fs.existsSync(socketAuthTokenPath)
        ? fs.readFileSync(socketAuthTokenPath, "utf8").trim()
        : "";
      const childEnv: NodeJS.ProcessEnv = {
        ...this.env,
        AGENTGIT_ROOT: workspaceRoot,
        AGENTGIT_SOCKET_PATH: session.daemon_config.socketPath,
        ...(socketAuthToken.length > 0 ? { AGENTGIT_SOCKET_AUTH_TOKEN: socketAuthToken } : {}),
        AGENTGIT_SESSION_ID: session.session_id,
        AGENTGIT_RUN_ID: registerResult.run_id,
        AGENTGIT_RUNTIME_PROFILE_ID: profile.profile_id,
        AGENTGIT_RUNTIME_ID: profile.runtime_id,
        ...(shimBinDir ? { PATH: prependPathEntry(this.env.PATH, shimBinDir) } : {}),
      };
      const child = this.spawnProcess(resolvedLaunchCommand, parsedLaunch.args, {
        // Launch the configured runtime command directly; only its subprocesses should hit the governed shim PATH.
        cwd: workspaceRoot,
        env: childEnv,
        stdio: "inherit",
      });

      let forwardedSignal: NodeJS.Signals | undefined;
      const forwardSignal = (signal: NodeJS.Signals) => {
        forwardedSignal = signal;
        child.kill(signal);
      };
      const signalHandlers: Array<{ signal: NodeJS.Signals; handler: () => void }> = [
        { signal: "SIGINT", handler: () => forwardSignal("SIGINT") },
        { signal: "SIGTERM", handler: () => forwardSignal("SIGTERM") },
      ];
      const detachSignalHandlers = () => {
        for (const entry of signalHandlers) {
          process.off(entry.signal, entry.handler);
        }
      };
      for (const entry of signalHandlers) {
        process.on(entry.signal, entry.handler);
      }

      try {
        const result = await new Promise<ProductRunResult>((resolve, reject) => {
          child.once("error", (error) => {
            reject(
              new AgentGitError("Agent process failed to start.", "CAPABILITY_UNAVAILABLE", {
                cause: error.message,
                launch_command: profile.launch_command,
              }),
            );
          });
          child.once("close", (code, signal) => {
            resolve({
              workspace_root: workspaceRoot,
              runtime: profile.runtime_display_name ?? profile.runtime_id,
              run_id: registerResult.run_id,
              exit_code: code ?? (signal ? 1 : 0),
              signal: signal ?? forwardedSignal,
              daemon_started: session.daemon_started,
              run_checkpoint: checkpointRecord?.run_checkpoint,
              checkpoint_kind: checkpointRecord?.checkpoint_kind,
              checkpoint_trigger: checkpointRecord?.trigger,
              checkpoint_reason: checkpointRecord?.reason,
              checkpoint_restore_command: checkpointRecord
                ? (buildRestoreCommand({
                    type: "run_checkpoint",
                    run_checkpoint: checkpointRecord.run_checkpoint,
                  }) ?? undefined)
                : undefined,
            });
          });
        });
        this.state.saveRuntimeProfile({
          ...profile,
          last_run_id: registerResult.run_id,
        });
        return result;
      } finally {
        await terminateChildProcessIfNeeded(child);
        detachSignalHandlers();
      }
    } finally {
      if (session.daemon) {
        await session.daemon.shutdown();
      }
      session.runtime_lock_release?.();
    }
  }
}
