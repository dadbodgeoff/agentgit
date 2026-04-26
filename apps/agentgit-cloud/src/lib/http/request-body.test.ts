import { describe, expect, it } from "vitest";

import { JsonBodyTooLargeError, jsonBodyErrorResponse, readJsonBody } from "@/lib/http/request-body";

describe("readJsonBody", () => {
  it("enforces a default request body limit", async () => {
    const body = JSON.stringify({ payload: "x".repeat(1_000_001) });
    const request = new Request("http://localhost/api/v1/test", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
      },
    });

    await expect(readJsonBody(request)).rejects.toBeInstanceOf(JsonBodyTooLargeError);
  });

  it("returns 413 responses for oversized JSON bodies", async () => {
    const response = jsonBodyErrorResponse(new JsonBodyTooLargeError(), "req_test_01");

    expect(response?.status).toBe(413);
    expect(response?.headers.get("x-agentgit-request-id")).toBe("req_test_01");
    await expect(response?.json()).resolves.toEqual({ message: "Request body exceeds the maximum allowed size." });
  });
});
