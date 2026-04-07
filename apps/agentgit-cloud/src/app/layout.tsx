import type { ReactNode } from "react";
import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans } from "next/font/google";

import { AppProviders } from "@/components/providers/app-providers";
import "@/styles/globals.css";

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
  title: "AgentGit Cloud",
  description: "Hosted governance dashboard for autonomous development workflows.",
};

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html className={`${plexSans.variable} ${plexMono.variable}`} lang="en">
      <body>
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
