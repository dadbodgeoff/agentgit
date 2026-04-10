import { NextResponse, type NextRequest } from "next/server";

const DEFAULT_API_CORS_HEADERS = [
  "authorization",
  "content-type",
  "sentry-trace",
  "baggage",
  "x-requested-with",
  "x-agentgit-csrf-token",
] as const;
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function parseCommaSeparatedEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function isStateChangingMethod(method: string): boolean {
  return STATE_CHANGING_METHODS.has(method.toUpperCase());
}

export function getAllowedCorsOrigins(): string[] {
  const configuredOrigins = parseCommaSeparatedEnv(process.env.AGENTGIT_CLOUD_ALLOWED_ORIGINS);

  if (process.env.NODE_ENV !== "production") {
    return [...new Set([...configuredOrigins, "http://localhost:3000", "http://127.0.0.1:3000"])];
  }

  return [...new Set(configuredOrigins)];
}

export function isAllowedCorsOrigin(request: NextRequest, origin: string | null): boolean {
  if (!origin) {
    return !isStateChangingMethod(request.method);
  }

  const requestOrigin = request.nextUrl.origin;
  if (origin === requestOrigin) {
    return true;
  }

  return getAllowedCorsOrigins().includes(origin);
}

function setVaryHeader(response: NextResponse) {
  response.headers.set("vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
}

function setCorsHeaders(response: NextResponse, request: NextRequest, origin: string | null) {
  setVaryHeader(response);

  if (!origin) {
    return response;
  }

  response.headers.set("access-control-allow-origin", origin);
  response.headers.set("access-control-allow-credentials", "true");
  response.headers.set("access-control-allow-methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
  response.headers.set(
    "access-control-allow-headers",
    request.headers.get("access-control-request-headers") ?? DEFAULT_API_CORS_HEADERS.join(", "),
  );
  response.headers.set("access-control-max-age", "600");
  return response;
}

export function applyApiCors(request: NextRequest, response: NextResponse): NextResponse {
  const origin = request.headers.get("origin");
  return setCorsHeaders(response, request, origin);
}

export function buildApiCorsResponse(request: NextRequest, forwardedRequestHeaders?: Headers): NextResponse {
  const origin = request.headers.get("origin");

  if (!origin && isStateChangingMethod(request.method)) {
    const denied = NextResponse.json(
      { message: "Origin header is required for state-changing API requests." },
      { status: 403 },
    );
    setVaryHeader(denied);
    return denied;
  }

  if (!isAllowedCorsOrigin(request, origin)) {
    const denied = NextResponse.json({ message: "CORS origin is not allowed." }, { status: 403 });
    setVaryHeader(denied);
    return denied;
  }

  if (request.method === "OPTIONS") {
    return setCorsHeaders(new NextResponse(null, { status: 204 }), request, origin);
  }

  return applyApiCors(
    request,
    forwardedRequestHeaders
      ? NextResponse.next({ request: { headers: forwardedRequestHeaders } })
      : NextResponse.next(),
  );
}

export function buildContentSecurityPolicy(nonce?: string): string {
  const connectSources = [
    "'self'",
    "https://*.ingest.sentry.io",
    "https://*.sentry.io",
    "https://vitals.vercel-insights.com",
    "https://vitals.vercel-analytics.com",
  ];
  const scriptSources = [
    "'self'",
    ...(nonce ? [`'nonce-${nonce}'`, "'strict-dynamic'"] : []),
    "https://va.vercel-scripts.com",
  ];

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "object-src 'none'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src ${connectSources.join(" ")}`,
    "frame-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "media-src 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function buildSecurityHeaders() {
  return [
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  ];
}

export function applySecurityHeaders(response: NextResponse, options: { nonce?: string } = {}): NextResponse {
  response.headers.set("Content-Security-Policy", buildContentSecurityPolicy(options.nonce));

  for (const header of buildSecurityHeaders()) {
    response.headers.set(header.key, header.value);
  }

  return response;
}
