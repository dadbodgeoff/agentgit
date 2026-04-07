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

const providers = [];

if (authFeatureFlags.hasGitHubProvider) {
  providers.push(GitHub);
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
    jwt({ token, user }) {
      if (user) {
        token.role = user.role ?? getDefaultWorkspaceRole();
        token.activeWorkspace = user.activeWorkspace ?? buildActiveWorkspace(token.role);
      }

      if (!token.role) {
        token.role = getDefaultWorkspaceRole();
      }

      if (!token.activeWorkspace) {
        token.activeWorkspace = buildActiveWorkspace(token.role);
      }

      return token;
    },
    session({ session, token }) {
      session.user.id = token.sub ?? session.user.email ?? "user_unknown";
      session.user.role = token.role ?? getDefaultWorkspaceRole();
      session.activeWorkspace = token.activeWorkspace ?? buildActiveWorkspace(session.user.role);

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
