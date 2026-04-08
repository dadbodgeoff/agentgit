import { startHostedMcpWorkerServer } from "./index.js";

const endpoint = process.env.AGENTGIT_HOSTED_MCP_WORKER_ENDPOINT;
const attestationKeyPath = process.env.AGENTGIT_HOSTED_MCP_WORKER_ATTESTATION_KEY_PATH;
const controlToken = process.env.AGENTGIT_HOSTED_MCP_WORKER_CONTROL_TOKEN ?? null;
const workerImageDigest = process.env.AGENTGIT_HOSTED_MCP_WORKER_IMAGE_DIGEST ?? undefined;

if (!endpoint) {
  throw new Error("AGENTGIT_HOSTED_MCP_WORKER_ENDPOINT is required.");
}

if (!attestationKeyPath) {
  throw new Error("AGENTGIT_HOSTED_MCP_WORKER_ATTESTATION_KEY_PATH is required.");
}

const server = await startHostedMcpWorkerServer({
  endpoint,
  attestationKeyPath,
  controlToken,
  workerImageDigest,
});

process.stdout.write(
  `${JSON.stringify({
    status: "listening",
    endpoint,
  })}\n`,
);

const shutdown = () => {
  server.close(() => {
    process.exit(0);
  });
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
