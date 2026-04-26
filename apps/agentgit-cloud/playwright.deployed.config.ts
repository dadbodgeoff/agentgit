import { defineConfig } from "@playwright/test";

const baseURL = process.env.AGENTGIT_CLOUD_E2E_BASE_URL?.trim();

if (!baseURL) {
  throw new Error("Set AGENTGIT_CLOUD_E2E_BASE_URL to the deployed AgentGit Cloud origin before running this smoke.");
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: /deployed-smoke\.spec\.ts/,
  fullyParallel: false,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-deployed" }]],
  retries: 1,
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  workers: 1,
});
