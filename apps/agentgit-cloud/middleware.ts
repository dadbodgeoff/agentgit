import { NextResponse } from "next/server";

import { auth } from "./src/auth";
import { publicRoutes } from "./src/lib/navigation/routes";

export default auth((request) => {
  if (request.auth) {
    return NextResponse.next();
  }

  const signInUrl = new URL(publicRoutes.signIn, request.nextUrl.origin);
  signInUrl.searchParams.set("callbackUrl", `${request.nextUrl.pathname}${request.nextUrl.search}`);

  return NextResponse.redirect(signInUrl);
});

export const config = {
  matcher: ["/app/:path*"],
};
