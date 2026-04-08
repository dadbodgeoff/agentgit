export class JsonBodyParseError extends Error {
  constructor(message = "Request body must be valid JSON.") {
    super(message);
    this.name = "JsonBodyParseError";
  }
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new JsonBodyParseError();
  }
}
