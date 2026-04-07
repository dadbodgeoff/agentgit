export interface TenantContext {
  tenant_id: string;
}

export interface ActorContext {
  actor_id: string;
  auth_method: "local" | "api_key" | "jwt" | "service_account";
  scopes: string[];
}

export interface WorkspaceContext {
  workspace_id: string;
  workspace_roots: string[];
}

export interface RequestContext {
  tenant: TenantContext | null;
  actor: ActorContext | null;
  workspace: WorkspaceContext | null;
  transport: "unix_socket" | "http_rpc" | "internal";
  source_address: string;
  trace_id?: string;
  span_id?: string;
}
