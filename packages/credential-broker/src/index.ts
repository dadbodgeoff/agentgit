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

export class SessionCredentialBroker {
  private readonly profilesByIntegration = new Map<string, BearerCredentialProfile>();

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
}
