import { fetchJson } from "@/lib/api/client";
import {
  WorkspaceTeamSaveResponseSchema,
  WorkspaceTeamSnapshotSchema,
  type WorkspaceTeamSaveResponse,
  type WorkspaceTeamSnapshot,
  type WorkspaceTeamUpdate,
} from "@/schemas/cloud";

export async function getWorkspaceTeam(): Promise<WorkspaceTeamSnapshot> {
  const response = await fetchJson<unknown>("/api/v1/settings/team");
  return WorkspaceTeamSnapshotSchema.parse(response);
}

export async function updateWorkspaceTeam(update: WorkspaceTeamUpdate): Promise<WorkspaceTeamSaveResponse> {
  const response = await fetchJson<unknown>("/api/v1/settings/team", {
    method: "PUT",
    body: JSON.stringify(update),
  });

  return WorkspaceTeamSaveResponseSchema.parse(response);
}
