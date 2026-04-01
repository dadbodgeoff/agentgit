import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { IntegrationState } from "@agentgit/integration-state";
import { AgentGitError } from "@agentgit/schemas";
import { v7 as uuidv7 } from "uuid";

export interface BearerCredentialProfile {
  profile_id: string;
  integration: string;
  base_url: string;
  token: string;
  scopes: string[];
  source: "session_env";
}

export interface BrokeredCredentialHandle {
  handle_id: string;
  profile_id: string;
  integration: string;
  credential_mode: "brokered";
  scopes: string[];
  issued_at: string;
}

export interface ResolvedBearerAccess {
  handle: BrokeredCredentialHandle;
  base_url: string;
  token: string;
  authorization_header: string;
}

interface EncryptedSecretEnvelope {
  algorithm: "aes-256-gcm";
  iv_b64: string;
  auth_tag_b64: string;
  ciphertext_b64: string;
}

interface StoredMcpBearerSecretDocument {
  secret_id: string;
  display_name: string | null;
  auth_type: "bearer";
  status: "active";
  version: number;
  created_at: string;
  updated_at: string;
  rotated_at: string | null;
  last_used_at: string | null;
  source: "operator_api";
  envelope: EncryptedSecretEnvelope;
}

export interface McpBearerSecretMetadata {
  secret_id: string;
  display_name: string | null;
  auth_type: "bearer";
  status: "active";
  version: number;
  created_at: string;
  updated_at: string;
  rotated_at: string | null;
  last_used_at: string | null;
  source: "operator_api";
}

export interface UpsertMcpBearerSecretResult {
  secret: McpBearerSecretMetadata;
  created: boolean;
  rotated: boolean;
}

export interface ResolvedMcpBearerSecretAccess {
  secret: McpBearerSecretMetadata;
  token: string;
  authorization_header: string;
}

export interface LocalEncryptedSecretStoreOptions {
  dbPath: string;
  keyPath?: string;
}

export interface CredentialBrokerOptions {
  mcpSecretStore?: LocalEncryptedSecretStore | null;
}

function createId(prefix: string): string {
  return `${prefix}_${uuidv7().replaceAll("-", "")}`;
}

function normalizeNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new AgentGitError("Credential broker profile is malformed.", "BROKER_UNAVAILABLE", {
      field,
    });
  }

  return normalized;
}

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = normalizeNonEmpty(baseUrl, "base_url");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch (error) {
    throw new AgentGitError("Credential broker profile base URL is invalid.", "BROKER_UNAVAILABLE", {
      base_url: normalized,
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new AgentGitError("Credential broker profile must use http or https.", "BROKER_UNAVAILABLE", {
      base_url: normalized,
      protocol: parsed.protocol,
    });
  }

  return parsed.toString().endsWith("/") ? parsed.toString() : `${parsed.toString()}/`;
}

function normalizeNullableDisplayName(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function toMetadata(document: StoredMcpBearerSecretDocument): McpBearerSecretMetadata {
  return {
    secret_id: document.secret_id,
    display_name: document.display_name,
    auth_type: document.auth_type,
    status: document.status,
    version: document.version,
    created_at: document.created_at,
    updated_at: document.updated_at,
    rotated_at: document.rotated_at,
    last_used_at: document.last_used_at,
    source: document.source,
  };
}

function ensureIsoTimestamp(value: string | null, field: string): string | null {
  if (value === null) {
    return null;
  }

  const normalized = normalizeNonEmpty(value, field);
  if (Number.isNaN(Date.parse(normalized))) {
    throw new AgentGitError("Stored MCP secret document contains an invalid timestamp.", "STORAGE_UNAVAILABLE", {
      field,
      value: normalized,
    });
  }

  return normalized;
}

function normalizeEnvelope(value: unknown, secretId: string): EncryptedSecretEnvelope {
  if (!value || typeof value !== "object") {
    throw new AgentGitError("Stored MCP secret document is malformed.", "STORAGE_UNAVAILABLE", {
      secret_id: secretId,
      field: "envelope",
    });
  }

  const record = value as Record<string, unknown>;
  const algorithm = record.algorithm;
  const iv = record.iv_b64;
  const authTag = record.auth_tag_b64;
  const ciphertext = record.ciphertext_b64;

  if (algorithm !== "aes-256-gcm" || typeof iv !== "string" || typeof authTag !== "string" || typeof ciphertext !== "string") {
    throw new AgentGitError("Stored MCP secret document encryption envelope is malformed.", "STORAGE_UNAVAILABLE", {
      secret_id: secretId,
    });
  }

  return {
    algorithm,
    iv_b64: iv,
    auth_tag_b64: authTag,
    ciphertext_b64: ciphertext,
  };
}

function normalizeStoredSecretDocument(key: string, value: unknown): StoredMcpBearerSecretDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AgentGitError("Stored MCP secret document is malformed.", "STORAGE_UNAVAILABLE", {
      secret_id: key,
    });
  }

  const record = value as Record<string, unknown>;
  const secretId = normalizeNonEmpty(typeof record.secret_id === "string" ? record.secret_id : "", "secret_id");
  if (secretId !== key) {
    throw new AgentGitError("Stored MCP secret key does not match the secret_id.", "STORAGE_UNAVAILABLE", {
      key,
      secret_id: secretId,
    });
  }

  const displayName = record.display_name;
  const version = record.version;
  const authType = record.auth_type;
  const status = record.status;
  const source = record.source;

  if (displayName !== null && typeof displayName !== "string") {
    throw new AgentGitError("Stored MCP secret display_name is malformed.", "STORAGE_UNAVAILABLE", {
      secret_id: secretId,
    });
  }

  if (!Number.isInteger(version) || Number(version) <= 0) {
    throw new AgentGitError("Stored MCP secret version is malformed.", "STORAGE_UNAVAILABLE", {
      secret_id: secretId,
      version,
    });
  }

  if (authType !== "bearer" || status !== "active" || source !== "operator_api") {
    throw new AgentGitError("Stored MCP secret metadata is malformed.", "STORAGE_UNAVAILABLE", {
      secret_id: secretId,
      auth_type: authType,
      status,
      source,
    });
  }

  const createdAt = ensureIsoTimestamp(typeof record.created_at === "string" ? record.created_at : null, "created_at");
  const updatedAt = ensureIsoTimestamp(typeof record.updated_at === "string" ? record.updated_at : null, "updated_at");
  if (createdAt === null || updatedAt === null) {
    throw new AgentGitError("Stored MCP secret document timestamps are malformed.", "STORAGE_UNAVAILABLE", {
      secret_id: secretId,
    });
  }

  return {
    secret_id: secretId,
    display_name: displayName ? normalizeNullableDisplayName(displayName) : null,
    auth_type: "bearer",
    status: "active",
    version: Number(version),
    created_at: createdAt,
    updated_at: updatedAt,
    rotated_at: ensureIsoTimestamp(typeof record.rotated_at === "string" ? record.rotated_at : null, "rotated_at"),
    last_used_at: ensureIsoTimestamp(typeof record.last_used_at === "string" ? record.last_used_at : null, "last_used_at"),
    source: "operator_api",
    envelope: normalizeEnvelope(record.envelope, secretId),
  };
}

export class LocalEncryptedSecretStore {
  private readonly state: IntegrationState<{ mcp_bearer_secrets: StoredMcpBearerSecretDocument }>;
  private readonly keyPath: string;
  private readonly encryptionKey: Buffer;

  constructor(options: LocalEncryptedSecretStoreOptions) {
    this.keyPath = options.keyPath ?? path.join(path.dirname(options.dbPath), "local-secret-store.key");
    this.encryptionKey = this.loadOrCreateKey(this.keyPath);
    this.state = new IntegrationState({
      dbPath: options.dbPath,
      collections: {
        mcp_bearer_secrets: {
          parse(key: string, value: unknown) {
            return normalizeStoredSecretDocument(key, value);
          },
        },
      },
    });
  }

  private loadOrCreateKey(keyPath: string): Buffer {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });

    if (fs.existsSync(keyPath)) {
      const encoded = fs.readFileSync(keyPath, "utf8").trim();
      const key = Buffer.from(encoded, "base64");
      if (key.length !== 32) {
        throw new AgentGitError("Local MCP secret store key is malformed.", "STORAGE_UNAVAILABLE", {
          key_path: keyPath,
        });
      }
      fs.chmodSync(keyPath, 0o600);
      return key;
    }

    const key = randomBytes(32);
    fs.writeFileSync(keyPath, key.toString("base64"), { mode: 0o600 });
    fs.chmodSync(keyPath, 0o600);
    return key;
  }

  private encrypt(value: string): EncryptedSecretEnvelope {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return {
      algorithm: "aes-256-gcm",
      iv_b64: iv.toString("base64"),
      auth_tag_b64: authTag.toString("base64"),
      ciphertext_b64: ciphertext.toString("base64"),
    };
  }

  private decrypt(envelope: EncryptedSecretEnvelope): string {
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.encryptionKey,
        Buffer.from(envelope.iv_b64, "base64"),
      );
      decipher.setAuthTag(Buffer.from(envelope.auth_tag_b64, "base64"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext_b64, "base64")),
        decipher.final(),
      ]);
      return plaintext.toString("utf8");
    } catch (error) {
      throw new AgentGitError("Stored MCP secret could not be decrypted.", "STORAGE_UNAVAILABLE", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  storageMode(): "local_encrypted_store" {
    return "local_encrypted_store";
  }

  keyFilePath(): string {
    return this.keyPath;
  }

  checkpointWal() {
    return this.state.checkpointWal();
  }

  listMcpBearerSecrets(): McpBearerSecretMetadata[] {
    return this.state
      .list("mcp_bearer_secrets")
      .map((document: StoredMcpBearerSecretDocument) => toMetadata(document));
  }

  getMcpBearerSecret(secretId: string): McpBearerSecretMetadata | null {
    const normalizedSecretId = normalizeNonEmpty(secretId, "secret_id");
    const document = this.state.get("mcp_bearer_secrets", normalizedSecretId);
    return document ? toMetadata(document) : null;
  }

  upsertMcpBearerSecret(input: {
    secret_id: string;
    bearer_token: string;
    display_name?: string;
  }): UpsertMcpBearerSecretResult {
    const secretId = normalizeNonEmpty(input.secret_id, "secret_id");
    const token = normalizeNonEmpty(input.bearer_token, "bearer_token");
    const displayName = normalizeNullableDisplayName(input.display_name);
    const now = new Date().toISOString();
    const existing = this.state.get("mcp_bearer_secrets", secretId);
    const existingToken = existing ? this.decrypt(existing.envelope) : null;
    const rotated = existing !== null && existingToken !== token;
    const version = existing === null ? 1 : rotated ? existing.version + 1 : existing.version;

    const document: StoredMcpBearerSecretDocument = {
      secret_id: secretId,
      display_name: displayName,
      auth_type: "bearer",
      status: "active",
      version,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      rotated_at: rotated ? now : existing?.rotated_at ?? null,
      last_used_at: existing?.last_used_at ?? null,
      source: "operator_api",
      envelope: this.encrypt(token),
    };

    this.state.put("mcp_bearer_secrets", secretId, document);
    return {
      secret: toMetadata(document),
      created: existing === null,
      rotated,
    };
  }

  removeMcpBearerSecret(secretId: string): McpBearerSecretMetadata | null {
    const normalizedSecretId = normalizeNonEmpty(secretId, "secret_id");
    const existing = this.state.get("mcp_bearer_secrets", normalizedSecretId);
    if (!existing) {
      return null;
    }

    this.state.delete("mcp_bearer_secrets", normalizedSecretId);
    return toMetadata(existing);
  }

  resolveMcpBearerSecret(secretId: string): ResolvedMcpBearerSecretAccess {
    const normalizedSecretId = normalizeNonEmpty(secretId, "secret_id");
    const existing = this.state.get("mcp_bearer_secrets", normalizedSecretId);
    if (!existing) {
      throw new AgentGitError("Governed MCP secret is not configured.", "BROKER_UNAVAILABLE", {
        secret_id: normalizedSecretId,
      });
    }

    const now = new Date().toISOString();
    const updatedDocument: StoredMcpBearerSecretDocument = {
      ...existing,
      last_used_at: now,
      updated_at: now,
    };
    this.state.put("mcp_bearer_secrets", normalizedSecretId, updatedDocument);
    const token = this.decrypt(updatedDocument.envelope);

    return {
      secret: toMetadata(updatedDocument),
      token,
      authorization_header: `Bearer ${token}`,
    };
  }

  close(): void {
    this.state.close();
  }
}

export class SessionCredentialBroker {
  private readonly profilesByIntegration = new Map<string, BearerCredentialProfile>();
  private readonly mcpSecretStore: LocalEncryptedSecretStore | null;

  constructor(options: CredentialBrokerOptions = {}) {
    this.mcpSecretStore = options.mcpSecretStore ?? null;
  }

  registerBearerProfile(input: {
    integration: string;
    base_url: string;
    token: string;
    scopes?: string[];
    profile_id?: string;
  }): BearerCredentialProfile {
    const integration = normalizeNonEmpty(input.integration, "integration");
    const token = normalizeNonEmpty(input.token, "token");
    const baseUrl = normalizeBaseUrl(input.base_url);
    const scopes = [...new Set((input.scopes ?? []).map((scope) => normalizeNonEmpty(scope, "scope")))];

    const profile: BearerCredentialProfile = {
      profile_id: input.profile_id ? normalizeNonEmpty(input.profile_id, "profile_id") : createId("credprof"),
      integration,
      base_url: baseUrl,
      token,
      scopes,
      source: "session_env",
    };

    this.profilesByIntegration.set(integration, profile);
    return {
      ...profile,
      token: "[REDACTED]",
    } as BearerCredentialProfile;
  }

  hasProfile(integration: string): boolean {
    return this.profilesByIntegration.has(integration);
  }

  resolveBearerAccess(params: {
    integration: string;
    required_scope?: string;
  }): ResolvedBearerAccess {
    const integration = normalizeNonEmpty(params.integration, "integration");
    const profile = this.profilesByIntegration.get(integration);
    if (!profile) {
      throw new AgentGitError("Brokered credentials are not configured for this integration.", "BROKER_UNAVAILABLE", {
        integration,
      });
    }

    if (params.required_scope && !profile.scopes.includes(params.required_scope)) {
      throw new AgentGitError("Brokered credential profile does not satisfy the required scope.", "BROKER_UNAVAILABLE", {
        integration,
        required_scope: params.required_scope,
        profile_id: profile.profile_id,
      });
    }

    const issuedAt = new Date().toISOString();
    return {
      handle: {
        handle_id: createId("credh"),
        profile_id: profile.profile_id,
        integration,
        credential_mode: "brokered",
        scopes: [...profile.scopes],
        issued_at: issuedAt,
      },
      base_url: profile.base_url,
      token: profile.token,
      authorization_header: `Bearer ${profile.token}`,
    };
  }

  supportsDurableSecretStorage(): boolean {
    return this.mcpSecretStore !== null;
  }

  durableSecretStorageMode(): "session_env_only" | "local_encrypted_store" {
    return this.mcpSecretStore ? this.mcpSecretStore.storageMode() : "session_env_only";
  }

  durableSecretStorageDetails():
    | {
        mode: "local_encrypted_store";
        key_path: string;
      }
    | null {
    if (!this.mcpSecretStore) {
      return null;
    }

    return {
      mode: "local_encrypted_store",
      key_path: this.mcpSecretStore.keyFilePath(),
    };
  }

  listMcpBearerSecrets(): McpBearerSecretMetadata[] {
    return this.mcpSecretStore?.listMcpBearerSecrets() ?? [];
  }

  upsertMcpBearerSecret(input: {
    secret_id: string;
    bearer_token: string;
    display_name?: string;
  }): UpsertMcpBearerSecretResult {
    if (!this.mcpSecretStore) {
      throw new AgentGitError("Durable MCP secret storage is not available on this host.", "BROKER_UNAVAILABLE");
    }

    return this.mcpSecretStore.upsertMcpBearerSecret(input);
  }

  removeMcpBearerSecret(secretId: string): McpBearerSecretMetadata | null {
    if (!this.mcpSecretStore) {
      throw new AgentGitError("Durable MCP secret storage is not available on this host.", "BROKER_UNAVAILABLE");
    }

    return this.mcpSecretStore.removeMcpBearerSecret(secretId);
  }

  resolveMcpBearerSecret(secretId: string): ResolvedMcpBearerSecretAccess {
    if (!this.mcpSecretStore) {
      throw new AgentGitError("Durable MCP secret storage is not available on this host.", "BROKER_UNAVAILABLE");
    }

    return this.mcpSecretStore.resolveMcpBearerSecret(secretId);
  }

  checkpointMcpSecretStore() {
    return this.mcpSecretStore?.checkpointWal() ?? null;
  }

  close(): void {
    this.mcpSecretStore?.close();
  }
}
