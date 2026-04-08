import { ApiClientError, fetchJson } from "@/lib/api/client";
import { appendCursorPagination, type CursorPaginationRequest } from "@/lib/api/endpoints/pagination";
import {
  AuditExportFormatSchema,
  AuditLogResponseSchema,
  type AuditExportFormat,
  type AuditLogResponse,
} from "@/schemas/cloud";

export async function getWorkspaceAuditLog(params: CursorPaginationRequest = {}): Promise<AuditLogResponse> {
  const url = appendCursorPagination(new URL("/api/v1/audit", "http://localhost"), params);
  const response = await fetchJson<unknown>(url.pathname + url.search);
  return AuditLogResponseSchema.parse(response);
}

function parseDownloadFileName(contentDisposition: string | null) {
  if (!contentDisposition) {
    return null;
  }

  const match = contentDisposition.match(/filename="([^"]+)"/i);
  return match?.[1] ?? null;
}

export async function downloadWorkspaceAuditLog(params: {
  format: AuditExportFormat;
  from?: string | null;
  to?: string | null;
}) {
  const query = new URLSearchParams({
    format: AuditExportFormatSchema.parse(params.format),
  });

  if (params.from) {
    query.set("from", params.from);
  }

  if (params.to) {
    query.set("to", params.to);
  }

  const response = await fetch(`/api/v1/audit/export?${query.toString()}`);
  if (!response.ok) {
    let details: unknown;
    try {
      details = await response.json();
    } catch {
      details = await response.text();
    }
    throw new ApiClientError(`Request failed with status ${response.status}`, response.status, details);
  }

  return {
    blob: await response.blob(),
    fileName: parseDownloadFileName(response.headers.get("content-disposition")) ?? `audit-export.${params.format}`,
  };
}
