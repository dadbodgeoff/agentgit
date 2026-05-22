import { renderPrometheusMetrics } from "@/lib/observability/metrics";

function unauthorized(): Response {
  return new Response("metrics bearer token required\n", {
    status: 401,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

export async function GET(request: Request): Promise<Response> {
  const token = process.env.AGENTGIT_METRICS_BEARER_TOKEN?.trim();
  if (!token) {
    return new Response("metrics endpoint disabled\n", {
      status: 404,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
      },
    });
  }

  const authorization = request.headers.get("authorization")?.trim();
  if (authorization !== `Bearer ${token}`) {
    return unauthorized();
  }

  return new Response(renderPrometheusMetrics(), {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    },
  });
}
