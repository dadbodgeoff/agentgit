import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "node:crypto";

import { IntegrationState } from "@agentgit/integration-state";
import { AgentGitError, type RuntimeCredentialBindingRecord } from "@agentgit/schemas";
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
  expires_at: string | null;
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
  expires_at: string | null;
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

export interface ResolvedRuntimeCredentialBinding {
  binding: RuntimeCredentialBindingRecord;
  resolved_value: string;
  expires_at: string | null;
}

export interface LocalEncryptedSecretStoreOptions {
  dbPath: string;
  keyPath?: string;
  serviceName?: string;
  keyProvider?: SecretKeyProvider;
}

export interface CredentialBrokerOptions {
  mcpSecretStore?: LocalEncryptedSecretStore | null;
}

export type SecretKeyProviderKind = "macos_keychain" | "linux_secret_service";

export interface SecretKeyProviderDetails {
  provider: SecretKeyProviderKind;
  key_identifier: string;
  legacy_key_path: string | null;
}

export interface SecretKeyProvider {
  readonly kind: SecretKeyProviderKind;
  loadOrCreateKey(params: { serviceName: string; keyIdentifier: string; legacyKeyPath?: string }): Buffer;
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

function normalizeOptionalIsoTimestamp(value: string | undefined, field: string): string | null {
  if (value === undefined) {
    return null;
  }

  const normalized = normalizeNonEmpty(value, field);
  if (Number.isNaN(Date.parse(normalized))) {
    throw new AgentGitError("MCP secret timestamp is malformed.", "BROKER_UNAVAILABLE", {
      field,
      value: normalized,
    });
  }

  return normalized;
}

function normalizeStoredKeyMaterial(encoded: string, details: Record<string, unknown>): Buffer {
  const key = Buffer.from(encoded.trim(), "base64");
  if (key.length !== 32) {
    throw new AgentGitError("Local MCP secret store key is malformed.", "STORAGE_UNAVAILABLE", details);
  }

  return key;
}

function openSecureExistingFile(filePath: string): number | null {
  let flags = fs.constants.O_RDONLY;
  if (typeof fs.constants.O_NOFOLLOW === "number") {
    flags |= fs.constants.O_NOFOLLOW;
  }

  try {
    const fd = fs.openSync(filePath, flags);
    const stats = fs.fstatSync(fd);
    if (!stats.isFile()) {
      fs.closeSync(fd);
      throw new AgentGitError("Local MCP secret store key path is not a regular file.", "STORAGE_UNAVAILABLE", {
        key_path: filePath,
      });
    }

    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      fs.closeSync(fd);
      throw new AgentGitError("Local MCP secret store key must be owned by the current user.", "STORAGE_UNAVAILABLE", {
        key_path: filePath,
        owner_uid: stats.uid,
      });
    }

    if (stats.nlink > 1) {
      fs.closeSync(fd);
      throw new AgentGitError("Local MCP secret store key cannot be a hard-linked file.", "STORAGE_UNAVAILABLE", {
        key_path: filePath,
        link_count: stats.nlink,
      });
    }

    return fd;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : null;
    if (code === "ENOENT") {
      return null;
    }
    if (code === "ELOOP") {
      throw new AgentGitError("Local MCP secret store key cannot be a symlink.", "STORAGE_UNAVAILABLE", {
        key_path: filePath,
      });
    }
    throw error;
  }
}

function readLegacyKeyFile(keyPath: string): Buffer | null {
  const fd = openSecureExistingFile(keyPath);
  if (fd === null) {
    return null;
  }

  try {
    fs.fchmodSync(fd, 0o600);
    const encoded = fs.readFileSync(fd, "utf8").trim();
    return normalizeStoredKeyMaterial(encoded, {
      key_path: keyPath,
    });
  } finally {
    fs.closeSync(fd);
  }
}

function removeLegacyKeyFile(keyPath: string): void {
  try {
    fs.unlinkSync(keyPath);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : null;
    if (code === "ENOENT") {
      return;
    }
    throw error;
  }
}

const SECRET_COMMAND_TIMEOUT_MS = 5_000;

function runSecretCommand(command: string, args: string[], stdin?: string): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input: stdin,
    stdio: ["pipe", "pipe", "pipe"],
    timeout: SECRET_COMMAND_TIMEOUT_MS,
  });

  if (result.error) {
    throw new AgentGitError("OS-backed secret storage command failed to execute.", "BROKER_UNAVAILABLE", {
      command,
      cause: result.error.message,
    });
  }

  if (result.status !== 0) {
    throw new AgentGitError("OS-backed secret storage command failed.", "BROKER_UNAVAILABLE", {
      command,
      args,
      status: result.status,
      stderr: result.stderr.trim() || null,
    });
  }

  return result.stdout.trim();
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ["--help"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: SECRET_COMMAND_TIMEOUT_MS,
  });

  return !result.error;
}

class MacOsKeychainSecretKeyProvider implements SecretKeyProvider {
  readonly kind = "macos_keychain";

  loadOrCreateKey(params: { serviceName: string; keyIdentifier: string; legacyKeyPath?: string }): Buffer {
    const legacyKey = params.legacyKeyPath ? readLegacyKeyFile(params.legacyKeyPath) : null;
    if (legacyKey) {
      return legacyKey;
    }

    if (!commandExists("security")) {
      throw new AgentGitError("macOS Keychain access is unavailable on this host.", "BROKER_UNAVAILABLE", {
        provider: this.kind,
      });
    }

    const service = `${params.serviceName}:${params.keyIdentifier}`;
    const account = "mcp-envelope-key";

    try {
      const existing = runSecretCommand("security", ["find-generic-password", "-a", account, "-s", service, "-w"]);
      return normalizeStoredKeyMaterial(existing, {
        provider: this.kind,
        service,
      });
    } catch (error) {
      if (
        error instanceof AgentGitError &&
        typeof error.details?.stderr === "string" &&
        error.details.stderr.includes("could not be found")
      ) {
        const key = legacyKey ?? randomBytes(32);
        runSecretCommand("security", [
          "add-generic-password",
          "-U",
          "-a",
          account,
          "-s",
          service,
          "-w",
          key.toString("base64"),
        ]);
        if (legacyKey && params.legacyKeyPath) {
          removeLegacyKeyFile(params.legacyKeyPath);
        }
        return key;
      }

      throw error;
    }
  }
}

class LinuxSecretServiceKeyProvider implements SecretKeyProvider {
  readonly kind = "linux_secret_service";

  loadOrCreateKey(params: { serviceName: string; keyIdentifier: string; legacyKeyPath?: string }): Buffer {
    const legacyKey = params.legacyKeyPath ? readLegacyKeyFile(params.legacyKeyPath) : null;
    if (legacyKey) {
      return legacyKey;
    }

    if (!commandExists("secret-tool")) {
      throw new AgentGitError("Linux Secret Service access is unavailable on this host.", "BROKER_UNAVAILABLE", {
        provider: this.kind,
      });
    }

    const label = `AgentGit MCP Secret Key ${createHash("sha256")
      .update(`${params.serviceName}:${params.keyIdentifier}`)
      .digest("hex")
      .slice(0, 16)}`;

    try {
      const existing = runSecretCommand("secret-tool", [
        "lookup",
        "service",
        params.serviceName,
        "account",
        params.keyIdentifier,
      ]);
      return normalizeStoredKeyMaterial(existing, {
        provider: this.kind,
        service: params.serviceName,
        account: params.keyIdentifier,
      });
    } catch {
      const key = legacyKey ?? randomBytes(32);
      runSecretCommand(
        "secret-tool",
        ["store", "--label", label, "service", params.serviceName, "account", params.keyIdentifier],
        `${key.toString("base64")}\n`,
      );
      if (legacyKey && params.legacyKeyPath) {
        removeLegacyKeyFile(params.legacyKeyPath);
      }
      return key;
    }
  }
}

function resolveFileBackedSecretKeyProviderKind(platform = process.platform): SecretKeyProviderKind {
  return platform === "darwin" ? "macos_keychain" : "linux_secret_service";
}

export function createFileBackedSecretKeyProvider(options: { kind?: SecretKeyProviderKind } = {}): SecretKeyProvider {
  return {
    kind: options.kind ?? resolveFileBackedSecretKeyProviderKind(),
    loadOrCreateKey(params: { serviceName: string; keyIdentifier: string; legacyKeyPath?: string }): Buffer {
      if (!params.legacyKeyPath) {
        throw new AgentGitError(
          "Durable MCP secret storage fallback requires a legacy key path.",
          "BROKER_UNAVAILABLE",
        );
      }

      const existing = readLegacyKeyFile(params.legacyKeyPath);
      if (existing) {
        return existing;
      }

      const created = randomBytes(32);
      fs.mkdirSync(path.dirname(params.legacyKeyPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(params.legacyKeyPath, created.toString("base64"), { encoding: "utf8", mode: 0o600 });
      fs.chmodSync(params.legacyKeyPath, 0o600);
      return created;
    },
  };
}

function createDefaultSecretKeyProvider(): SecretKeyProvider {
  if (process.platform === "darwin") {
    return new MacOsKeychainSecretKeyProvider();
  }

  if (process.platform === "linux") {
    return new LinuxSecretServiceKeyProvider();
  }

  throw new AgentGitError("Durable MCP secret storage is not supported on this host platform.", "BROKER_UNAVAILABLE", {
    platform: process.platform,
  });
}

function createKeyIdentifier(dbPath: string): string {
  return createHash("sha256").update(path.resolve(dbPath)).digest("hex");
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
    expires_at: document.expires_at,
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

  if (
    algorithm !== "aes-256-gcm" ||
    typeof iv !== "string" ||
    typeof authTag !== "string" ||
    typeof ciphertext !== "string"
  ) {
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
    last_used_at: ensureIsoTimestamp(
      typeof record.last_used_at === "string" ? record.last_used_at : null,
      "last_used_at",
    ),
    expires_at: ensureIsoTimestamp(typeof record.expires_at === "string" ? record.expires_at : null, "expires_at"),
    source: "operator_api",
    envelope: normalizeEnvelope(record.envelope, secretId),
  };
}

function bindingMetadataString(metadata: Record<string, unknown>, field: string): string | null {
  const value = metadata[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function bindingMetadataNumber(metadata: Record<string, unknown>, field: string): number | null {
  const value = metadata[field];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export class LocalEncryptedSecretStore {
  private readonly state: IntegrationState<{ mcp_bearer_secrets: StoredMcpBearerSecretDocument }>;
  private readonly encryptionKey: Buffer;
  private readonly runtimeTicketSigningKey: Buffer;
  private readonly keyProviderDetails: SecretKeyProviderDetails;

  constructor(options: LocalEncryptedSecretStoreOptions) {
    const keyProvider = options.keyProvider ?? createDefaultSecretKeyProvider();
    const serviceName = normalizeNonEmpty(options.serviceName ?? "com.agentgit.mcp.secret-store", "service_name");
    const keyIdentifier = createKeyIdentifier(options.dbPath);
    this.encryptionKey = keyProvider.loadOrCreateKey({
      serviceName,
      keyIdentifier,
      legacyKeyPath: options.keyPath,
    });
    this.runtimeTicketSigningKey = Buffer.from(
      hkdfSync(
        "sha256",
        this.encryptionKey,
        Buffer.from("agentgit/runtime-ticket-signing/salt.v1", "utf8"),
        Buffer.from("agentgit/runtime-ticket-signing-key.v1", "utf8"),
        32,
      ),
    );
    this.keyProviderDetails = {
      provider: keyProvider.kind,
      key_identifier: keyIdentifier,
      legacy_key_path: options.keyPath ?? null,
    };
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
      const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, Buffer.from(envelope.iv_b64, "base64"));
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

  storageDetails(): SecretKeyProviderDetails {
    return {
      ...this.keyProviderDetails,
    };
  }

  checkpointWal() {
    return this.state.checkpointWal();
  }

  listMcpBearerSecrets(): McpBearerSecretMetadata[] {
    return this.state.list("mcp_bearer_secrets").map((document: StoredMcpBearerSecretDocument) => toMetadata(document));
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
    expires_at?: string;
  }): UpsertMcpBearerSecretResult {
    const secretId = normalizeNonEmpty(input.secret_id, "secret_id");
    const token = normalizeNonEmpty(input.bearer_token, "bearer_token");
    const displayName = normalizeNullableDisplayName(input.display_name);
    const expiresAt = normalizeOptionalIsoTimestamp(input.expires_at, "expires_at");
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
      rotated_at: rotated ? now : (existing?.rotated_at ?? null),
      last_used_at: existing?.last_used_at ?? null,
      expires_at: expiresAt,
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

    if (existing.expires_at !== null && Date.parse(existing.expires_at) <= Date.now()) {
      throw new AgentGitError(
        "Governed MCP secret is expired and must be rotated before execution.",
        "BROKER_UNAVAILABLE",
        {
          secret_id: normalizedSecretId,
          expires_at: existing.expires_at,
        },
      );
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

  resolveRuntimeCredentialBinding(binding: RuntimeCredentialBindingRecord): ResolvedRuntimeCredentialBinding {
    const metadata = binding.redacted_delivery_metadata ?? {};
    const now = new Date();
    const resolvedSecret = this.resolveMcpBearerSecret(binding.broker_source_ref);
    const expiresAtCandidates =
      [binding.expires_at ?? null, resolvedSecret.secret.expires_at]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .sort()[0] ?? null;
    if (expiresAtCandidates !== null && Date.parse(expiresAtCandidates) <= now.getTime()) {
      throw new AgentGitError(
        "Runtime credential binding is expired and must be rotated before execution.",
        "BROKER_UNAVAILABLE",
        {
          binding_id: binding.binding_id,
          kind: binding.kind,
          expires_at: expiresAtCandidates,
        },
      );
    }

    if (binding.kind === "env" || binding.kind === "file") {
      return {
        binding,
        resolved_value: resolvedSecret.token,
        expires_at: expiresAtCandidates,
      };
    }

    if (binding.kind === "header_template") {
      const template = bindingMetadataString(metadata, "template") ?? "Bearer {{token}}";
      return {
        binding,
        resolved_value: template.replaceAll("{{token}}", resolvedSecret.token),
        expires_at: expiresAtCandidates,
      };
    }

    if (binding.kind === "runtime_ticket") {
      const ttlSeconds = Math.max(60, Math.min(bindingMetadataNumber(metadata, "ticket_ttl_seconds") ?? 900, 86_400));
      const audience = bindingMetadataString(metadata, "audience");
      if (!audience) {
        throw new AgentGitError("Runtime credential tickets require a non-empty audience.", "BROKER_UNAVAILABLE", {
          binding_id: binding.binding_id,
          kind: binding.kind,
          broker_source_ref: binding.broker_source_ref,
        });
      }
      const ticketExpiresAt = new Date(
        Math.min(
          now.getTime() + ttlSeconds * 1_000,
          expiresAtCandidates ? Date.parse(expiresAtCandidates) : Number.POSITIVE_INFINITY,
        ),
      );
      const payload = JSON.stringify({
        binding_id: binding.binding_id,
        kind: binding.kind,
        audience,
        broker_source_ref: binding.broker_source_ref,
        exp: ticketExpiresAt.toISOString(),
      });
      const encodedPayload = Buffer.from(payload, "utf8").toString("base64url");
      const signature = createHmac("sha256", this.runtimeTicketSigningKey)
        .update(`${encodedPayload}.${resolvedSecret.token}`)
        .digest("base64url");
      return {
        binding,
        resolved_value: `agtkt.${encodedPayload}.${signature}`,
        expires_at: ticketExpiresAt.toISOString(),
      };
    }

    if (binding.kind === "tool_scoped_ref") {
      const toolName = bindingMetadataString(metadata, "tool_name");
      if (!toolName) {
        throw new AgentGitError(
          "Tool-scoped runtime credential bindings require a redacted tool_name hint.",
          "BROKER_UNAVAILABLE",
          {
            binding_id: binding.binding_id,
            kind: binding.kind,
          },
        );
      }

      return {
        binding,
        resolved_value: `agentgit+tool-ref://${encodeURIComponent(toolName)}?binding=${encodeURIComponent(binding.binding_id)}&source=${encodeURIComponent(binding.broker_source_ref)}`,
        expires_at: expiresAtCandidates,
      };
    }

    throw new AgentGitError("Unsupported runtime credential binding kind.", "BROKER_UNAVAILABLE", {
      binding_id: binding.binding_id,
      kind: binding.kind,
    });
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

  resolveBearerAccess(params: { integration: string; required_scope?: string }): ResolvedBearerAccess {
    const integration = normalizeNonEmpty(params.integration, "integration");
    const profile = this.profilesByIntegration.get(integration);
    if (!profile) {
      throw new AgentGitError("Brokered credentials are not configured for this integration.", "BROKER_UNAVAILABLE", {
        integration,
      });
    }

    if (params.required_scope && !profile.scopes.includes(params.required_scope)) {
      throw new AgentGitError(
        "Brokered credential profile does not satisfy the required scope.",
        "BROKER_UNAVAILABLE",
        {
          integration,
          required_scope: params.required_scope,
          profile_id: profile.profile_id,
        },
      );
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

  durableSecretStorageDetails(): {
    mode: "local_encrypted_store";
    provider: SecretKeyProviderKind;
    key_identifier: string;
    legacy_key_path: string | null;
  } | null {
    if (!this.mcpSecretStore) {
      return null;
    }

    return {
      mode: "local_encrypted_store",
      ...this.mcpSecretStore.storageDetails(),
    };
  }

  listMcpBearerSecrets(): McpBearerSecretMetadata[] {
    return this.mcpSecretStore?.listMcpBearerSecrets() ?? [];
  }

  upsertMcpBearerSecret(input: {
    secret_id: string;
    bearer_token: string;
    display_name?: string;
    expires_at?: string;
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

  resolveRuntimeCredentialBinding(binding: RuntimeCredentialBindingRecord): ResolvedRuntimeCredentialBinding {
    if (!this.mcpSecretStore) {
      throw new AgentGitError("Durable MCP secret storage is not available on this host.", "BROKER_UNAVAILABLE");
    }

    return this.mcpSecretStore.resolveRuntimeCredentialBinding(binding);
  }

  checkpointMcpSecretStore() {
    return this.mcpSecretStore?.checkpointWal() ?? null;
  }

  close(): void {
    this.mcpSecretStore?.close();
  }
}
