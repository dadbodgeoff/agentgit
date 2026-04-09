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
  const { maxBytes } = options;
  const contentLength = Number.parseInt(request.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(contentLength) && maxBytes !== undefined && contentLength > maxBytes) {
    throw new JsonBodyTooLargeError();
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    throw new JsonBodyParseError();
  }

  if (maxBytes !== undefined && Buffer.byteLength(rawBody, "utf8") > maxBytes) {
    throw new JsonBodyTooLargeError();
  }

  try {
    return JSON.parse(rawBody.replace(/^\uFEFF/u, ""));
  } catch {
    throw new JsonBodyParseError();
  }
}
