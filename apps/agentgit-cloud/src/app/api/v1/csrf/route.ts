import { NextResponse } from "next/server";

import { createCsrfToken, CSRF_COOKIE_NAME } from "@/lib/security/csrf";

export async function GET(request: Request) {
  const csrfToken = createCsrfToken();
  const response = NextResponse.json({ ok: true });
  response.headers.set("cache-control", "private, no-store");
  response.cookies.set(CSRF_COOKIE_NAME, csrfToken, {
    httpOnly: false,
    path: "/",
    sameSite: "strict",
    secure: new URL(request.url).protocol === "https:",
  });
  return response;
}
