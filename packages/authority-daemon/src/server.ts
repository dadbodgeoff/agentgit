import net from "node:net";

import { bootstrapLocalDaemon } from "./app/bootstrap.js";
import { type StartServerOptions } from "./stores/local-store-factory.js";
import { UnixSocketTransport } from "./transports/unix-socket.js";

export type { StartServerOptions };

export async function startServer(options: StartServerOptions): Promise<net.Server> {
  const { service, cleanup } = await bootstrapLocalDaemon(options);
  const transport = new UnixSocketTransport({ socketPath: options.socketPath });
  await transport.listen((request, context) => service.dispatch(request, context));
  const server = transport.getServer()!;
  let cleanupPromise: Promise<void> | null = null;
  const runCleanup = (): Promise<void> => {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        service.close();
        await cleanup();
      })();
    }
    return cleanupPromise;
  };
  const originalClose = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    return originalClose((error?: Error) => {
      if (error) {
        callback?.(error);
        return;
      }

      void runCleanup()
        .then(() => callback?.())
        .catch((cleanupError) =>
          callback?.(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))),
        );
    });
  }) as typeof server.close;
  server.on("close", () => {
    void runCleanup();
  });
  return server;
}
