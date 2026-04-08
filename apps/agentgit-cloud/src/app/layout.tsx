import type { ReactNode } from "react";
import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";

import "@/styles/globals.css";
import {
  AGENTGIT_DEFAULT_DESCRIPTION,
  AGENTGIT_DEFAULT_KEYWORDS,
  AGENTGIT_OG_IMAGE_PATH,
  AGENTGIT_SITE_NAME,
  resolveMetadataBase,
} from "@/lib/metadata/site";

const plexSans = IBM_Plex_Sans({
  subsets: ["latin"],
  variable: "--font-plex-sans",
  weight: ["400", "500", "600", "700"],
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-plex-mono",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  metadataBase: resolveMetadataBase(),
  title: {
    default: "AgentGit Cloud",
    template: "%s | AgentGit",
  },
  description: AGENTGIT_DEFAULT_DESCRIPTION,
  keywords: AGENTGIT_DEFAULT_KEYWORDS,
  openGraph: {
    title: "AgentGit Cloud",
    description: AGENTGIT_DEFAULT_DESCRIPTION,
    type: "website",
    locale: "en_US",
    siteName: AGENTGIT_SITE_NAME,
    images: [
      {
        url: AGENTGIT_OG_IMAGE_PATH,
        alt: "AgentGit Cloud",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "AgentGit Cloud",
    description: AGENTGIT_DEFAULT_DESCRIPTION,
    images: [AGENTGIT_OG_IMAGE_PATH],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html className={`${plexSans.variable} ${plexMono.variable}`} lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
