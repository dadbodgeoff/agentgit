import "server-only";

import fs from "node:fs";
import path from "node:path";

import { IntegrationState } from "@agentgit/integration-state";

import {
  WorkspaceConnectionStateSchema,
  WorkspaceBillingSchema,
  WorkspaceIntegrationSnapshotSchema,
  WorkspaceSettingsSchema,
  type WorkspaceConnectionState,
  type WorkspaceBilling,
  type WorkspaceIntegrationSnapshot,
  type WorkspaceSettings,
} from "@/schemas/cloud";

type CloudStateCollections = {
  workspaces: WorkspaceConnectionState;
  workspaceBilling: WorkspaceBilling;
  workspaceIntegrations: WorkspaceIntegrationSnapshot;
  workspaceSettings: WorkspaceSettings;
};

function getCloudStateDbPath(): string {
  const root = process.env.AGENTGIT_ROOT ?? process.cwd();
  return path.join(root, ".agentgit", "state", "cloud", "state.db");
}

function createCloudStateStore() {
  fs.mkdirSync(path.dirname(getCloudStateDbPath()), { recursive: true });

  try {
    return new IntegrationState<CloudStateCollections>({
      dbPath: getCloudStateDbPath(),
      collections: {
        workspaces: {
          parse(_key: string, value: unknown) {
            return WorkspaceConnectionStateSchema.parse(value);
          },
        },
        workspaceSettings: {
          parse(_key: string, value: unknown) {
            return WorkspaceSettingsSchema.parse(value);
          },
        },
        workspaceBilling: {
          parse(_key: string, value: unknown) {
            return WorkspaceBillingSchema.parse(value);
          },
        },
        workspaceIntegrations: {
          parse(_key: string, value: unknown) {
            return WorkspaceIntegrationSnapshotSchema.parse(value);
          },
        },
      },
    });
  } catch (error) {
    console.error("agentgit_cloud_state_init_failed", {
      dbPath: getCloudStateDbPath(),
      details:
        typeof error === "object" && error !== null && "details" in error
          ? (error as { details?: unknown }).details
          : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function getWorkspaceConnectionState(workspaceId: string): WorkspaceConnectionState | null {
  const store = createCloudStateStore();
  try {
    return store.get("workspaces", workspaceId);
  } finally {
    store.close();
  }
}

export function listWorkspaceConnectionStates(): WorkspaceConnectionState[] {
  const store = createCloudStateStore();
  try {
    return store.list("workspaces");
  } finally {
    store.close();
  }
}

export function findWorkspaceConnectionStateBySlug(workspaceSlug: string): WorkspaceConnectionState | null {
  const store = createCloudStateStore();
  try {
    return (
      store.list("workspaces").find((workspace: WorkspaceConnectionState) => workspace.workspaceSlug === workspaceSlug) ??
      null
    );
  } finally {
    store.close();
  }
}

export function saveWorkspaceConnectionState(state: WorkspaceConnectionState): WorkspaceConnectionState {
  const store = createCloudStateStore();
  try {
    return store.put("workspaces", state.workspaceId, state);
  } finally {
    store.close();
  }
}

export function getStoredWorkspaceSettings(workspaceId: string): WorkspaceSettings | null {
  const store = createCloudStateStore();
  try {
    return store.get("workspaceSettings", workspaceId);
  } finally {
    store.close();
  }
}

export function saveStoredWorkspaceSettings(workspaceId: string, settings: WorkspaceSettings): WorkspaceSettings {
  const store = createCloudStateStore();
  try {
    return store.put("workspaceSettings", workspaceId, settings);
  } finally {
    store.close();
  }
}

export function findStoredWorkspaceSettingsBySlug(workspaceSlug: string): {
  workspaceId: string;
  settings: WorkspaceSettings;
} | null {
  const store = createCloudStateStore();
  try {
    const rows = store.list("workspaceSettings");
    const matched = rows.find((settings: WorkspaceSettings) => settings.workspaceSlug === workspaceSlug);
    if (!matched) {
      return null;
    }

    const workspaceId =
      store
        .list("workspaces")
        .find((workspace: WorkspaceConnectionState) => workspace.workspaceSlug === workspaceSlug)?.workspaceId ?? null;

    return {
      workspaceId: workspaceId ?? workspaceSlug,
      settings: matched,
    };
  } finally {
    store.close();
  }
}

export function getStoredWorkspaceBilling(workspaceId: string): WorkspaceBilling | null {
  const store = createCloudStateStore();
  try {
    return store.get("workspaceBilling", workspaceId);
  } finally {
    store.close();
  }
}

export function saveStoredWorkspaceBilling(workspaceId: string, billing: WorkspaceBilling): WorkspaceBilling {
  const store = createCloudStateStore();
  try {
    return store.put("workspaceBilling", workspaceId, billing);
  } finally {
    store.close();
  }
}

export function getStoredWorkspaceIntegrations(workspaceId: string): WorkspaceIntegrationSnapshot | null {
  const store = createCloudStateStore();
  try {
    return store.get("workspaceIntegrations", workspaceId);
  } finally {
    store.close();
  }
}

export function saveStoredWorkspaceIntegrations(
  workspaceId: string,
  integrations: WorkspaceIntegrationSnapshot,
): WorkspaceIntegrationSnapshot {
  const store = createCloudStateStore();
  try {
    return store.put("workspaceIntegrations", workspaceId, integrations);
  } finally {
    store.close();
  }
}
