import { defineConfig } from "@playwright/test";

import baseConfig from "./playwright.config";

export default defineConfig({
  ...baseConfig,
  testIgnore: [],
  testMatch: /visual-regression\.spec\.ts/,
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
});
