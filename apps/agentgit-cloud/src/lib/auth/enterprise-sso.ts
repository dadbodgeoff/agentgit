import "server-only";

import type { ActiveWorkspace, WorkspaceRole } from "@/schemas/cloud";

import {
  findStoredWorkspaceSettingsBySlug,
  getWorkspaceConnectionState,
  getWorkspaceSsoSecrets,
  provisionWorkspaceMembershipForIdentity,
} from "@/lib/backend/workspace/cloud-state";
import { buildEnterpriseProviderId, ENTERPRISE_PROVIDER_PREFIX } from "@/lib/auth/provider-config";
export { buildEnterpriseProviderId };

export type ResolvedEnterpriseWorkspaceAccess = {
  activeWorkspace: ActiveWorkspace;
  role: WorkspaceRole;
  source: "member" | "invite";
};

function normalizeEmail(value?: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function getEmailDomain(email: string): string {
  return email.split("@")[1]?.trim().toLowerCase() ?? "";
}

export function parseEnterpriseProviderId(providerId?: string | null): string | null {
  if (!providerId?.startsWith(ENTERPRISE_PROVIDER_PREFIX)) {
    return null;
  }

  const slug = providerId.slice(ENTERPRISE_PROVIDER_PREFIX.length).trim().toLowerCase();
  return slug.length > 0 ? slug : null;
}

function parseEnterpriseProviderIdFromPathname(pathname: string): string | null {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  const providerId = segments[segments.length - 1] ?? null;
  return parseEnterpriseProviderId(providerId);
}

function toRequestUrl(request: Request | undefined): URL | null {
  if (!request) {
    return null;
  }

  return new URL(request.url);
}

export async function getEnterpriseSsoProviderFromRequest(request: Request | undefined) {
  const url = toRequestUrl(request);
  if (!url) {
    return null;
  }

  const workspaceSlug = parseEnterpriseProviderIdFromPathname(url.pathname);
  if (!workspaceSlug) {
    return null;
  }

  const workspaceSettings = await findStoredWorkspaceSettingsBySlug(workspaceSlug);
  if (!workspaceSettings?.settings.enterpriseSso.enabled) {
    return null;
  }

  const secrets = await getWorkspaceSsoSecrets(workspaceSettings.workspaceId);
  if (!secrets?.clientSecret) {
    return null;
  }

  const settings = workspaceSettings.settings.enterpriseSso;

  return {
    provider: {
      id: buildEnterpriseProviderId(workspaceSlug),
      name: settings.providerLabel,
      type: "oidc" as const,
      issuer: settings.issuerUrl,
      clientId: settings.clientId,
      clientSecret: secrets.clientSecret,
      authorization: {
        params: {
          scope: "openid profile email",
        },
      },
      profile(profile: Record<string, unknown>) {
        const email = typeof profile.email === "string" ? profile.email : null;
        const name =
          typeof profile.name === "string" && profile.name.trim().length > 0
            ? profile.name
            : typeof profile.preferred_username === "string" && profile.preferred_username.trim().length > 0
              ? profile.preferred_username
              : (email ?? settings.providerLabel);

        return {
          id:
            typeof profile.sub === "string" && profile.sub.trim().length > 0
              ? profile.sub
              : (email ?? buildEnterpriseProviderId(workspaceSlug)),
          email,
          name,
          image: null,
        };
      },
    },
    workspaceId: workspaceSettings.workspaceId,
    workspaceSlug,
    settings,
  };
}

export async function resolveEnterpriseWorkspaceAccessForIdentity(params: {
  workspaceSlug: string;
  email?: string | null;
  name: string;
  imageUrl?: string | null;
}): Promise<ResolvedEnterpriseWorkspaceAccess | null> {
  const workspace = await findStoredWorkspaceSettingsBySlug(params.workspaceSlug);
  const email = normalizeEmail(params.email);
  if (!workspace || !workspace.settings.enterpriseSso.enabled || !email) {
    return null;
  }

  const workspaceState = await getWorkspaceConnectionState(workspace.workspaceId);
  if (!workspaceState) {
    return null;
  }

  const member = workspaceState.members.find((entry) => normalizeEmail(entry.email) === email);
  const invite = workspaceState.invites.find((entry) => normalizeEmail(entry.email) === email);
  const emailDomain = getEmailDomain(email);
  const allowedDomains = workspace.settings.enterpriseSso.emailDomains.map((domain) => domain.toLowerCase());
  const domainAllowed = allowedDomains.includes(emailDomain);

  if (!member && !invite) {
    if (!workspace.settings.enterpriseSso.autoProvisionMembers || !domainAllowed) {
      return null;
    }
  }

  const provisioned = await provisionWorkspaceMembershipForIdentity({
    workspaceId: workspace.workspaceId,
    email,
    name: params.name,
    imageUrl: params.imageUrl,
    fallbackRole: workspace.settings.enterpriseSso.defaultRole,
  });

  if (!provisioned) {
    return null;
  }

  return {
    activeWorkspace: {
      id: provisioned.workspaceId,
      name: provisioned.workspaceName,
      slug: provisioned.workspaceSlug,
      role: provisioned.role,
    },
    role: provisioned.role,
    source: provisioned.source,
  };
}
