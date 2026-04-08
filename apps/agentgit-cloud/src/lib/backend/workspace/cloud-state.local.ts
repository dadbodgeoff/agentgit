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

export type WorkspaceIntegrationSecrets = {
  slackWebhookUrl: string | null;
};

type CloudStateCollections = {
  workspaces: WorkspaceConnectionState;
  workspaceBilling: WorkspaceBilling;
  workspaceIntegrations: WorkspaceIntegrationSnapshot;
  workspaceIntegrationSecrets: WorkspaceIntegrationSecrets;
  workspaceSettings: WorkspaceSettings;
};

function getCloudStateDbPath(): string {
  const root = process.env.AGENTGIT_ROOT ?? process.cwd();
  return path.join(root, ".agentgit", "state", "cloud", "state.db");
}

function createCloudStateStore() {
  fs.mkdirSync(path.dirname(getCloudStateDbPath()), { recursive: true });

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
      workspaceIntegrationSecrets: {
        parse(_key: string, value: unknown) {
          const candidate = value as WorkspaceIntegrationSecrets | null;
          return {
            slackWebhookUrl:
              typeof candidate?.slackWebhookUrl === "string" && candidate.slackWebhookUrl.length > 0
                ? candidate.slackWebhookUrl
                : null,
          };
        },
      },
    },
  });
}

export function getWorkspaceConnectionStateLocal(workspaceId: string): WorkspaceConnectionState | null {
  const store = createCloudStateStore();
  try {
    return store.get("workspaces", workspaceId);
  } finally {
    store.close();
  }
}

export function listWorkspaceConnectionStatesLocal(): WorkspaceConnectionState[] {
  const store = createCloudStateStore();
  try {
    return store.list("workspaces");
  } finally {
    store.close();
  }
}

export function findWorkspaceConnectionStateBySlugLocal(workspaceSlug: string): WorkspaceConnectionState | null {
  const store = createCloudStateStore();
  try {
    return store.list("workspaces").find((workspace) => workspace.workspaceSlug === workspaceSlug) ?? null;
  } finally {
    store.close();
  }
}

export function saveWorkspaceConnectionStateLocal(state: WorkspaceConnectionState): WorkspaceConnectionState {
  const store = createCloudStateStore();
  try {
    return store.put("workspaces", state.workspaceId, state);
  } finally {
    store.close();
  }
}

export function getStoredWorkspaceSettingsLocal(workspaceId: string): WorkspaceSettings | null {
  const store = createCloudStateStore();
  try {
    return store.get("workspaceSettings", workspaceId);
  } finally {
    store.close();
  }
}

export function saveStoredWorkspaceSettingsLocal(workspaceId: string, settings: WorkspaceSettings): WorkspaceSettings {
  const store = createCloudStateStore();
  try {
    return store.put("workspaceSettings", workspaceId, settings);
  } finally {
    store.close();
  }
}

export function findStoredWorkspaceSettingsBySlugLocal(workspaceSlug: string): {
  workspaceId: string;
  settings: WorkspaceSettings;
} | null {
  const store = createCloudStateStore();
  try {
    const rows = store.list("workspaceSettings");
    const matched = rows.find((settings) => settings.workspaceSlug === workspaceSlug);
    if (!matched) {
      return null;
    }

    const workspaceId = store.list("workspaces").find((workspace) => workspace.workspaceSlug === workspaceSlug)?.workspaceId;
    return {
      workspaceId: workspaceId ?? workspaceSlug,
      settings: matched,
    };
  } finally {
    store.close();
  }
}

export function getStoredWorkspaceBillingLocal(workspaceId: string): WorkspaceBilling | null {
  const store = createCloudStateStore();
  try {
    return store.get("workspaceBilling", workspaceId);
  } finally {
    store.close();
  }
}

export function saveStoredWorkspaceBillingLocal(workspaceId: string, billing: WorkspaceBilling): WorkspaceBilling {
  const store = createCloudStateStore();
  try {
    return store.put("workspaceBilling", workspaceId, billing);
  } finally {
    store.close();
  }
}

export function getStoredWorkspaceIntegrationsLocal(workspaceId: string): WorkspaceIntegrationSnapshot | null {
  const store = createCloudStateStore();
  try {
    return store.get("workspaceIntegrations", workspaceId);
  } finally {
    store.close();
  }
}

export function saveStoredWorkspaceIntegrationsLocal(
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

export function getWorkspaceIntegrationSecretsLocal(workspaceId: string): WorkspaceIntegrationSecrets | null {
  const store = createCloudStateStore();
  try {
    return store.get("workspaceIntegrationSecrets", workspaceId);
  } finally {
    store.close();
  }
}

export function saveWorkspaceIntegrationSecretsLocal(
  workspaceId: string,
  secrets: WorkspaceIntegrationSecrets,
): WorkspaceIntegrationSecrets {
  const store = createCloudStateStore();
  try {
    return store.put("workspaceIntegrationSecrets", workspaceId, secrets);
  } finally {
    store.close();
  }
}
