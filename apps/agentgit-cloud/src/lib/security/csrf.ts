export const CSRF_COOKIE_NAME = "agentgit-csrf";
export const CSRF_HEADER_NAME = "x-agentgit-csrf-token";

export function createCsrfToken(): string {
  return `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}

export function readCookieValue(cookieHeader: string | null | undefined, cookieName: string): string | null {
  if (!cookieHeader) {
    return null;
  }

  for (const entry of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = entry.trim().split("=");
    if (rawName === cookieName) {
      const value = rawValue.join("=").trim();
      return value.length > 0 ? decodeURIComponent(value) : null;
    }
  }

  return null;
}

export function readCsrfTokenFromDocumentCookies(): string | null {
  if (typeof document === "undefined") {
    return null;
  }

  return readCookieValue(document.cookie, CSRF_COOKIE_NAME);
}

export function validateCsrfRequest(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (!origin) {
    return "Origin header is required.";
  }

  const requestOrigin = new URL(request.url).origin;
  if (origin !== requestOrigin) {
    return "Origin header does not match this workspace.";
  }

  const cookieToken = readCookieValue(request.headers.get("cookie"), CSRF_COOKIE_NAME);
  const headerToken = request.headers.get(CSRF_HEADER_NAME)?.trim() ?? null;

  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return "CSRF token is missing or invalid.";
  }

  return null;
}
