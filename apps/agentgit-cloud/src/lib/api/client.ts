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

export async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      "Content-Type": "application/json",
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

  return (await response.json()) as T;
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
