import { fetchJson, fetchJsonWithResponse } from "@/lib/api/client";
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

const CONNECTOR_BOOTSTRAP_TOKEN_HEADER = "x-agentgit-connector-bootstrap-token";

export async function getWorkspaceConnectors(
  params: CursorPaginationRequest = {},
): Promise<WorkspaceConnectorInventory> {
  const url = appendCursorPagination(new URL("/api/v1/sync/connectors", "http://localhost"), params);
  const response = await fetchJson<unknown>(url.pathname + url.search);
  return WorkspaceConnectorInventorySchema.parse(response);
}

export async function issueConnectorBootstrapToken(): Promise<ConnectorBootstrapResponse> {
  const { data, response } = await fetchJsonWithResponse<unknown>("/api/v1/sync/bootstrap-token", {
    method: "POST",
  });
  const parsed = ConnectorBootstrapResponseSchema.omit({ bootstrapToken: true }).parse(data);
  const bootstrapToken = response.headers.get(CONNECTOR_BOOTSTRAP_TOKEN_HEADER)?.trim();
  if (!bootstrapToken) {
    throw new Error("Connector bootstrap response did not include a bootstrap token header.");
  }

  return ConnectorBootstrapResponseSchema.parse({
    ...parsed,
    bootstrapToken,
  });
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
