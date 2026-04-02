import {
  AgentGitError,
  type ErrorEnvelope,
  type ExecutionResult,
  type HostedMcpExecutionJobError,
  type HostedMcpExecutionJobRecord,
} from "@agentgit/schemas";
import type { McpServerRegistry } from "@agentgit/mcp-registry";

interface HostedExecutionQueueOptions {
  registry: McpServerRegistry;
  instanceId: string;
  heartbeatIntervalMs?: number;
  staleHeartbeatMs?: number;
  onTerminalFailure?: (job: HostedMcpExecutionJobRecord, error: HostedMcpExecutionJobError) => void;
  processor: (
    job: HostedMcpExecutionJobRecord,
    signalHeartbeat: () => void,
    cancelSignal: AbortSignal,
  ) => Promise<ExecutionResult>;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 250;
const DEFAULT_STALE_HEARTBEAT_MS = 2_000;
const RETRYABLE_WORKER_CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOENT",
  "EPIPE",
  "ETIMEDOUT",
]);

function isTerminalStatus(status: HostedMcpExecutionJobRecord["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

function toJobError(error: unknown): HostedMcpExecutionJobError {
  if (error instanceof AgentGitError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    };
  }

  const errorCode =
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : null;
  if (errorCode && RETRYABLE_WORKER_CONNECTION_ERROR_CODES.has(errorCode)) {
    return {
      code: "CAPABILITY_UNAVAILABLE",
      message: error instanceof Error ? error.message : `Hosted worker connection failed with ${errorCode}.`,
      retryable: true,
      details: {
        cause_code: errorCode,
      },
    };
  }

  if (
    error instanceof Error &&
    error.message.includes("Hosted MCP worker connection closed before a response was received.")
  ) {
    return {
      code: "CAPABILITY_UNAVAILABLE",
      message: error.message,
      retryable: true,
    };
  }

  return {
    code: "INTERNAL_ERROR",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

function shouldRetryJob(error: HostedMcpExecutionJobError): boolean {
  if (error.retryable) {
    return true;
  }

  return (
    error.code === "CAPABILITY_UNAVAILABLE" ||
    error.code === "TIMEOUT" ||
    error.code === "UPSTREAM_FAILURE" ||
    error.code === "STORAGE_UNAVAILABLE" ||
    error.code === "BROKER_UNAVAILABLE"
  );
}

function isRetryableFailureClass(error: HostedMcpExecutionJobError | null | undefined): boolean {
  if (!error) {
    return false;
  }

  return shouldRetryJob({
    ...error,
    retryable: error.retryable,
  });
}

function nextRetryAt(attemptCount: number): string {
  const delayMs = Math.min(2_000, 200 * 2 ** Math.max(0, attemptCount - 1));
  return new Date(Date.now() + delayMs).toISOString();
}

function normalizeJobErrorCode(code: HostedMcpExecutionJobError["code"]): ErrorEnvelope["code"] {
  switch (code) {
    case "BAD_REQUEST":
    case "VALIDATION_FAILED":
    case "NOT_FOUND":
    case "CONFLICT":
    case "TIMEOUT":
    case "PRECONDITION_FAILED":
    case "POLICY_BLOCKED":
    case "UPSTREAM_FAILURE":
    case "CAPABILITY_UNAVAILABLE":
    case "STORAGE_UNAVAILABLE":
    case "BROKER_UNAVAILABLE":
    case "INTERNAL_ERROR":
      return code;
    default:
      return "INTERNAL_ERROR";
  }
}

function queueClosedError(jobId: string): AgentGitError {
  return new AgentGitError(
    "Hosted MCP execution queue closed before the job reached a terminal state.",
    "CAPABILITY_UNAVAILABLE",
    {
      job_id: jobId,
      queue_closed: true,
    },
    true,
  );
}

export class HostedExecutionQueue {
  private readonly registry: McpServerRegistry;
  private readonly instanceId: string;
  private readonly heartbeatIntervalMs: number;
  private readonly staleHeartbeatMs: number;
  private readonly onTerminalFailure?: HostedExecutionQueueOptions["onTerminalFailure"];
  private readonly processor: HostedExecutionQueueOptions["processor"];
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly activeCancelControllers = new Map<string, AbortController>();
  private nextWakeTimer: NodeJS.Timeout | null = null;
  private running = false;
  private wakeRequested = false;
  private closed = false;

  constructor(options: HostedExecutionQueueOptions) {
    this.registry = options.registry;
    this.instanceId = options.instanceId;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.staleHeartbeatMs = options.staleHeartbeatMs ?? DEFAULT_STALE_HEARTBEAT_MS;
    this.onTerminalFailure = options.onTerminalFailure;
    this.processor = options.processor;
  }

  start(): void {
    this.recoverStaleJobs();
    this.poke();
  }

  close(): void {
    this.closed = true;
    if (this.nextWakeTimer) {
      clearTimeout(this.nextWakeTimer);
      this.nextWakeTimer = null;
    }
    for (const controller of this.activeCancelControllers.values()) {
      controller.abort();
    }
    this.notifyAll();
  }

  counts(): {
    queued: number;
    running: number;
    succeeded: number;
    failed: number;
  } {
    const records = this.registry.listHostedExecutionJobs();
    return {
      queued: records.filter((record) => record.status === "queued").length,
      running: records.filter((record) => record.status === "running").length,
      succeeded: records.filter((record) => record.status === "succeeded").length,
      failed: records.filter((record) => record.status === "failed").length,
    };
  }

  diagnostics(): {
    queued_jobs: number;
    running_jobs: number;
    cancel_requested_jobs: number;
    succeeded_jobs: number;
    failed_jobs: number;
    canceled_jobs: number;
    retryable_failed_jobs: number;
    dead_letter_retryable_jobs: number;
    dead_letter_non_retryable_jobs: number;
    oldest_queued_at: string | null;
    oldest_failed_at: string | null;
    active_server_profiles: string[];
  } {
    const records = this.registry.listHostedExecutionJobs();
    const queuedJobs = records.filter((record) => record.status === "queued");
    const runningJobs = records.filter((record) => record.status === "running");
    const cancelRequestedJobs = records.filter((record) => record.status === "cancel_requested");
    const failedJobs = records.filter((record) => record.status === "failed");
    const canceledJobs = records.filter((record) => record.status === "canceled");
    const deadLetterRetryableJobs = failedJobs.filter((record) => isRetryableFailureClass(record.last_error));

    return {
      queued_jobs: queuedJobs.length,
      running_jobs: runningJobs.length,
      cancel_requested_jobs: cancelRequestedJobs.length,
      succeeded_jobs: records.filter((record) => record.status === "succeeded").length,
      failed_jobs: failedJobs.length,
      canceled_jobs: canceledJobs.length,
      retryable_failed_jobs: failedJobs.filter((record) => isRetryableFailureClass(record.last_error)).length,
      dead_letter_retryable_jobs: deadLetterRetryableJobs.length,
      dead_letter_non_retryable_jobs: failedJobs.length - deadLetterRetryableJobs.length,
      oldest_queued_at:
        queuedJobs.map((record) => record.created_at).sort((left, right) => left.localeCompare(right))[0] ?? null,
      oldest_failed_at:
        failedJobs
          .map((record) => record.completed_at ?? record.updated_at)
          .sort((left, right) => left.localeCompare(right))[0] ?? null,
      active_server_profiles: [
        ...new Set([...queuedJobs, ...runningJobs, ...cancelRequestedJobs].map((record) => record.server_profile_id)),
      ].sort(),
    };
  }

  summarizeJobs(jobs: HostedMcpExecutionJobRecord[]): {
    queued: number;
    running: number;
    cancel_requested: number;
    succeeded: number;
    failed: number;
    canceled: number;
    dead_letter_retryable: number;
    dead_letter_non_retryable: number;
  } {
    const failedJobs = jobs.filter((job) => job.status === "failed");
    const deadLetterRetryable = failedJobs.filter((job) => isRetryableFailureClass(job.last_error)).length;
    return {
      queued: jobs.filter((job) => job.status === "queued").length,
      running: jobs.filter((job) => job.status === "running").length,
      cancel_requested: jobs.filter((job) => job.status === "cancel_requested").length,
      succeeded: jobs.filter((job) => job.status === "succeeded").length,
      failed: failedJobs.length,
      canceled: jobs.filter((job) => job.status === "canceled").length,
      dead_letter_retryable: deadLetterRetryable,
      dead_letter_non_retryable: failedJobs.length - deadLetterRetryable,
    };
  }

  requeueFailedJobWithOptions(params: { job_id: string; reset_attempt_count?: boolean; max_attempts?: number }): {
    job: HostedMcpExecutionJobRecord;
    requeued: boolean;
    previous_status: HostedMcpExecutionJobRecord["status"];
    attempt_count_reset: boolean;
    max_attempts_updated: boolean;
  } {
    const job = this.registry.getHostedExecutionJob(params.job_id);
    if (!job) {
      throw new AgentGitError("Hosted MCP execution job was not found.", "NOT_FOUND", {
        job_id: params.job_id,
      });
    }

    if (job.status !== "failed") {
      throw new AgentGitError("Only failed hosted MCP execution jobs can be requeued.", "PRECONDITION_FAILED", {
        job_id: params.job_id,
        status: job.status,
      });
    }

    const resetAttemptCount = params.reset_attempt_count ?? false;
    const nextAttemptCount = resetAttemptCount ? 0 : job.attempt_count;
    const nextMaxAttempts = params.max_attempts ?? job.max_attempts;
    if (!resetAttemptCount && nextMaxAttempts < job.attempt_count) {
      throw new AgentGitError(
        "max_attempts cannot be set below the current attempt_count unless reset_attempt_count is true.",
        "PRECONDITION_FAILED",
        {
          job_id: params.job_id,
          attempt_count: job.attempt_count,
          max_attempts: nextMaxAttempts,
        },
      );
    }

    const updatedAt = new Date().toISOString();
    const requeuedJob: HostedMcpExecutionJobRecord = {
      ...job,
      status: "queued",
      attempt_count: nextAttemptCount,
      max_attempts: nextMaxAttempts,
      current_lease_id: null,
      claimed_by: null,
      claimed_at: null,
      last_heartbeat_at: null,
      cancel_requested_at: null,
      cancel_requested_by_session_id: null,
      cancel_reason: null,
      canceled_at: null,
      next_attempt_at: updatedAt,
      updated_at: updatedAt,
      completed_at: null,
      last_error: null,
      execution_result: null,
    };
    this.registry.upsertHostedExecutionJob(requeuedJob);
    this.notify(params.job_id);
    this.poke();
    return {
      job: requeuedJob,
      requeued: true,
      previous_status: job.status,
      attempt_count_reset: resetAttemptCount,
      max_attempts_updated: nextMaxAttempts !== job.max_attempts,
    };
  }

  requeueFailedJob(jobId: string): {
    job: HostedMcpExecutionJobRecord;
    requeued: boolean;
    previous_status: HostedMcpExecutionJobRecord["status"];
    attempt_count_reset: boolean;
    max_attempts_updated: boolean;
  } {
    return this.requeueFailedJobWithOptions({
      job_id: jobId,
    });
  }

  inspectJob(jobId: string): HostedMcpExecutionJobRecord | null {
    return this.registry.getHostedExecutionJob(jobId);
  }

  cancelJob(params: { job_id: string; requested_by_session_id?: string | null; reason?: string | null }): {
    job: HostedMcpExecutionJobRecord;
    cancellation_requested: boolean;
    previous_status: HostedMcpExecutionJobRecord["status"];
    terminal: boolean;
  } {
    const job = this.registry.getHostedExecutionJob(params.job_id);
    if (!job) {
      throw new AgentGitError("Hosted MCP execution job was not found.", "NOT_FOUND", {
        job_id: params.job_id,
      });
    }

    const now = new Date().toISOString();
    const baseUpdate = {
      cancel_requested_at: job.cancel_requested_at ?? now,
      cancel_requested_by_session_id: params.requested_by_session_id ?? job.cancel_requested_by_session_id ?? null,
      cancel_reason: params.reason ?? job.cancel_reason ?? null,
      updated_at: now,
    };

    if (job.status === "queued") {
      const canceledJob: HostedMcpExecutionJobRecord = {
        ...job,
        ...baseUpdate,
        status: "canceled",
        canceled_at: now,
        completed_at: now,
        claimed_by: null,
        claimed_at: null,
        current_lease_id: null,
        last_heartbeat_at: now,
        last_error: {
          code: "CONFLICT",
          message: "Hosted MCP execution job was canceled before dispatch.",
          retryable: false,
          ...(params.reason ? { details: { reason: params.reason } } : {}),
        },
      };
      this.registry.upsertHostedExecutionJob(canceledJob);
      this.notify(job.job_id);
      return {
        job: canceledJob,
        cancellation_requested: true,
        previous_status: job.status,
        terminal: true,
      };
    }

    if (job.status === "running" || job.status === "cancel_requested") {
      const cancelRequestedJob: HostedMcpExecutionJobRecord = {
        ...job,
        ...baseUpdate,
        status: "cancel_requested",
      };
      this.registry.upsertHostedExecutionJob(cancelRequestedJob);
      this.activeCancelControllers.get(job.job_id)?.abort(
        new AgentGitError("Hosted MCP execution job was canceled by the operator.", "CONFLICT", {
          job_id: job.job_id,
          ...(params.reason ? { reason: params.reason } : {}),
        }),
      );
      this.notify(job.job_id);
      return {
        job: cancelRequestedJob,
        cancellation_requested: true,
        previous_status: job.status,
        terminal: false,
      };
    }

    return {
      job,
      cancellation_requested: false,
      previous_status: job.status,
      terminal: isTerminalStatus(job.status),
    };
  }

  terminalFailureClassification(job: HostedMcpExecutionJobRecord): "retryable_exhausted" | "non_retryable" | null {
    if (job.status !== "failed") {
      return null;
    }
    return isRetryableFailureClass(job.last_error) ? "retryable_exhausted" : "non_retryable";
  }

  lifecycle(job: HostedMcpExecutionJobRecord): {
    state:
      | "queued"
      | "running"
      | "cancel_requested"
      | "succeeded"
      | "dead_letter_retryable"
      | "dead_letter_non_retryable"
      | "canceled";
    dead_lettered: boolean;
    eligible_for_requeue: boolean;
    retry_budget_remaining: number;
  } {
    const retryBudgetRemaining = Math.max(0, job.max_attempts - job.attempt_count);
    if (
      job.status === "queued" ||
      job.status === "running" ||
      job.status === "cancel_requested" ||
      job.status === "succeeded"
    ) {
      return {
        state: job.status,
        dead_lettered: false,
        eligible_for_requeue: false,
        retry_budget_remaining: retryBudgetRemaining,
      };
    }

    if (job.status === "canceled") {
      return {
        state: "canceled",
        dead_lettered: false,
        eligible_for_requeue: false,
        retry_budget_remaining: retryBudgetRemaining,
      };
    }

    return {
      state: isRetryableFailureClass(job.last_error) ? "dead_letter_retryable" : "dead_letter_non_retryable",
      dead_lettered: true,
      eligible_for_requeue: true,
      retry_budget_remaining: retryBudgetRemaining,
    };
  }

  async submitAndWait(job: HostedMcpExecutionJobRecord): Promise<ExecutionResult> {
    const now = new Date().toISOString();
    const existing = this.registry.getHostedExecutionJob(job.job_id);
    const normalizedJob: HostedMcpExecutionJobRecord = {
      ...job,
      status: existing?.status ?? "queued",
      attempt_count: existing?.attempt_count ?? 0,
      current_lease_id: existing?.current_lease_id ?? null,
      claimed_by: existing?.claimed_by ?? null,
      claimed_at: existing?.claimed_at ?? null,
      last_heartbeat_at: existing?.last_heartbeat_at ?? null,
      cancel_requested_at: existing?.cancel_requested_at ?? null,
      cancel_requested_by_session_id: existing?.cancel_requested_by_session_id ?? null,
      cancel_reason: existing?.cancel_reason ?? null,
      canceled_at: existing?.canceled_at ?? null,
      next_attempt_at: existing?.next_attempt_at ?? now,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      completed_at: existing?.completed_at ?? null,
      last_error: existing?.last_error ?? null,
      execution_result: existing?.execution_result ?? null,
    };
    this.registry.upsertHostedExecutionJob(normalizedJob);
    this.notify(job.job_id);
    this.poke();
    return this.waitForTerminal(job.job_id);
  }

  private waitForTerminal(jobId: string): Promise<ExecutionResult> {
    const current = this.registry.getHostedExecutionJob(jobId);
    if (current && isTerminalStatus(current.status)) {
      return this.resolveTerminalJob(current);
    }
    if (this.closed) {
      return Promise.reject(queueClosedError(jobId));
    }

    return new Promise<ExecutionResult>((resolve, reject) => {
      const listener = () => {
        try {
          if (this.closed) {
            this.removeWaiter(jobId, listener);
            reject(queueClosedError(jobId));
            return;
          }
          const refreshed = this.registry.getHostedExecutionJob(jobId);
          if (!refreshed || !isTerminalStatus(refreshed.status)) {
            return;
          }
          this.removeWaiter(jobId, listener);
          this.resolveTerminalJob(refreshed).then(resolve, reject);
        } catch (error) {
          this.removeWaiter(jobId, listener);
          reject(error);
        }
      };

      const listeners = this.waiters.get(jobId) ?? new Set<() => void>();
      listeners.add(listener);
      this.waiters.set(jobId, listeners);
    });
  }

  private async resolveTerminalJob(job: HostedMcpExecutionJobRecord): Promise<ExecutionResult> {
    if (job.execution_result) {
      return job.execution_result;
    }

    const terminalError = job.last_error ?? {
      code: "INTERNAL_ERROR",
      message: "Hosted execution job reached a terminal state without a recorded execution result.",
      retryable: false,
    };
    throw new AgentGitError(
      terminalError.message,
      normalizeJobErrorCode(terminalError.code),
      terminalError.details,
      terminalError.retryable,
    );
  }

  private poke(): void {
    if (this.closed) {
      return;
    }
    if (this.nextWakeTimer) {
      clearTimeout(this.nextWakeTimer);
      this.nextWakeTimer = null;
    }
    this.wakeRequested = true;
    if (!this.running) {
      void this.processLoop();
    }
  }

  private async processLoop(): Promise<void> {
    if (this.running || this.closed) {
      return;
    }

    this.running = true;
    try {
      while (!this.closed) {
        this.wakeRequested = false;
        const claimed = this.claimNextJob();
        if (!claimed) {
          this.scheduleNextWake();
          break;
        }
        await this.processClaimedJob(claimed);
      }
    } finally {
      this.running = false;
      if (this.wakeRequested && !this.closed) {
        void this.processLoop();
      }
    }
  }

  private claimNextJob(): HostedMcpExecutionJobRecord | null {
    const nowMs = Date.now();
    const candidate =
      this.registry
        .listHostedExecutionJobs()
        .filter((record) => record.status === "queued")
        .filter((record) => Date.parse(record.next_attempt_at) <= nowMs)
        .sort((left, right) => {
          const leftTime = Date.parse(left.next_attempt_at);
          const rightTime = Date.parse(right.next_attempt_at);
          if (leftTime !== rightTime) {
            return leftTime - rightTime;
          }
          return left.created_at.localeCompare(right.created_at);
        })[0] ?? null;

    if (!candidate) {
      return null;
    }

    const claimedAt = new Date().toISOString();
    const claimed: HostedMcpExecutionJobRecord = {
      ...candidate,
      status: "running",
      attempt_count: candidate.attempt_count + 1,
      claimed_by: this.instanceId,
      claimed_at: claimedAt,
      last_heartbeat_at: claimedAt,
      cancel_requested_at: candidate.cancel_requested_at ?? null,
      cancel_requested_by_session_id: candidate.cancel_requested_by_session_id ?? null,
      cancel_reason: candidate.cancel_reason ?? null,
      canceled_at: candidate.canceled_at ?? null,
      updated_at: claimedAt,
      completed_at: null,
    };
    this.registry.upsertHostedExecutionJob(claimed);
    this.notify(claimed.job_id);
    return claimed;
  }

  private async processClaimedJob(job: HostedMcpExecutionJobRecord): Promise<void> {
    let heartbeatTimer: NodeJS.Timeout | null = null;
    const cancelController = new AbortController();
    this.activeCancelControllers.set(job.job_id, cancelController);

    const signalHeartbeat = () => {
      if (this.closed) {
        return;
      }

      let current: HostedMcpExecutionJobRecord | null = null;
      try {
        current = this.registry.getHostedExecutionJob(job.job_id);
      } catch (error) {
        if (this.closed || (error instanceof AgentGitError && error.code === "STORAGE_UNAVAILABLE")) {
          return;
        }
        throw error;
      }
      if (!current || (current.status !== "running" && current.status !== "cancel_requested")) {
        return;
      }
      try {
        this.registry.upsertHostedExecutionJob({
          ...current,
          last_heartbeat_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      } catch (error) {
        if (this.closed || (error instanceof AgentGitError && error.code === "STORAGE_UNAVAILABLE")) {
          return;
        }
        throw error;
      }
      this.notify(job.job_id);
    };

    heartbeatTimer = setInterval(signalHeartbeat, this.heartbeatIntervalMs);
    heartbeatTimer.unref?.();

    try {
      const executionResult = await this.processor(job, signalHeartbeat, cancelController.signal);
      const current = this.registry.getHostedExecutionJob(job.job_id);
      if (!current) {
        return;
      }
      if (current.status === "cancel_requested") {
        const canceledAt = new Date().toISOString();
        this.registry.upsertHostedExecutionJob({
          ...current,
          status: "canceled",
          canceled_at: current.canceled_at ?? canceledAt,
          completed_at: canceledAt,
          updated_at: canceledAt,
          claimed_by: null,
          claimed_at: null,
          current_lease_id: null,
          last_heartbeat_at: canceledAt,
          execution_result: null,
          last_error: {
            code: "CONFLICT",
            message: "Hosted MCP execution job was canceled before the worker result was committed.",
            retryable: false,
            ...(current.cancel_reason ? { details: { reason: current.cancel_reason } } : {}),
          },
        });
        this.notify(job.job_id);
        return;
      }
      this.registry.upsertHostedExecutionJob({
        ...current,
        status: "succeeded",
        execution_result: executionResult,
        completed_at: executionResult.completed_at,
        updated_at: executionResult.completed_at,
        claimed_by: null,
        claimed_at: null,
        last_heartbeat_at: executionResult.completed_at,
        last_error: null,
        canceled_at: null,
      });
      this.notify(job.job_id);
    } catch (error) {
      const current = this.registry.getHostedExecutionJob(job.job_id) ?? job;
      const cancellationRequested = current.status === "cancel_requested" || current.cancel_requested_at !== null;
      if (cancellationRequested) {
        const canceledAt = new Date().toISOString();
        this.registry.upsertHostedExecutionJob({
          ...current,
          status: "canceled",
          current_lease_id: null,
          claimed_by: null,
          claimed_at: null,
          last_heartbeat_at: canceledAt,
          updated_at: canceledAt,
          completed_at: canceledAt,
          canceled_at: current.canceled_at ?? canceledAt,
          execution_result: null,
          last_error: {
            code: "CONFLICT",
            message: "Hosted MCP execution job was canceled during execution.",
            retryable: false,
            details:
              current.cancel_reason || error instanceof Error
                ? {
                    ...(current.cancel_reason ? { reason: current.cancel_reason } : {}),
                    ...(error instanceof Error ? { cause: error.message } : {}),
                  }
                : undefined,
          },
        });
        this.notify(job.job_id);
        return;
      }
      const jobError = toJobError(error);
      const retryable = shouldRetryJob(jobError) && current.attempt_count < current.max_attempts;
      const updatedAt = new Date().toISOString();
      this.registry.upsertHostedExecutionJob({
        ...current,
        status: retryable ? "queued" : "failed",
        next_attempt_at: retryable ? nextRetryAt(current.attempt_count) : current.next_attempt_at,
        updated_at: updatedAt,
        completed_at: retryable ? null : updatedAt,
        claimed_by: null,
        claimed_at: null,
        last_heartbeat_at: updatedAt,
        current_lease_id: null,
        last_error: {
          ...jobError,
          retryable,
        },
      });
      this.notify(job.job_id);
      if (!retryable) {
        this.onTerminalFailure?.(
          {
            ...current,
            status: "failed",
            updated_at: updatedAt,
            completed_at: updatedAt,
            claimed_by: null,
            claimed_at: null,
            last_heartbeat_at: updatedAt,
            last_error: {
              ...jobError,
              retryable,
            },
          },
          {
            ...jobError,
            retryable,
          },
        );
      }
      if (retryable) {
        this.poke();
      }
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
      this.activeCancelControllers.delete(job.job_id);
    }
  }

  private recoverStaleJobs(): void {
    const nowMs = Date.now();
    for (const job of this.registry.listHostedExecutionJobs()) {
      if (job.status !== "running") {
        continue;
      }

      const heartbeatAt = Date.parse(job.last_heartbeat_at ?? job.claimed_at ?? job.updated_at);
      if (!Number.isNaN(heartbeatAt) && nowMs - heartbeatAt <= this.staleHeartbeatMs) {
        continue;
      }

      const retryable = job.attempt_count < job.max_attempts;
      const updatedAt = new Date().toISOString();
      this.registry.upsertHostedExecutionJob({
        ...job,
        status: retryable ? "queued" : "failed",
        next_attempt_at: retryable ? updatedAt : job.next_attempt_at,
        updated_at: updatedAt,
        completed_at: retryable ? null : updatedAt,
        claimed_by: null,
        claimed_at: null,
        last_heartbeat_at: updatedAt,
        current_lease_id: null,
        last_error: retryable
          ? {
              code: "CAPABILITY_UNAVAILABLE",
              message:
                "Hosted execution job was re-queued after daemon restart interrupted an in-flight worker attempt.",
              retryable: true,
            }
          : job.last_error,
      });
      if (!retryable) {
        this.onTerminalFailure?.(
          {
            ...job,
            status: "failed",
            updated_at: updatedAt,
            completed_at: updatedAt,
            claimed_by: null,
            claimed_at: null,
            last_heartbeat_at: updatedAt,
            last_error: job.last_error,
          },
          job.last_error ?? {
            code: "INTERNAL_ERROR",
            message: "Hosted execution job dead-lettered during recovery without a recorded terminal error.",
            retryable: false,
          },
        );
      }
    }
  }

  private scheduleNextWake(): void {
    if (this.closed || this.nextWakeTimer) {
      return;
    }

    const nowMs = Date.now();
    const nextAttemptMs = this.registry
      .listHostedExecutionJobs()
      .filter((record) => record.status === "queued")
      .map((record) => Date.parse(record.next_attempt_at))
      .filter((attemptAt) => !Number.isNaN(attemptAt))
      .sort((left, right) => left - right)[0];

    if (nextAttemptMs === undefined) {
      return;
    }

    const delayMs = Math.max(0, nextAttemptMs - nowMs);
    this.nextWakeTimer = setTimeout(() => {
      this.nextWakeTimer = null;
      this.poke();
    }, delayMs);
    this.nextWakeTimer.unref?.();
  }

  private notify(jobId: string): void {
    const listeners = this.waiters.get(jobId);
    if (!listeners) {
      return;
    }

    for (const listener of [...listeners]) {
      listener();
    }
  }

  private notifyAll(): void {
    for (const jobId of [...this.waiters.keys()]) {
      this.notify(jobId);
    }
  }

  private removeWaiter(jobId: string, listener: () => void): void {
    const listeners = this.waiters.get(jobId);
    if (!listeners) {
      return;
    }
    listeners.delete(listener);
    if (listeners.size === 0) {
      this.waiters.delete(jobId);
    }
  }
}
