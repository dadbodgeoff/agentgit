import { fetchJson } from "@/lib/api/client";
import { AuditLogResponseSchema, type AuditLogResponse } from "@/schemas/cloud";

export async function getWorkspaceAuditLog(): Promise<AuditLogResponse> {
  const response = await fetchJson<unknown>("/api/v1/audit");
  return AuditLogResponseSchema.parse(response);
}
