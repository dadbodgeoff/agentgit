import { NextResponse } from "next/server";

import { auth } from "./src/auth";
import { publicRoutes } from "./src/lib/navigation/routes";
import { buildApiCorsResponse } from "./src/lib/security/http";

export default auth((request) => {
  const authenticatedRequest = request as typeof request & { auth?: unknown };

  if (authenticatedRequest.nextUrl.pathname.startsWith("/api/")) {
    return buildApiCorsResponse(authenticatedRequest);
  }

  if (authenticatedRequest.auth) {
    return NextResponse.next();
  }

  const signInUrl = new URL(publicRoutes.signIn, authenticatedRequest.nextUrl.origin);
  signInUrl.searchParams.set(
    "callbackUrl",
    `${authenticatedRequest.nextUrl.pathname}${authenticatedRequest.nextUrl.search}`,
  );

  return NextResponse.redirect(signInUrl);
});

export const config = {
  matcher: ["/app/:path*", "/api/:path*"],
};
