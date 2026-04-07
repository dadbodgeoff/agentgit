import { requireApiSession } from "@/lib/auth/api-session";
import { getWorkspaceLiveSignature } from "@/lib/backend/workspace/live-updates";

const encoder = new TextEncoder();

function encodeEvent(event: string, data: Record<string, unknown>) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function GET(request: Request) {
  const { unauthorized, workspaceSession } = await requireApiSession();
  if (unauthorized) {
    return unauthorized;
  }

  const workspaceId = workspaceSession.activeWorkspace.id;

  let interval: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastSignature = getWorkspaceLiveSignature(workspaceId);
      controller.enqueue(
        encodeEvent("connected", {
          workspaceId,
          topics: ["approvals", "dashboard", "calibration", "activity", "audit", "connectors"],
        }),
      );

      interval = setInterval(() => {
        const nextSignature = getWorkspaceLiveSignature(workspaceId);
        if (nextSignature !== lastSignature) {
          lastSignature = nextSignature;
          controller.enqueue(
            encodeEvent("invalidate", {
              workspaceId,
              topics: ["approvals", "dashboard", "calibration", "activity", "audit", "connectors"],
            }),
          );
        } else {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        }
      }, 5000);

      request.signal.addEventListener("abort", () => {
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
