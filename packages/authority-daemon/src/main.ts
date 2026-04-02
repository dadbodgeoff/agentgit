#!/usr/bin/env node

import { runAuthorityDaemonFromEnv } from "./index.js";

await runAuthorityDaemonFromEnv({
  registerSignalHandlers: true,
});
