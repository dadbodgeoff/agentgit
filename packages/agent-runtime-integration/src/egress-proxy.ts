import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { URL } from "node:url";

import { AgentGitError } from "@agentgit/schemas";

interface HostRule {
  host: string;
  port?: number;
}

export interface EgressProxyHandle {
  port: number;
  close(): Promise<void>;
}

function parseHostRule(input: string): HostRule {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) {
    throw new AgentGitError("Contained egress host entries may not be empty.", "BAD_REQUEST", {
      value: input,
    });
  }
  const parts = trimmed.split(":");
  if (parts.length > 2) {
    throw new AgentGitError("Contained egress host entries must use host or host:port form.", "BAD_REQUEST", {
      value: input,
    });
  }
  const host = parts[0]!.replace(/\.$/, "");
  const port = parts[1] ? Number(parts[1]) : undefined;
  if (
    host.length === 0 ||
    (!net.isIP(host) && (!/^[a-z0-9.-]+$/.test(host) || host.startsWith(".") || host.endsWith(".") || !host.includes(".")))
  ) {
    throw new AgentGitError("Contained egress host entry is malformed.", "BAD_REQUEST", {
      value: input,
    });
  }
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new AgentGitError("Contained egress host port is malformed.", "BAD_REQUEST", {
      value: input,
    });
  }
  return {
    host,
    port,
  };
}

function isAllowed(rules: HostRule[], host: string, port?: number): boolean {
  const normalizedHost = host.toLowerCase().replace(/\.$/, "");
  return rules.some((rule) => rule.host === normalizedHost && (rule.port === undefined || rule.port === port));
}

function mapSpecialHost(host: string): string {
  if (host === "host.docker.internal" || host === "localhost") {
    return "127.0.0.1";
  }
  return host;
}

async function resolvePinnedAddress(host: string): Promise<string> {
  const mappedHost = mapSpecialHost(host.toLowerCase().replace(/\.$/, ""));
  if (net.isIP(mappedHost)) {
    return mappedHost;
  }

  const resolved = await dns.lookup(mappedHost, { all: false, verbatim: true });
  return resolved.address;
}

export async function startContainedEgressProxy(allowlistHosts: string[]): Promise<EgressProxyHandle> {
  const rules = allowlistHosts.map((entry) => parseHostRule(entry));
  const server = http.createServer(async (request, response) => {
    if (!request.url) {
      response.writeHead(400).end("missing target url");
      return;
    }

    let target: URL;
    try {
      target = new URL(request.url);
    } catch {
      response.writeHead(400).end("malformed proxy url");
      return;
    }

    const targetPort = target.port.length > 0 ? Number(target.port) : target.protocol === "https:" ? 443 : 80;
    if (!isAllowed(rules, target.hostname, targetPort)) {
      response.writeHead(403).end("host not allowlisted");
      return;
    }

    const transport = target.protocol === "https:" ? https : http;
    const pinnedAddress = await resolvePinnedAddress(target.hostname).catch(() => null);
    if (!pinnedAddress) {
      response.writeHead(502).end("could not resolve allowlisted host");
      return;
    }

    const upstream = transport.request({
      protocol: target.protocol,
      hostname: pinnedAddress,
      port: targetPort,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      servername: target.hostname,
      headers: {
        ...request.headers,
        host: target.host,
      },
    });
    upstream.on("response", (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", (error) => {
      response.writeHead(502).end(error.message);
    });
    request.pipe(upstream);
  });

  server.on("connect", (request, clientSocket, head) => {
    const [host, portText] = (request.url ?? "").split(":");
    const port = Number(portText);
    if (!host || !Number.isInteger(port) || !isAllowed(rules, host, port)) {
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.destroy();
      return;
    }

    void resolvePinnedAddress(host)
      .then((pinnedAddress) => {
        const upstreamSocket = net.connect({
          host: pinnedAddress,
          port,
        });
        upstreamSocket.on("connect", () => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) {
            upstreamSocket.write(head);
          }
          upstreamSocket.pipe(clientSocket);
          clientSocket.pipe(upstreamSocket);
        });
        upstreamSocket.on("error", () => {
          clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
          clientSocket.destroy();
        });
      })
      .catch(() => {
        clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        clientSocket.destroy();
      });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new AgentGitError("Contained egress proxy failed to bind a TCP port.", "CAPABILITY_UNAVAILABLE");
  }

  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}
