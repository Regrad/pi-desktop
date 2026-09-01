import path from "node:path";
import process from "node:process";
import electronPath from "electron";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const entryPath = path.resolve("node_modules/@zavora-ai/computer-use-mcp/dist/server.js");
const transport = new StdioClientTransport({
  command: electronPath,
  args: [entryPath],
  env: {
    ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)),
    ELECTRON_RUN_AS_NODE: "1",
  },
  stderr: "pipe",
});
const client = new Client({ name: "pi-desktop-smoke", version: "0.1.0" });
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
const timeout = setTimeout(() => {
  process.stderr.write("MCP smoke timed out\n");
  process.exitCode = 1;
  void client.close();
}, 20_000);

try {
  await client.connect(transport);
  const result = await client.listTools();
  if (!result.tools.some((tool) => tool.name.includes("screenshot"))) {
    throw new Error(`Screenshot tool is missing. Received ${result.tools.length} tools.`);
  }
  process.stdout.write(`computer-use MCP ready: ${result.tools.length} tools\n`);
} finally {
  clearTimeout(timeout);
  await client.close();
}
