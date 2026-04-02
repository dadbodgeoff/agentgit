import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { parseSecretCommandOptions } from "./cli-secret-input.js";

class FakeTtyInput extends PassThrough {
  isTTY = true;

  setRawMode(_enabled: boolean): this {
    return this;
  }
}

describe("cli secret input", () => {
  it("reads prompt-based secrets without echoing the token to stderr", async () => {
    const stdin = new FakeTtyInput();
    const stderr = new PassThrough();
    let stderrOutput = "";
    stderr.on("data", (chunk) => {
      stderrOutput += chunk.toString("utf8");
    });

    const resultPromise = parseSecretCommandOptions(
      ["--secret-id", "prompt_secret", "--prompt-bearer-token"],
      process.cwd(),
      {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
      },
    );

    stdin.write("super-secret-token");
    stdin.write("\n");

    const result = await resultPromise;

    expect(result.secretId).toBe("prompt_secret");
    expect(result.bearerToken).toBe("super-secret-token");
    expect(stderrOutput).toContain("Bearer token:");
    expect(stderrOutput).not.toContain("super-secret-token");
  });
});
