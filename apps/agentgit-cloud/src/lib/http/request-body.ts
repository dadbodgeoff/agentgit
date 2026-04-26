import { NextResponse } from "next/server";

export const DEFAULT_JSON_BODY_MAX_BYTES = 1_000_000;

export class JsonBodyParseError extends Error {
  constructor(message = "Request body must be valid JSON.") {
    super(message);
    this.name = "JsonBodyParseError";
  }
}

export class JsonBodyTooLargeError extends Error {
  constructor(message = "Request body exceeds the maximum allowed size.") {
    super(message);
    this.name = "JsonBodyTooLargeError";
  }
}

type ReadJsonBodyOptions = {
  maxBytes?: number;
};

export async function readJsonBody(request: Request, options: ReadJsonBodyOptions = {}): Promise<unknown> {
  const maxBytes = options.maxBytes ?? DEFAULT_JSON_BODY_MAX_BYTES;
  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new JsonBodyTooLargeError();
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    throw new JsonBodyParseError();
  }

  if (Buffer.byteLength(rawBody, "utf8") > maxBytes) {
    throw new JsonBodyTooLargeError();
  }

  try {
    return JSON.parse(rawBody.replace(/^\uFEFF/u, ""));
  } catch {
    throw new JsonBodyParseError();
  }
}

export function jsonBodyErrorResponse(error: unknown, requestId: string): NextResponse | null {
  if (error instanceof JsonBodyTooLargeError) {
    return NextResponse.json(
      { message: error.message },
      {
        status: 413,
        headers: {
          "cache-control": "private, no-store",
          "x-agentgit-request-id": requestId,
        },
      },
    );
  }

  if (error instanceof JsonBodyParseError) {
    return NextResponse.json(
      { message: error.message },
      {
        status: 400,
        headers: {
          "cache-control": "private, no-store",
          "x-agentgit-request-id": requestId,
        },
      },
    );
  }

  return null;
}
