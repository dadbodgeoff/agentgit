import { fetchJson } from "@/lib/api/client";
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

export async function getWorkspaceConnectors(): Promise<WorkspaceConnectorInventory> {
  const response = await fetchJson<unknown>("/api/v1/sync/connectors");
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
