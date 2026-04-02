#!/usr/bin/env node

import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(packageRoot, "..", "..");
const distDir = path.join(packageRoot, "dist");
const hostedWorkerRoot = path.join(packageRoot, "..", "hosted-mcp-worker");
const hostedWorkerDistDir = path.join(hostedWorkerRoot, "dist");
const embeddedHostedWorkerDistDir = path.join(distDir, "hosted-mcp-worker");
const esmRequireBanner =
  'import { createRequire as __agentgitCreateRequire } from "node:module"; const require = __agentgitCreateRequire(import.meta.url);';

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? packageRoot,
      stdio: "inherit",
      env: process.env,
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} ${args.join(" ")} failed with exit code ${code ?? -1}.`));
    });
  });
}

await runCommand("pnpm", ["exec", "turbo", "run", "build", "--filter=@agentgit/authority-daemon^..."], {
  cwd: repoRoot,
});
await fsp.rm(distDir, { recursive: true, force: true });
await runCommand("pnpm", ["exec", "tsc", "-p", "tsconfig.json", "--emitDeclarationOnly"]);
await runCommand("pnpm", ["build"], {
  cwd: hostedWorkerRoot,
});
await esbuild.build({
  entryPoints: {
    index: path.join(packageRoot, "src", "index.ts"),
    main: path.join(packageRoot, "src", "main.ts"),
  },
  outdir: distDir,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: true,
  logLevel: "silent",
  legalComments: "none",
  banner: {
    js: esmRequireBanner,
  },
  external: ["better-sqlite3"],
});

await fsp.rm(embeddedHostedWorkerDistDir, { recursive: true, force: true });
await fsp.mkdir(embeddedHostedWorkerDistDir, { recursive: true });
await esbuild.build({
  entryPoints: [path.join(hostedWorkerRoot, "src", "main.ts")],
  outfile: path.join(embeddedHostedWorkerDistDir, "main.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  sourcemap: true,
  logLevel: "silent",
  legalComments: "none",
  banner: {
    js: esmRequireBanner,
  },
});
for (const filename of ["main.d.ts", "main.d.ts.map"]) {
  const sourcePath = path.join(hostedWorkerDistDir, filename);
  const destinationPath = path.join(embeddedHostedWorkerDistDir, filename);
  await fsp.copyFile(sourcePath, destinationPath);
}

const bundledMainPath = path.join(distDir, "main.js");
const bundledMainContent = await fsp.readFile(bundledMainPath, "utf8");
if (!bundledMainContent.startsWith("#!/usr/bin/env node")) {
  await fsp.writeFile(bundledMainPath, `#!/usr/bin/env node\n${bundledMainContent}`, "utf8");
}
