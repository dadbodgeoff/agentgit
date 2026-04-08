import { CSRF_HEADER_NAME, readCsrfTokenFromDocumentCookies } from "@/lib/security/csrf";

export class ApiClientError extends Error {
  readonly status: number;
  readonly details: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.details = details;
  }
}

export async function fetchJson<T = unknown>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  return (await fetchJsonWithResponse<T>(input, init)).data;
}

export async function fetchJsonWithResponse<T = unknown>(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<{ data: T; response: Response }> {
  const method = (init?.method ?? "GET").toUpperCase();
  const csrfToken = method === "GET" || method === "HEAD" ? null : readCsrfTokenFromDocumentCookies();

  const response = await fetch(input, {
    ...init,
    credentials: init?.credentials ?? "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { [CSRF_HEADER_NAME]: csrfToken } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    let details: unknown;
    try {
      details = await response.json();
    } catch {
      details = await response.text();
    }
    throw new ApiClientError(`Request failed with status ${response.status}`, response.status, details);
  }

  return {
    data: (await response.json()) as T,
    response,
  };
}

export function getApiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiClientError) {
    if (typeof error.details === "string" && error.details.trim().length > 0) {
      return error.details;
    }

    if (
      typeof error.details === "object" &&
      error.details !== null &&
      "message" in error.details &&
      typeof error.details.message === "string" &&
      error.details.message.trim().length > 0
    ) {
      return error.details.message;
    }
  }

  return fallback;
}
