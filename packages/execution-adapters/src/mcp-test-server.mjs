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
