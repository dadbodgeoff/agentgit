import { fetchJson } from "@/lib/api/client";
import { appendCursorPagination, type CursorPaginationRequest } from "@/lib/api/endpoints/pagination";
import {
  ConnectorBootstrapResponseSchema,
  ConnectorCommandDispatchRequestSchema,
  ConnectorCommandDispatchResponseSchema,
  ConnectorCommandRetryResponseSchema,
  ConnectorRevokeResponseSchema,
  WorkspaceConnectorInventorySchema,
  type ConnectorBootstrapResponse,
  type ConnectorCommandDispatchRequest,
  type ConnectorCommandDispatchResponse,
  type ConnectorCommandRetryResponse,
  type ConnectorRevokeResponse,
  type WorkspaceConnectorInventory,
} from "@/schemas/cloud";

export async function getWorkspaceConnectors(
  params: CursorPaginationRequest = {},
): Promise<WorkspaceConnectorInventory> {
  const url = appendCursorPagination(new URL("/api/v1/sync/connectors", "http://localhost"), params);
  const response = await fetchJson<unknown>(url.pathname + url.search);
  return WorkspaceConnectorInventorySchema.parse(response);
}

export async function issueConnectorBootstrapToken(): Promise<ConnectorBootstrapResponse> {
  const response = await fetchJson<unknown>("/api/v1/sync/bootstrap-token", {
    method: "POST",
  });
  return ConnectorBootstrapResponseSchema.parse(response);
}

export async function dispatchConnectorCommand(
  connectorId: string,
  values: ConnectorCommandDispatchRequest,
): Promise<ConnectorCommandDispatchResponse> {
  const response = await fetchJson<unknown>(`/api/v1/sync/connectors/${connectorId}/commands`, {
    method: "POST",
    body: JSON.stringify(ConnectorCommandDispatchRequestSchema.parse(values)),
  });
  return ConnectorCommandDispatchResponseSchema.parse(response);
}

export async function retryConnectorCommand(commandId: string): Promise<ConnectorCommandRetryResponse> {
  const response = await fetchJson<unknown>(`/api/v1/sync/commands/${commandId}/retry`, {
    method: "POST",
  });
  return ConnectorCommandRetryResponseSchema.parse(response);
}

export async function revokeConnector(connectorId: string): Promise<ConnectorRevokeResponse> {
  const response = await fetchJson<unknown>(`/api/v1/sync/connectors/${connectorId}`, {
    method: "DELETE",
  });
  return ConnectorRevokeResponseSchema.parse(response);
}
