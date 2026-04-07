import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import type { TransportHandler, TransportListener } from "@agentgit/core-ports";
import { ValidationError } from "@agentgit/schemas";

import { makeErrorResponse } from "../app/response-helpers.js";

export interface UnixSocketTransportOptions {
  socketPath: string;
}

export class UnixSocketTransport implements TransportListener {
  private server: net.Server | null = null;

  constructor(private readonly options: UnixSocketTransportOptions) {}

  async listen(handler: TransportHandler): Promise<void> {
    const socketDir = path.dirname(this.options.socketPath);
    fs.mkdirSync(socketDir, { recursive: true });
    if (fs.existsSync(this.options.socketPath)) {
      fs.rmSync(this.options.socketPath, { force: true });
    }

    this.server = net.createServer((socket) => {
      let buffer = "";

      socket.setEncoding("utf8");

      socket.on("data", async (chunk) => {
        buffer += chunk;

        while (buffer.includes("\n")) {
          const newlineIndex = buffer.indexOf("\n");
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);

          if (!line) {
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
            socket.write(`${JSON.stringify(response)}\n`);
            socket.end();
            return;
          }

          const response = await handler(parsed as never, {
            tenant: null,
            actor: null,
            workspace: null,
            transport: "unix_socket",
            source_address: "local",
          });
          socket.write(`${JSON.stringify(response)}\n`);
          socket.end();
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.options.socketPath, () => {
        this.server!.off("error", reject);
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
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
}
