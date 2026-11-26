import path from "node:path";
import { tmpdir } from "node:os";
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const tools = [{ name: "execute_blender_code",
  description: "Run bpy Python in an isolated background Blender. Reopens blendFile if present and saves it after successful execution. No desktop window is touched. Print inspection data; optionally render a PNG and return it through previewPath. Export GLB/FBX using bpy. Each call is serialized; inspect previews and match the requested style.",
  inputSchema: { type: "object", additionalProperties: false, required: ["blendFile", "code"], properties: {
    blendFile: { type: "string", description: "Absolute .blend project path. Use the same path to continue this asset." },
    code: { type: "string", description: "Python code using bpy. Existing projects are loaded before execution." },
    previewPath: { type: "string", description: "Absolute PNG path rendered by this code; returns an image to inspect." },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 3600, default: 300 },
  } } }];

export async function runBlender(executable, args, signal, timeoutMs) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let output = "", failure;
    const append = bytes => { output = (output + bytes.toString()).slice(-32_000); };
    child.stdout.on("data", append); child.stderr.on("data", append);
    const abort = () => { failure = signal?.reason ?? new Error("Blender cancelled."); child.kill(); };
    const timer = setTimeout(() => { failure = new Error(`Blender timed out after ${timeoutMs / 1000}s.`); child.kill(); }, timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", error => { failure = error; });
    child.once("close", code => {
      clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Blender exited with ${code}.\n${output}`));
      else resolve(output);
    });
  });
}

export async function executeBlender(executable, params, signal) {
  if (typeof params.blendFile !== "string" || !path.isAbsolute(params.blendFile) || path.extname(params.blendFile).toLowerCase() !== ".blend")
    throw new Error("blendFile must be an absolute .blend path.");
  if (typeof params.code !== "string" || !params.code.trim()) throw new Error("Python code is required.");
  if (params.previewPath !== undefined && (typeof params.previewPath !== "string" || !path.isAbsolute(params.previewPath) || path.extname(params.previewPath).toLowerCase() !== ".png"))
    throw new Error("previewPath must be an absolute PNG path.");
  const seconds = params.timeoutSeconds ?? 300;
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) throw new Error("timeoutSeconds must be between 1 and 3600.");
  const tempRoot = process.env.PI_DESKTOP_CREATIVE_TEMP || path.join(tmpdir(), "pi-desktop-creative");
  await mkdir(tempRoot, { recursive: true });
  const jobDir = await mkdtemp(path.join(tempRoot, "pi-blender-"));
  try {
    const script = path.join(jobDir, "run.py");
    await writeFile(script, await readFile(new URL("./blender-job.py", import.meta.url)));
    await writeFile(path.join(jobDir, "job.json"), JSON.stringify({ ...params, resultPath: path.join(jobDir, "result.json") }), "utf8");
    const output = await runBlender(executable, ["--background", "--factory-startup", "--python-exit-code", "1", "--python", script], signal, seconds * 1000);
    const result = JSON.parse(await readFile(path.join(jobDir, "result.json"), "utf8"));
    const content = [{ type: "text", text: JSON.stringify({ ...result, log: output }) }];
    if (params.previewPath) {
      if ((await stat(params.previewPath)).size > 10 * 1024 * 1024) throw new Error("Preview exceeds 10 MB. Render a smaller preview.");
      content.push({ type: "image", mimeType: "image/png", data: (await readFile(params.previewPath)).toString("base64") });
    }
    return { content };
  } finally { await rm(jobDir, { recursive: true, force: true }); }
}

export async function startBlenderServer(executable) {
  const server = new Server({ name: "pi-desktop-blender", version: "1.0.0" }, {
    capabilities: { tools: {} }, instructions: "Model only on a user's creative request. Work in a named .blend file in the project. Keep supplied references and style. Inspect renders after significant changes. Never claim visual verification without seeing the image. Each call saves the scene only on success. Use bpy exporters for game assets.",
  });
  let pending = Promise.resolve();
  const active = new Set();
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, (request, extra) => {
    const controller = new AbortController();
    const abort = () => controller.abort(extra.signal.reason);
    extra.signal.addEventListener("abort", abort, { once: true });
    if (extra.signal.aborted) abort();
    active.add(controller);
    const result = pending.then(async () => {
      try {
        controller.signal.throwIfAborted();
        if (request.params.name !== tools[0].name) throw new Error("Unknown Blender tool.");
        return await executeBlender(executable, request.params.arguments ?? {}, controller.signal);
      } catch (error) { return { content: [{ type: "text", text: error.message ?? String(error) }], isError: true }; }
      finally { active.delete(controller); extra.signal.removeEventListener("abort", abort); }
    });
    pending = result.then(() => undefined, () => undefined);
    return result;
  });
  const stop = () => { for (const controller of active) controller.abort(new Error("MCP session closed.")); void server.close(); };
  process.stdin.once("end", stop);
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  await server.connect(new StdioServerTransport());
}
