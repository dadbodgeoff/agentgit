import type { Metadata } from "next";

export const AGENTGIT_SITE_NAME = "AgentGit";
export const AGENTGIT_OG_IMAGE_PATH = "/og-default.svg";
export const AGENTGIT_DEFAULT_DESCRIPTION =
  "AgentGit Cloud is the hosted control plane for governed agent workflows, approvals, audit trails, connector health, and recovery context.";
export const AGENTGIT_DEFAULT_KEYWORDS = [
  "AgentGit",
  "AgentGit Cloud",
  "AI agent governance",
  "approval workflow",
  "developer audit trail",
  "connector fleet",
  "autonomous development",
  "governed automation",
  "software delivery control plane",
];

export function resolveMetadataBase(): URL | undefined {
  const candidates = [process.env.AUTH_URL, process.env.NEXTAUTH_URL];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    try {
      return new URL(candidate);
    } catch {
      continue;
    }
  }

  return new URL("http://localhost:3000");
}

export function buildPageMetadata(input: {
  title: string;
  description: string;
  keywords?: string[];
  path?: string;
}): Metadata {
  return {
    title: input.title,
    description: input.description,
    keywords: input.keywords ?? AGENTGIT_DEFAULT_KEYWORDS,
    alternates: input.path
      ? {
          canonical: input.path,
        }
      : undefined,
    openGraph: {
      title: input.title,
      description: input.description,
      type: "website",
      locale: "en_US",
      siteName: AGENTGIT_SITE_NAME,
      url: input.path,
      images: [
        {
          url: AGENTGIT_OG_IMAGE_PATH,
          alt: "AgentGit Cloud",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: input.title,
      description: input.description,
      images: [AGENTGIT_OG_IMAGE_PATH],
    },
  };
}
