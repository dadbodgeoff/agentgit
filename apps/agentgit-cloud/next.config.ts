import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

import { buildSecurityHeaders } from "./src/lib/security/http";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: [
    "@agentgit/control-plane-state",
    "@agentgit/integration-state",
    "@agentgit/run-journal",
    "@agentgit/snapshot-engine",
    "@agentgit/workspace-index",
    "better-sqlite3",
  ],
  transpilePackages: ["@agentgit/schemas"],
  webpack(config, { isServer }) {
    if (isServer) {
      config.externals = [
        ...(Array.isArray(config.externals) ? config.externals : [config.externals].filter(Boolean)),
        {
          "better-sqlite3": "commonjs better-sqlite3",
        },
      ];
    }

    return config;
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: buildSecurityHeaders(),
      },
    ];
  },
};

export default withSentryConfig(
  nextConfig,
  {
    authToken: process.env.SENTRY_AUTH_TOKEN,
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    silent: true,
  },
  {
    disableLogger: true,
    hideSourceMaps: true,
    widenClientFileUpload: true,
  },
);
