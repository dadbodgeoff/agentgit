import type { CachedCapabilityState } from "@agentgit/recovery-engine";
import type { RunJournal } from "@agentgit/run-journal";
import {
  type GetCapabilitiesResponsePayload,
  InternalError,
  type ReasonDetail,
} from "@agentgit/schemas";

const CAPABILITY_REFRESH_STALE_MS = 5 * 60 * 1_000;

export function resolveCapabilityRefreshStaleMs(options?: { capabilityRefreshStaleMs?: number | null }): number {
  if (typeof options?.capabilityRefreshStaleMs === "number") {
    return Math.max(0, options.capabilityRefreshStaleMs);
  }

  const configured = process.env.AGENTGIT_CAPABILITY_REFRESH_STALE_MS?.trim();
  if (!configured) {
    return CAPABILITY_REFRESH_STALE_MS;
  }

  const parsed = Number.parseInt(configured, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new InternalError("Capability refresh stale threshold must be a non-negative integer.", {
      configured_value: configured,
      env_var: "AGENTGIT_CAPABILITY_REFRESH_STALE_MS",
    });
  }

  return parsed;
}

export function buildCachedCapabilityState(
  journal: RunJournal,
  runtimeOptions: { capabilityRefreshStaleMs?: number | null },
): CachedCapabilityState | null {
  const capabilitySnapshot = journal.getCapabilitySnapshot();
  if (capabilitySnapshot === null) {
    return null;
  }

  const capabilityRefreshStaleMs = resolveCapabilityRefreshStaleMs(runtimeOptions);
  const refreshedAtMillis = Date.parse(capabilitySnapshot.refreshed_at);

  return {
    capabilities: capabilitySnapshot.capabilities,
    degraded_mode_warnings: capabilitySnapshot.degraded_mode_warnings,
    refreshed_at: capabilitySnapshot.refreshed_at,
    stale_after_ms: capabilityRefreshStaleMs,
    is_stale: !Number.isNaN(refreshedAtMillis) && Date.now() - refreshedAtMillis > capabilityRefreshStaleMs,
  };
}

function capabilityReasonForRecord(capability: GetCapabilitiesResponsePayload["capabilities"][number]): ReasonDetail {
  switch (capability.capability_name) {
    case "workspace.root_access":
      return {
        code:
          capability.status === "unavailable" ? "WORKSPACE_CAPABILITY_UNAVAILABLE" : "WORKSPACE_CAPABILITY_DEGRADED",
        message: `Cached workspace access capability is ${capability.status}; governed workspace guarantees are not currently trustworthy.`,
      };
    case "host.runtime_storage":
      return {
        code:
          capability.status === "unavailable"
            ? "RUNTIME_STORAGE_CAPABILITY_UNAVAILABLE"
            : "RUNTIME_STORAGE_CAPABILITY_DEGRADED",
        message: `Cached runtime storage capability is ${capability.status}; durable snapshot and artifact guarantees are weakened.`,
      };
    case "adapter.tickets_brokered_credentials":
      return {
        code: capability.status === "unavailable" ? "BROKERED_CAPABILITY_UNAVAILABLE" : "BROKERED_CAPABILITY_DEGRADED",
        message: `Cached ticket broker capability is ${capability.status}; trusted brokered ticket execution is not currently available.`,
      };
    case "host.credential_broker_mode":
      return {
        code: "CREDENTIAL_BROKER_MODE_DEGRADED",
        message:
          "Credential brokering is operating in a degraded mode, so durable secure-store guarantees are reduced.",
      };
    default:
      return {
        code: capability.status === "unavailable" ? "CAPABILITY_UNAVAILABLE" : "CAPABILITY_DEGRADED",
        message: `Cached capability ${capability.capability_name} is ${capability.status}.`,
      };
  }
}

export function primaryCapabilityReason(
  capabilitySnapshot: ReturnType<RunJournal["getCapabilitySnapshot"]>,
  capabilityRefreshStaleMs: number,
): ReasonDetail | null {
  if (!capabilitySnapshot) {
    return {
      code: "CAPABILITY_STATE_UNCACHED",
      message: "Capability state has not been refreshed durably yet.",
    };
  }

  const refreshedAtMillis = Date.parse(capabilitySnapshot.refreshed_at);
  if (!Number.isNaN(refreshedAtMillis) && Date.now() - refreshedAtMillis > capabilityRefreshStaleMs) {
    return {
      code: "CAPABILITY_STATE_STALE",
      message:
        "Latest capability refresh is stale; rerun capability_refresh if the host or workspace may have changed.",
    };
  }

  const firstUnavailable = capabilitySnapshot.capabilities.find((capability) => capability.status === "unavailable");
  if (firstUnavailable) {
    return capabilityReasonForRecord(firstUnavailable);
  }

  const firstDegraded = capabilitySnapshot.capabilities.find((capability) => capability.status === "degraded");
  if (firstDegraded) {
    return capabilityReasonForRecord(firstDegraded);
  }

  const firstWarning = capabilitySnapshot.degraded_mode_warnings[0];
  return firstWarning
    ? {
        code: "CAPABILITY_WARNING",
        message: firstWarning,
      }
    : null;
}

export function primaryStorageReason(overview: ReturnType<RunJournal["getDiagnosticsOverview"]>): ReasonDetail | null {
  if (overview.maintenance_status.degraded_artifact_capture_actions > 0) {
    return {
      code: "DEGRADED_ARTIFACT_CAPTURE",
      message: `${overview.maintenance_status.degraded_artifact_capture_actions} action(s) completed with degraded durable evidence capture.`,
    };
  }

  if (overview.maintenance_status.low_disk_pressure_signals > 0) {
    return {
      code: "LOW_DISK_PRESSURE_OBSERVED",
      message: `${overview.maintenance_status.low_disk_pressure_signals} low-disk pressure signal(s) were recorded while storing evidence.`,
    };
  }

  if (overview.maintenance_status.artifact_health.missing > 0) {
    return {
      code: "ARTIFACT_BLOB_MISSING",
      message: `${overview.maintenance_status.artifact_health.missing} artifact blob(s) are missing.`,
    };
  }

  if (overview.maintenance_status.artifact_health.expired > 0) {
    return {
      code: "ARTIFACT_BLOB_EXPIRED",
      message: `${overview.maintenance_status.artifact_health.expired} artifact blob(s) have expired by retention policy.`,
    };
  }

  if (overview.maintenance_status.artifact_health.corrupted > 0) {
    return {
      code: "ARTIFACT_BLOB_CORRUPTED",
      message: `${overview.maintenance_status.artifact_health.corrupted} artifact blob(s) are structurally corrupted.`,
    };
  }

  if (overview.maintenance_status.artifact_health.tampered > 0) {
    return {
      code: "ARTIFACT_BLOB_TAMPERED",
      message: `${overview.maintenance_status.artifact_health.tampered} artifact blob(s) failed integrity verification.`,
    };
  }

  return null;
}
