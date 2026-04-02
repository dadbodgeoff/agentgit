import fs from "node:fs/promises";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const scenario = process.env.AGENTGIT_TEST_MCP_SCENARIO ?? "default";

if (scenario === "stderr_noise") {
  process.stderr.write("mcp test server boot stderr\n");
}

const server = new McpServer({
  name: "agentgit-test-mcp-server",
  version: "1.0.0",
});

if (scenario === "missing_tool") {
  server.registerTool(
    "other_tool",
    {
      description: "A different tool than requested.",
      inputSchema: {
        note: z.string(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ note }) => ({
      content: [{ type: "text", text: `other:${note}` }],
    }),
  );
} else {
  server.registerTool(
    "echo_note",
    {
      description: "Echo a note back to the caller.",
      inputSchema: {
        note: z.string(),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ note }) => {
      if (scenario === "stderr_noise") {
        process.stderr.write(`echo_note:${note}\n`);
      }

      if (scenario === "sandbox_probe") {
        const readPath = process.env.AGENTGIT_SANDBOX_READ_PATH;
        const writePath = process.env.AGENTGIT_SANDBOX_WRITE_PATH;
        const networkUrl = process.env.AGENTGIT_SANDBOX_NETWORK_URL;
        const result = {
          uid: typeof process.getuid === "function" ? process.getuid() : null,
          gid: typeof process.getgid === "function" ? process.getgid() : null,
          read_success: false,
          read_error: null,
          write_success: false,
          write_error: null,
          network_success: false,
          network_error: null,
        };

        if (readPath) {
          try {
            await fs.readFile(readPath, "utf8");
            result.read_success = true;
          } catch (error) {
            result.read_error = error instanceof Error ? error.message : String(error);
          }
        }

        if (writePath) {
          try {
            await fs.writeFile(writePath, note, "utf8");
            result.write_success = true;
          } catch (error) {
            result.write_error = error instanceof Error ? error.message : String(error);
          }
        }

        if (networkUrl) {
          try {
            const response = await fetch(networkUrl, {
              method: "GET",
            });
            result.network_success = response.ok;
          } catch (error) {
            result.network_error = error instanceof Error ? error.message : String(error);
          }
        }

        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }

      if (scenario === "call_error") {
        return {
          isError: true,
          content: [{ type: "text", text: `upstream-error:${note}` }],
        };
      }

      return {
        content: [{ type: "text", text: `echo:${note}` }],
        structuredContent: { echoed_note: note },
      };
    },
  );

  server.registerTool(
    "delete_remote",
    {
      description: "Pretend to delete a remote record.",
      inputSchema: {
        record_id: z.string(),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ record_id }) => ({
      content: [{ type: "text", text: `deleted:${record_id}` }],
    }),
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);

// Keep the test server process attached to stdio for runtimes that would
// otherwise exit once the top-level module work completes.
process.stdin.resume();
