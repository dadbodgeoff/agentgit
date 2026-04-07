import NextAuth, { type NextAuthResult } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import { z } from "zod";

import {
  DEVELOPMENT_PROVIDER_ID,
  authFeatureFlags,
  getDefaultWorkspaceRole,
  getFallbackActiveWorkspace,
  isProductionAuth,
} from "@/lib/auth/provider-config";
import { resolveWorkspaceAccessForIdentity } from "@/lib/auth/workspace-access";
import { publicRoutes } from "@/lib/navigation/routes";
import { WorkspaceRoleSchema } from "@/schemas/cloud";

const developmentCredentialsSchema = z.object({
  email: z.string().email().optional(),
  name: z.string().trim().min(1),
  role: WorkspaceRoleSchema.default(getDefaultWorkspaceRole()),
});

function buildActiveWorkspace(role = getDefaultWorkspaceRole()) {
  return getFallbackActiveWorkspace(role);
}

async function fetchGitHubPrimaryEmail(accessToken?: string): Promise<string | null> {
  if (!accessToken) {
    return null;
  }

  const response = await fetch("https://api.github.com/user/emails", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
    },
    cache: "no-store",
  }).catch(() => null);

  if (!response?.ok) {
    return null;
  }

  const payload = (await response.json().catch(() => null)) as
    | Array<{ email?: string; primary?: boolean; verified?: boolean }>
    | null;

  if (!Array.isArray(payload)) {
    return null;
  }

  const primaryVerified = payload.find((entry) => entry.primary && entry.verified && typeof entry.email === "string");
  if (primaryVerified?.email) {
    return primaryVerified.email;
  }

  const verified = payload.find((entry) => entry.verified && typeof entry.email === "string");
  return verified?.email ?? null;
}

function getGitHubLogin(profile: unknown): string | null {
  if (!profile || typeof profile !== "object" || !("login" in profile)) {
    return null;
  }

  return typeof profile.login === "string" && profile.login.trim().length > 0 ? profile.login : null;
}

const providers = [];

if (authFeatureFlags.hasGitHubProvider) {
  providers.push(
    GitHub({
      authorization: {
        params: {
          scope: "read:user user:email",
        },
      },
      profile(profile) {
        const login = typeof profile.login === "string" ? profile.login : undefined;

        return {
          email: typeof profile.email === "string" ? profile.email : null,
          id: String(profile.id),
          image: typeof profile.avatar_url === "string" ? profile.avatar_url : null,
          login,
          name: typeof profile.name === "string" && profile.name.trim().length > 0 ? profile.name : login ?? "GitHub user",
        };
      },
    }),
  );
}

if (authFeatureFlags.enableDevelopmentCredentials) {
  providers.push(
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        name: { label: "Name", type: "text" },
        role: { label: "Role", type: "text" },
      },
      id: DEVELOPMENT_PROVIDER_ID,
      name: "Development access",
      async authorize(rawCredentials) {
        const parsed = developmentCredentialsSchema.safeParse(rawCredentials);

        if (!parsed.success) {
          return null;
        }

        const activeWorkspace = buildActiveWorkspace(parsed.data.role);

        return {
          activeWorkspace,
          email: parsed.data.email ?? "developer@agentgit.dev",
          id: parsed.data.email ?? parsed.data.name.toLowerCase().replace(/\s+/g, "-"),
          name: parsed.data.name,
          role: parsed.data.role,
        };
      },
    }),
  );
}

const authSecret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
const isNextProductionBuild = process.env.NEXT_PHASE === "phase-production-build";

if (isProductionAuth && !authSecret && !isNextProductionBuild) {
  throw new Error("AUTH_SECRET or NEXTAUTH_SECRET must be set in production.");
}

if (isProductionAuth && providers.length === 0 && !isNextProductionBuild) {
  throw new Error("At least one production authentication provider must be configured.");
}

const nextAuthResult: NextAuthResult = NextAuth({
  callbacks: {
    async signIn({ user, account, profile }) {
      if (account?.provider !== "github") {
        return true;
      }

      const email = user.email ?? (await fetchGitHubPrimaryEmail(typeof account.access_token === "string" ? account.access_token : undefined));
      const login = getGitHubLogin(profile);

      if (!email) {
        return false;
      }

      const workspaceAccess = resolveWorkspaceAccessForIdentity({ email, login });
      if (!workspaceAccess) {
        return false;
      }

      user.email = email;
      user.role = workspaceAccess.role;
      user.activeWorkspace = workspaceAccess.activeWorkspace;
      return true;
    },
    jwt({ token, user }) {
      if (user) {
        if (user.role && user.activeWorkspace) {
          token.role = user.role;
          token.activeWorkspace = user.activeWorkspace;
        } else {
          delete token.role;
          delete token.activeWorkspace;
        }
      }

      return token;
    },
    session({ session, token }) {
      session.user.id = token.sub ?? session.user.email ?? "user_unknown";
      if (token.role) {
        session.user.role = token.role;
      }
      if (token.activeWorkspace) {
        session.activeWorkspace = token.activeWorkspace;
      }

      return session;
    },
  },
  pages: {
    signIn: publicRoutes.signIn,
  },
  providers,
  secret: authSecret ?? (isNextProductionBuild ? "agentgit-cloud-build-secret" : "agentgit-cloud-dev-secret"),
  session: {
    strategy: "jwt",
  },
  trustHost: true,
});

export const handlers: NextAuthResult["handlers"] = nextAuthResult.handlers;
export const auth: NextAuthResult["auth"] = nextAuthResult.auth;
export const signIn: NextAuthResult["signIn"] = nextAuthResult.signIn;
export const signOut: NextAuthResult["signOut"] = nextAuthResult.signOut;
