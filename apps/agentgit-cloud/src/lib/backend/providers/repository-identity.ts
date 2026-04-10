import "server-only";

import {
  ProviderRepositoryIdentitySchema,
  type CloudProvider,
  type ProviderRepositoryIdentity,
} from "@agentgit/cloud-sync-protocol";

type RepositoryIdentityInput = {
  provider: CloudProvider;
  owner: string;
  name: string;
  defaultBranch: string;
};

type GitHubRepositoryResponse = {
  id?: number;
  node_id?: string;
  html_url?: string;
  private?: boolean;
  visibility?: "public" | "private" | "internal";
  default_branch?: string;
  name?: string;
  owner?: {
    login?: string;
  };
  message?: string;
};

function parseGitHubRepositoryResponse(value: unknown): GitHubRepositoryResponse | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const ownerRecord =
    record.owner && typeof record.owner === "object" ? (record.owner as Record<string, unknown>) : null;

  return {
    id: typeof record.id === "number" ? record.id : undefined,
    node_id: typeof record.node_id === "string" ? record.node_id : undefined,
    html_url: typeof record.html_url === "string" ? record.html_url : undefined,
    private: typeof record.private === "boolean" ? record.private : undefined,
    visibility:
      record.visibility === "public" || record.visibility === "private" || record.visibility === "internal"
        ? record.visibility
        : undefined,
    default_branch: typeof record.default_branch === "string" ? record.default_branch : undefined,
    name: typeof record.name === "string" ? record.name : undefined,
    owner: ownerRecord && typeof ownerRecord.login === "string" ? { login: ownerRecord.login } : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
  };
}

const PROVIDER_IDENTITY_CACHE_TTL_MS = 60_000;
const providerIdentityCache = new Map<string, { expiresAt: number; value: ProviderRepositoryIdentity }>();

function getGitHubAccessToken(): string | null {
  const token = process.env.AGENTGIT_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN ?? null;
  return token && token.trim().length > 0 ? token.trim() : null;
}

function cacheKey(input: RepositoryIdentityInput) {
  return `${input.provider}:${input.owner}/${input.name}:${input.defaultBranch}`;
}

export function buildLocalProviderRepositoryIdentity(
  input: RepositoryIdentityInput,
  overrides: Partial<ProviderRepositoryIdentity> = {},
): ProviderRepositoryIdentity {
  return ProviderRepositoryIdentitySchema.parse({
    provider: input.provider,
    status: "local_only",
    owner: input.owner,
    name: input.name,
    defaultBranch: input.defaultBranch,
    repositoryUrl: null,
    visibility: "unknown",
    externalId: null,
    verifiedAt: null,
    statusReason: null,
    ...overrides,
  });
}

async function resolveGitHubIdentity(input: RepositoryIdentityInput): Promise<ProviderRepositoryIdentity> {
  const token = getGitHubAccessToken();
  if (!token) {
    return buildLocalProviderRepositoryIdentity(input, {
      statusReason:
        "Provider verification is unavailable because no GitHub API token is configured in the cloud environment.",
    });
  }

  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${input.owner}/${input.name}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    });
  } catch (error) {
    return buildLocalProviderRepositoryIdentity(input, {
      status: "unreachable",
      statusReason: error instanceof Error ? error.message : "GitHub repository verification failed.",
    });
  }

  const verifiedAt = new Date().toISOString();
  if (!response.ok) {
    let details: string | null = null;
    try {
      details = parseGitHubRepositoryResponse(await response.json())?.message ?? null;
    } catch {
      details = null;
    }

    return buildLocalProviderRepositoryIdentity(input, {
      status: response.status === 404 ? "drifted" : "unreachable",
      verifiedAt,
      statusReason:
        response.status === 404
          ? `GitHub repository ${input.owner}/${input.name} was not found during provider verification.`
          : `GitHub repository verification failed with ${response.status}${details ? `: ${details}` : ""}.`,
    });
  }

  const parsed = parseGitHubRepositoryResponse(await response.json());
  if (!parsed) {
    return buildLocalProviderRepositoryIdentity(input, {
      status: "unreachable",
      verifiedAt,
      statusReason: "GitHub repository verification returned an unexpected payload.",
    });
  }
  const providerOwner = parsed.owner?.login ?? input.owner;
  const providerName = parsed.name ?? input.name;
  const providerDefaultBranch = parsed.default_branch ?? input.defaultBranch;
  const driftReasons: string[] = [];

  if (providerOwner !== input.owner || providerName !== input.name) {
    driftReasons.push(`Provider canonical name is ${providerOwner}/${providerName}.`);
  }
  if (providerDefaultBranch !== input.defaultBranch) {
    driftReasons.push(
      `Provider default branch is ${providerDefaultBranch}, local metadata reported ${input.defaultBranch}.`,
    );
  }

  return ProviderRepositoryIdentitySchema.parse({
    provider: "github",
    status: driftReasons.length > 0 ? "drifted" : "verified",
    owner: providerOwner,
    name: providerName,
    defaultBranch: providerDefaultBranch,
    repositoryUrl: parsed.html_url ?? null,
    visibility: parsed.visibility ?? (parsed.private ? "private" : "public"),
    externalId: parsed.node_id ?? (typeof parsed.id === "number" ? String(parsed.id) : null),
    verifiedAt,
    statusReason: driftReasons.length > 0 ? driftReasons.join(" ") : null,
  });
}

export async function resolveProviderRepositoryIdentity(
  input: RepositoryIdentityInput,
): Promise<ProviderRepositoryIdentity> {
  const key = cacheKey(input);
  const cached = providerIdentityCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let value: ProviderRepositoryIdentity;
  switch (input.provider) {
    case "github":
      value = await resolveGitHubIdentity(input);
      break;
    case "gitlab":
    case "bitbucket":
      value = buildLocalProviderRepositoryIdentity(input, {
        statusReason: `${input.provider} verification is not configured in the cloud control plane yet.`,
      });
      break;
    default:
      value = buildLocalProviderRepositoryIdentity(input, {
        statusReason: "Repository identity is being derived from local git metadata.",
      });
      break;
  }

  providerIdentityCache.set(key, {
    expiresAt: Date.now() + PROVIDER_IDENTITY_CACHE_TTL_MS,
    value,
  });
  return value;
}
