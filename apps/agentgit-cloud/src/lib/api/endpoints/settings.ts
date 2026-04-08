import { fetchJson } from "@/lib/api/client";
import {
  WorkspaceSettingsSaveResponseSchema,
  WorkspaceSettingsSchema,
  WorkspaceSettingsUpdateSchema,
  type WorkspaceSettings,
  type WorkspaceSettingsUpdate,
  type WorkspaceSettingsSaveResponse,
} from "@/schemas/cloud";

export async function getWorkspaceSettings(): Promise<WorkspaceSettings> {
  const response = await fetchJson<unknown>("/api/v1/settings/workspace");
  return WorkspaceSettingsSchema.parse(response);
}

export async function updateWorkspaceSettings(
  settings: WorkspaceSettingsUpdate,
): Promise<WorkspaceSettingsSaveResponse> {
  const response = await fetchJson<unknown>("/api/v1/settings/workspace", {
    method: "PUT",
    body: JSON.stringify(WorkspaceSettingsUpdateSchema.parse(settings)),
  });

  return WorkspaceSettingsSaveResponseSchema.parse(response);
}
