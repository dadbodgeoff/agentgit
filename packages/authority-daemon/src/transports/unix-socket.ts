import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import type { RequestContext, TransportHandler, TransportListener } from "@agentgit/core-ports";
import { ValidationError } from "@agentgit/schemas";

import { makeErrorResponse } from "../app/response-helpers.js";

export interface UnixSocketTransportOptions {
  socketPath: string;
}

const SOCKET_IDLE_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 10_000_000;
const SOCKET_PROBE_TIMEOUT_MS = 200;
const SOCKET_RESPONSE_CHUNK_BYTES = 4_096;
const PEER_CREDENTIALS_SCRIPT = String.raw`
import ctypes
import ctypes.util
import json
import platform
import socket
import struct
import sys

fd = 3
result = {}
system = platform.system()
libc = ctypes.CDLL(ctypes.util.find_library("c") or None, use_errno=True)

if system == "Darwin":
    uid = ctypes.c_uint()
    gid = ctypes.c_uint()
    rc = libc.getpeereid(fd, ctypes.byref(uid), ctypes.byref(gid))
    if rc != 0:
        errno = ctypes.get_errno()
        raise OSError(errno, "getpeereid failed")
    result = {"uid": uid.value, "gid": gid.value}
elif hasattr(socket, "SO_PEERCRED"):
    sock = socket.socket(fileno=fd)
    packed = sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
    pid, uid, gid = struct.unpack("3i", packed)
    result = {"pid": pid, "uid": uid, "gid": gid}
else:
    raise RuntimeError(f"Unsupported platform for unix peer credential checks: {system}")

sys.stdout.write(json.dumps(result))
`;

interface PeerCredentials {
  uid: number;
  gid: number;
  pid?: number;
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function closeSocketWithJsonLine(socket: net.Socket, response: unknown): void {
  if (socket.destroyed || socket.writableEnded) {
    return;
  }

  const payload = `${JSON.stringify(response)}\n`;
  let offset = 0;

  const finish = (): void => {
    if (!socket.destroyed && !socket.writableEnded) {
      socket.end();
    }
  };

  const writeNextChunk = (): void => {
    if (socket.destroyed || socket.writableEnded) {
      return;
    }

    const nextOffset = Math.min(offset + SOCKET_RESPONSE_CHUNK_BYTES, payload.length);
    const chunk = payload.slice(offset, nextOffset);
    offset = nextOffset;

    const writable = socket.write(chunk);
    if (offset >= payload.length) {
      if (writable) {
        finish();
      } else {
        socket.once("drain", finish);
      }
      return;
    }

    if (writable) {
      setImmediate(writeNextChunk);
    } else {
      socket.once("drain", writeNextChunk);
    }
  };

  writeNextChunk();
}

function ensurePrivateSocketDirectory(socketDir: string): void {
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(socketDir, 0o700);
  const stats = fs.lstatSync(socketDir);
  if (!stats.isDirectory()) {
    throw new Error(`Authority socket parent is not a directory: ${socketDir}`);
  }

  const uid = currentUid();
  if (uid !== null && stats.uid !== uid) {
    throw new Error(`Authority socket parent is not owned by the daemon user: ${socketDir}`);
  }
}

function removeFileIfExists(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function resolvePeerCredentials(socket: net.Socket): PeerCredentials {
  const fd = (socket as net.Socket & { _handle?: { fd?: unknown } })._handle?.fd;
  if (!Number.isInteger(fd) || (fd as number) < 0) {
    throw new Error("Authority daemon could not resolve the accepted socket file descriptor.");
  }

  for (const command of ["python3", "python"] as const) {
    const result = spawnSync(command, ["-c", PEER_CREDENTIALS_SCRIPT], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe", fd as number],
      timeout: SOCKET_IDLE_TIMEOUT_MS,
    });

    if (result.error && "code" in result.error && result.error.code === "ENOENT") {
      continue;
    }

    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      throw new Error(result.stderr.trim() || `Failed to resolve peer credentials via ${command}.`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(
        `Peer credential helper returned malformed JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const uid = typeof (parsed as { uid?: unknown }).uid === "number" ? (parsed as { uid: number }).uid : null;
    const gid = typeof (parsed as { gid?: unknown }).gid === "number" ? (parsed as { gid: number }).gid : null;
    const pid = typeof (parsed as { pid?: unknown }).pid === "number" ? (parsed as { pid: number }).pid : undefined;
    if (uid === null || gid === null) {
      throw new Error("Peer credential helper did not return uid/gid.");
    }

    return { uid, gid, ...(pid !== undefined ? { pid } : {}) };
  }

  throw new Error("Authority daemon requires python to validate unix peer credentials.");
}

async function socketPathIsActive(socketPath: string): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = net.createConnection(socketPath);
    let settled = false;

    const finish = (value: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      probe.destroy();
      resolve(value);
    };

    probe.setTimeout(SOCKET_PROBE_TIMEOUT_MS, () => finish(false));
    probe.once("connect", () => finish(true));
    probe.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ECONNREFUSED" || code === "ENOENT") {
        finish(false);
        return;
      }

      finish(true);
    });
  });
}

async function removeStaleSocketIfPresent(socketPath: string): Promise<void> {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }

  if (!stats.isSocket()) {
    throw new Error(`Refusing to replace non-socket authority endpoint: ${socketPath}`);
  }

  const uid = currentUid();
  if (uid !== null && stats.uid !== uid) {
    throw new Error(`Refusing to replace authority socket owned by another user: ${socketPath}`);
  }

  if (await socketPathIsActive(socketPath)) {
    throw new Error(`Authority socket path is already in use: ${socketPath}`);
  }

  removeFileIfExists(socketPath);
}

export function resolveUnixSocketAuthTokenPath(socketPath: string): string {
  return `${socketPath}.token`;
}

export class UnixSocketTransport implements TransportListener {
  private server: net.Server | null = null;
  private readonly openSockets = new Set<net.Socket>();

  constructor(private readonly options: UnixSocketTransportOptions) {}

  async listen(handler: TransportHandler): Promise<void> {
    const socketDir = path.dirname(this.options.socketPath);
    const authTokenPath = resolveUnixSocketAuthTokenPath(this.options.socketPath);
    const authToken = randomBytes(32).toString("hex");
    ensurePrivateSocketDirectory(socketDir);
    await removeStaleSocketIfPresent(this.options.socketPath);
    removeFileIfExists(authTokenPath);

    this.server = net.createServer((socket) => {
      this.openSockets.add(socket);
      let buffer = "";
      let authenticated = false;
      let handled = false;
      socket.on("close", () => {
        this.openSockets.delete(socket);
      });
      const peerCredentials = (() => {
        try {
          return resolvePeerCredentials(socket);
        } catch (error) {
          const response = makeErrorResponse(
            "req_unauthorized",
            undefined,
            new ValidationError("Socket peer credential validation failed.", {
              cause: error instanceof Error ? error.message : String(error),
            }),
          );
          closeSocketWithJsonLine(socket, response);
          return null;
        }
      })();

      const daemonUid = currentUid();
      if (peerCredentials && daemonUid !== null && peerCredentials.uid !== daemonUid) {
        const response = makeErrorResponse(
          "req_unauthorized",
          undefined,
          new ValidationError("Socket peer is not authorized to access the authority daemon.", {
            peer_uid: peerCredentials.uid,
            daemon_uid: daemonUid,
          }),
        );
        closeSocketWithJsonLine(socket, response);
        return;
      }

      socket.setEncoding("utf8");
      socket.setTimeout(SOCKET_IDLE_TIMEOUT_MS);

      socket.on("timeout", () => {
        socket.end();
      });

      const requestContext: RequestContext = {
        tenant: peerCredentials
          ? {
              tenant_id: `local-user:${peerCredentials.uid}`,
            }
          : null,
        actor: peerCredentials
          ? {
              actor_id: `local-user:${peerCredentials.uid}`,
              auth_method: "local",
              scopes: ["authority:local_socket"],
            }
          : null,
        workspace: null,
        transport: "unix_socket" as const,
        source_address: peerCredentials
          ? [
              `local`,
              `uid=${peerCredentials.uid}`,
              `gid=${peerCredentials.gid}`,
              ...(peerCredentials.pid !== undefined ? [`pid=${peerCredentials.pid}`] : []),
            ].join(":")
          : "local",
      };

      const respondToParsedRequest = (parsed: unknown): void => {
        handled = true;
        void Promise.resolve(handler(parsed as never, requestContext)).then(
          (response) => {
            closeSocketWithJsonLine(socket, response);
          },
          (error) => {
            const requestId =
              parsed &&
              typeof parsed === "object" &&
              typeof (parsed as { request_id?: unknown }).request_id === "string"
                ? (parsed as { request_id: string }).request_id
                : "req_internal_error";
            const sessionId =
              parsed &&
              typeof parsed === "object" &&
              typeof (parsed as { session_id?: unknown }).session_id === "string"
                ? (parsed as { session_id: string }).session_id
                : undefined;
            const response = makeErrorResponse(requestId, sessionId, error);
            closeSocketWithJsonLine(socket, response);
          },
        );
      };

      const processBufferedLines = (): void => {
        if (handled) {
          return;
        }

        while (buffer.includes("\n")) {
          const newlineIndex = buffer.indexOf("\n");
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (!line) {
            continue;
          }

          if (!authenticated) {
            if (line !== authToken) {
              const response = makeErrorResponse(
                "req_unauthorized",
                undefined,
                new ValidationError("Socket authentication failed."),
              );
              closeSocketWithJsonLine(socket, response);
              return;
            }
            authenticated = true;
            continue;
          }

          let parsed: unknown;

          try {
            parsed = JSON.parse(line);
          } catch (error) {
            const response = makeErrorResponse(
              "req_parse_error",
              undefined,
              new ValidationError("Request body was not valid JSON.", {
                cause: error instanceof Error ? error.message : String(error),
              }),
            );
            closeSocketWithJsonLine(socket, response);
            return;
          }

          respondToParsedRequest(parsed);
          return;
        }
      };

      socket.on("data", (chunk) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer, "utf8") > MAX_BUFFER_BYTES) {
          const response = makeErrorResponse(
            "req_too_large",
            undefined,
            new ValidationError("Request body exceeded the maximum socket payload size."),
          );
          closeSocketWithJsonLine(socket, response);
          return;
        }
        processBufferedLines();
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.options.socketPath, () => {
        this.server!.off("error", reject);
        fs.chmodSync(this.options.socketPath, 0o600);
        fs.writeFileSync(authTokenPath, authToken, { encoding: "utf8", mode: 0o600 });
        fs.chmodSync(authTokenPath, 0o600);
        resolve();
      });
    });
  }

  getServer(): net.Server | null {
    return this.server;
  }

  async close(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;
    for (const socket of this.openSockets) {
      socket.end();
      socket.destroySoon?.();
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
    this.openSockets.clear();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    const authTokenPath = resolveUnixSocketAuthTokenPath(this.options.socketPath);
    removeFileIfExists(authTokenPath);
  }
}
