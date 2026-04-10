import { NextResponse } from "next/server";

import { auth } from "./src/auth";
import { publicRoutes } from "./src/lib/navigation/routes";
import { createCsrfToken, CSRF_COOKIE_NAME } from "./src/lib/security/csrf";
import { applySecurityHeaders, buildApiCorsResponse, buildContentSecurityPolicy } from "./src/lib/security/http";

function createCspNonce(): string {
  return btoa(crypto.randomUUID());
}

function isPublicRoute(pathname: string): boolean {
  return Object.values(publicRoutes).some((route) => pathname === route);
}

function withSecurityResponse(
  request: Parameters<Parameters<typeof auth>[0]>[0],
  response: NextResponse,
  nonce: string,
): NextResponse {
  const csrfToken = request.cookies.get(CSRF_COOKIE_NAME)?.value ?? createCsrfToken();
  applySecurityHeaders(response, { nonce });
  response.cookies.set(CSRF_COOKIE_NAME, csrfToken, {
    httpOnly: false,
    path: "/",
    sameSite: "strict",
    secure: request.nextUrl.protocol === "https:",
  });
  return response;
}

export default auth((request) => {
  const nonce = createCspNonce();
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", buildContentSecurityPolicy(nonce));
  requestHeaders.set("x-nonce", nonce);
  const authState = "auth" in request ? request.auth : null;

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return withSecurityResponse(request, buildApiCorsResponse(request, requestHeaders), nonce);
  }

  if (isPublicRoute(request.nextUrl.pathname)) {
    return withSecurityResponse(request, NextResponse.next({ request: { headers: requestHeaders } }), nonce);
  }

  if (authState) {
    return withSecurityResponse(request, NextResponse.next({ request: { headers: requestHeaders } }), nonce);
  }

  const signInUrl = new URL(publicRoutes.signIn, request.nextUrl.origin);
  signInUrl.searchParams.set("callbackUrl", `${request.nextUrl.pathname}${request.nextUrl.search}`);

  return withSecurityResponse(request, NextResponse.redirect(signInUrl), nonce);
});

export const config = {
  matcher: [
    "/api/:path*",
    {
      source: "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
