import path from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@agentgit/authority-daemon": path.resolve(packageRoot, "../authority-daemon/src/index.ts"),
    },
  },
});
