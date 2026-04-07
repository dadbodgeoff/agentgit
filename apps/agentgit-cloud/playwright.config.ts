import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "@playwright/test";

const port = 3100;
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../..");
const e2eRoot = path.join(repoRoot, ".tmp", "agentgit-cloud-playwright-root");
const host = "localhost";
const bootstrapCommand = `node -e 'const fs=require("node:fs"); const root=${JSON.stringify(
  e2eRoot,
)}; fs.rmSync(root,{recursive:true,force:true}); fs.mkdirSync(root,{recursive:true});'`;
const webServerCommand = `${bootstrapCommand} && AUTH_SECRET=agentgit-cloud-e2e-secret AUTH_URL=http://${host}:${port} NEXTAUTH_URL=http://${host}:${port} AUTH_TRUST_HOST=true AUTH_ENABLE_DEV_CREDENTIALS=true AUTH_WORKSPACE_ID=ws_e2e_01 AUTH_WORKSPACE_NAME='E2E Workspace' AUTH_WORKSPACE_SLUG=e2e-workspace AGENTGIT_ROOT=${JSON.stringify(
  e2eRoot,
)} AGENTGIT_CLOUD_WORKSPACE_ROOTS=${JSON.stringify(repoRoot)} AGENTGIT_CLOUD_LOG_LEVEL=error pnpm exec next dev --hostname ${host} --port ${port}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  retries: 0,
  use: {
    baseURL: `http://${host}:${port}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: webServerCommand,
    cwd: currentDir,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
    url: `http://${host}:${port}/sign-in`,
  },
  workers: 1,
});
