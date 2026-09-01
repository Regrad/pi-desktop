import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = process.env.PI_DESKTOP_SMOKE_ROOT
  ? path.resolve(process.env.PI_DESKTOP_SMOKE_ROOT)
  : sourceRoot;
const agentDir = path.join(root, "data", "agent");
const sessionsDir = path.join(agentDir, "sessions");
const projectDir = path.join(root, "data", "smoke-project");
const cliPath = path.join(
  root,
  ...(process.env.PI_DESKTOP_SMOKE_ROOT ? ["resources", "app"] : []),
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js",
);

await mkdir(sessionsDir, { recursive: true });
await mkdir(projectDir, { recursive: true });

const child = spawn(
  process.env.PI_DESKTOP_SMOKE_EXECUTABLE ?? process.execPath,
  [
    cliPath,
    "--mode",
    "rpc",
    "--approve",
    "--session-dir",
    sessionsDir,
    "--session-id",
    `desktop-smoke-${Date.now()}`,
  ],
  {
    cwd: projectDir,
    env: {
      ...process.env,
      ...(process.env.PI_DESKTOP_SMOKE_EXECUTABLE ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      PI_CODING_AGENT_DIR: agentDir,
      PI_DESKTOP_EXECUTABLE: process.env.PI_DESKTOP_SMOKE_EXECUTABLE ?? process.execPath,
      PI_DESKTOP_MCP_ENTRY: path.join(root, ...(process.env.PI_DESKTOP_SMOKE_ROOT ? ["resources", "app"] : []), "node_modules", "@zavora-ai", "computer-use-mcp", "dist", "server.js"),
      MCP_DIRECT_TOOLS: "computer-use",
      NO_UPDATE_NOTIFIER: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  },
);

let sequence = 0;
let buffer = "";
let stderr = "";
const pending = new Map();

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (!line) continue;

    const message = JSON.parse(line);
    if (message.type === "response" && typeof message.id === "string") {
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.success === false) request.reject(new Error(String(message.error)));
      else request.resolve(message.data);
      continue;
    }

    if (message.type === "extension_ui_request") {
      if (message.method === "notify") {
        process.stdout.write(`[extension notify] ${message.params?.message ?? ""}\n`);
      }
      if (message.id) {
        child.stdin.write(
          `${JSON.stringify({ type: "extension_ui_response", id: message.id, cancelled: true })}\n`,
        );
      }
    }
  }
});

function request(type, payload = {}) {
  const id = `smoke-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout: ${type}`));
    }, 60_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
  });
}

async function stop() {
  if (child.exitCode === null) child.kill("SIGTERM");
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    setTimeout(resolve, 3_000);
  });
}

try {
  const state = await request("get_state");
  const models = await request("get_available_models");
  const thinking = await request("get_available_thinking_levels");
  const commands = await request("get_commands");
  const extensionState = await request("get_extension_state");
  const entries = await request("get_session_entries");
  const clearedQueue = await request("clear_queue");

  const result = {
    model: state?.model ?? null,
    thinkingLevel: state?.thinkingLevel ?? null,
    modelCount: Array.isArray(models?.models) ? models.models.length : 0,
    models: Array.isArray(models?.models)
      ? models.models.map((model) => `${model.provider}/${model.id}`)
      : [],
    thinkingLevels: thinking?.levels ?? thinking,
    commandCount: Array.isArray(commands?.commands) ? commands.commands.length : 0,
    commands: Array.isArray(commands?.commands)
      ? commands.commands.map((command) => command.name).filter(Boolean)
      : [],
    extensionCount: Array.isArray(extensionState?.extensionPaths) ? extensionState.extensionPaths.length : 0,
    activeToolCount: Array.isArray(extensionState?.activeTools) ? extensionState.activeTools.length : 0,
    activeTools: Array.isArray(extensionState?.activeTools) ? extensionState.activeTools : [],
    entryCount: Array.isArray(entries?.entries) ? entries.entries.length : 0,
    queueClearShape: Boolean(Array.isArray(clearedQueue?.steering) && Array.isArray(clearedQueue?.followUp)),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (stderr.trim()) process.stdout.write(`--- stderr ---\n${stderr.trim()}\n`);
} finally {
  await stop();
}
