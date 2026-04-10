import { requireApiSession } from "@/lib/auth/api-session";
import { getWorkspaceLiveSignature } from "@/lib/backend/workspace/live-updates";

const encoder = new TextEncoder();

function encodeEvent(event: string, data: Record<string, unknown>) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function GET(request: Request) {
  const { unauthorized, workspaceSession } = await requireApiSession(request);
  if (unauthorized) {
    return unauthorized;
  }

  const workspaceId = workspaceSession.activeWorkspace.id;

  let interval: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let lastSignature = await getWorkspaceLiveSignature(workspaceId);
      controller.enqueue(
        encodeEvent("connected", {
          workspaceId,
          topics: ["approvals", "dashboard", "calibration", "activity", "audit", "connectors"],
        }),
      );

      const poll = async () => {
        if (closed) {
          return;
        }

        const refreshedAccess = await requireApiSession(request);
        if (refreshedAccess.unauthorized || refreshedAccess.workspaceSession.activeWorkspace.id !== workspaceId) {
          closed = true;
          if (interval) {
            clearInterval(interval);
          }
          controller.enqueue(
            encodeEvent("disconnect", {
              workspaceId,
              reason: "authorization_changed",
            }),
          );
          controller.close();
          return;
        }

        const nextSignature = await getWorkspaceLiveSignature(workspaceId);
        if (nextSignature !== lastSignature) {
          lastSignature = nextSignature;
          controller.enqueue(
            encodeEvent("invalidate", {
              workspaceId,
              topics: ["approvals", "dashboard", "calibration", "activity", "audit", "connectors"],
            }),
          );
          return;
        }

        controller.enqueue(encoder.encode(": keepalive\n\n"));
      };

      interval = setInterval(() => {
        void poll();
      }, 5000);

      request.signal.addEventListener("abort", () => {
        closed = true;
        if (interval) {
          clearInterval(interval);
        }
        controller.close();
      });
    },
    cancel() {
      if (interval) {
        clearInterval(interval);
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    },
  });
}
