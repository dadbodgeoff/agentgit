import { fetchJson } from "@/lib/api/client";
import {
  IntegrationTestRequestSchema,
  IntegrationTestResponseSchema,
  type IntegrationTestChannel,
  type IntegrationTestResponse,
  WorkspaceIntegrationSaveResponseSchema,
  WorkspaceIntegrationSnapshotSchema,
  WorkspaceIntegrationUpdateSchema,
  type WorkspaceIntegrationSaveResponse,
  type WorkspaceIntegrationSnapshot,
  type WorkspaceIntegrationUpdate,
} from "@/schemas/cloud";

export async function getWorkspaceIntegrations(): Promise<WorkspaceIntegrationSnapshot> {
  const response = await fetchJson<unknown>("/api/v1/settings/integrations");
  return WorkspaceIntegrationSnapshotSchema.parse(response);
}

export async function updateWorkspaceIntegrations(
  values: WorkspaceIntegrationUpdate,
): Promise<WorkspaceIntegrationSaveResponse> {
  const response = await fetchJson<unknown>("/api/v1/settings/integrations", {
    method: "PUT",
    body: JSON.stringify(WorkspaceIntegrationUpdateSchema.parse(values)),
  });

  return WorkspaceIntegrationSaveResponseSchema.parse(response);
}

export async function sendIntegrationTest(
  channel: IntegrationTestChannel,
): Promise<IntegrationTestResponse> {
  const response = await fetchJson<unknown>("/api/v1/settings/integrations/test-notification", {
    method: "POST",
    body: JSON.stringify(IntegrationTestRequestSchema.parse({ channel })),
  });

  return IntegrationTestResponseSchema.parse(response);
}
