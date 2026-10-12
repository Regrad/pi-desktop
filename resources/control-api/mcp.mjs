// Run with Node, or the portable Pi Desktop.exe with ELECTRON_RUN_AS_NODE=1.
import { readFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const connectionFile = process.argv[2];
if (!connectionFile) throw new Error("Pass the absolute path to data/control-api/connection.json");
const definitions = [
  ["pi_desktop_projects", "List Pi Desktop projects and their workspace paths.", "GET", "/projects", {}],
  ["pi_desktop_chats", "List existing Pi Desktop chats without their history.", "GET", "/chats", {}],
  ["pi_desktop_select", "Switch the visible Pi Desktop window to an existing chat without sending a message.", "POST", "/select", { conversationId: { type: "string" } }, ["conversationId"]],
  ["pi_desktop_start", "Delegate a task to the local Pi model. Opens the task chat visibly in Pi Desktop, just like user interaction. A new chat is created unless conversationId is supplied. Clearly specify scope, allowed edits and completion checks. Poll pi_desktop_status to get the result; do not resubmit the task.", "POST", "/tasks", {
    message: { type: "string" }, projectId: { type: "string" }, conversationId: { type: "string" }, paths: { type: "array", items: { type: "string" }, description: "Absolute attachment file paths", maxItems: 20 },
  }, ["message"]],
  ["pi_desktop_status", "Get task state, concise final answer, pending questions and changed files. Set diff=true only if the full diff is needed.", "GET", "/tasks/:taskId", { taskId: { type: "string" }, diff: { type: "boolean" } }, ["taskId"]],
  ["pi_desktop_abort", "Stop a delegated task.", "POST", "/tasks/:taskId/abort", { taskId: { type: "string" } }, ["taskId"]],
  ["pi_desktop_reply", "Answer a pending Pi extension question using its exact id. Use value for input/select/editor, confirmed for confirm, customInput for custom dialogs, or cancelled=true.", "POST", "/tasks/:taskId/reply", { taskId: { type: "string" }, id: { type: "string" }, value: { type: "string" }, confirmed: { type: "boolean" }, cancelled: { type: "boolean" }, customInput: { type: "string" } }, ["taskId", "id"]],
];
const server = new Server({ name: "pi-desktop", version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions.map(([name, description, , , properties, required = []]) => ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false } })) }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    const definition = definitions.find(([name]) => name === params.name);
    if (!definition) throw new Error("Unknown tool");
    const [, , method, route] = definition;
    const args = params.arguments ?? {};
    if (route.includes(":taskId") && (typeof args.taskId !== "string" || !/^[a-f0-9-]{36}$/.test(args.taskId))) throw new Error("Invalid taskId");
    const connection = JSON.parse(await readFile(connectionFile, "utf8"));
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(connection.url) || !/^[a-f0-9]{64}$/.test(connection.token)) throw new Error("Invalid local connection file");
    const routePath = route.replace(":taskId", args.taskId) + (method === "GET" && args.diff === true ? "?diff=true" : "");
    const response = await fetch(connection.url + routePath, {
      method, headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
      ...(method === "POST" ? { body: JSON.stringify(args) } : {}), redirect: "error", signal: AbortSignal.timeout(30000),
    });
    const result = await response.text();
    return { content: [{ type: "text", text: result }], isError: !response.ok };
  } catch (error) { return { content: [{ type: "text", text: error.message }], isError: true }; }
});
await server.connect(new StdioServerTransport());
