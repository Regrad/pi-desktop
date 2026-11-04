import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import http from "node:http";
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(source))) return next(source.href, context);
  }
  return next(specifier, context);
} });
const { default: extension } = await import("../electron/comfy-extension.ts");
const { saveComfySettings } = await import("../resources/pi-comfyui/lib/comfy-client.ts");
const { DEFAULT_COMFY_SETTINGS } = await import("../resources/pi-comfyui/shared/comfy.ts");
const { mediaToolError } = await import("../resources/pi-comfyui/lib/tool-errors.ts");
const { textureGraph } = await import("../resources/pi-comfyui/tools/comfyui_texture_3d/workflow.ts");
const { collectAnswerMedia } = await import("../src/comfy-images.ts");
const backend = /comfy|\bworkflow\b|\bnode(?:s)?\b|TRIMESH|ModelLODGenerator|UniversalModelTools|object_info|class_type|8188/i;

test("registered media interface exposes operations and parameters, not the backend", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-media-interface-"));
  const previous = process.env.PI_DESKTOP_DATA_DIR;
  process.env.PI_DESKTOP_DATA_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_DESKTOP_DATA_DIR; else process.env.PI_DESKTOP_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const tools = [], hooks = new Map();
  await extension({ registerTool: tool => tools.push(tool), on(name, callback) { hooks.set(name, callback); } });
  assert.equal(tools.length, 25);
  for (const tool of tools) {
    assert.ok(tool.name.startsWith("media_") || tool.name.startsWith("desktop_"), tool.name);
    assert.doesNotMatch(JSON.stringify({ name: tool.name, label: tool.label, description: tool.description,
      promptSnippet: tool.promptSnippet, guidelines: tool.promptGuidelines, parameters: tool.parameters }), backend, tool.name);
  }
  await saveComfySettings(directory, { ...DEFAULT_COMFY_SETTINGS, enabled: true });
  const prompt = await hooks.get("before_agent_start")({ systemPrompt: "base" });
  assert.doesNotMatch(prompt.systemPrompt, backend);
  assert.match(prompt.systemPrompt, /Built-in media tools/);
  let backendFailure = false;
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (backendFailure) { res.writeHead(400); res.end('{"node_errors":{"private_node":{}}}'); return; }
    res.end(JSON.stringify(req.url === "/system_stats" ? { system: { comfyui_version: "private-backend" }, devices: [] }
      : { YuE2NativeUniversalAdapterLoader: { input: { required: { adapter: [["none", "voice-adapter.safetensors"]] } } } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  await saveComfySettings(directory, { ...DEFAULT_COMFY_SETTINGS, enabled: true, url: `http://127.0.0.1:${server.address().port}` });
  const status = await tools.find(tool => tool.name === "media_status").execute("status", {});
  assert.doesNotMatch(JSON.stringify(status), /comfy|private-backend|workflow|127\.0\.0\.1|\/prompt/i);
  assert.equal(JSON.parse(status.content[0].text).available, true);
  backendFailure = true;
  await assert.rejects(tools.find(tool => tool.name === "media_status").execute("failure", {}), error => {
    assert.doesNotMatch(error.message, backend);
    assert.match(error.message, /media_operation_failed/);
    return true;
  });
  await assert.rejects(tools.find(tool => tool.name === "media_generate_3d").execute("invalid", { images: ["a", "b"] }), /одно изображение или четыре/);
  await assert.rejects(tools.find(tool => tool.name === "media_generate_3d").execute("cancelled", { images: ["a", "b"] }, AbortSignal.abort()));
});

test("backend errors are recorded privately while parameter errors stay actionable", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-media-errors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await mediaToolError(directory, "media_generate_3d", new Error('ComfyUI 400: {"node_errors":{"private_node":{"class_type":"UltraTexPrep"}}}'));
  assert.equal(result.isError, true);
  assert.doesNotMatch(JSON.stringify(result), backend);
  const files = await readdir(path.join(directory, "logs/media-tools"));
  assert.equal(files.length, 1);
  assert.match(await readFile(path.join(directory, "logs/media-tools", files[0]), "utf8"), /UltraTexPrep/);
  const invalid = await mediaToolError(directory, "media_generate_image", new Error("width must be a multiple of 32"));
  assert.equal(invalid.content[0].text, "width must be a multiple of 32");
});

test("neutral texture options retain the installed implementation bindings", () => {
  const graph = textureGraph("mesh.glb", "image.png", { uv_mode: "gpu", attention: "standard" });
  assert.equal(graph.pi_tex_prep.inputs.uv_mode, "comfy_gpu");
  assert.equal(graph.pi_tex_albedo.inputs.attention, "comfy_default");
});

test("both current and historical media names retain answer publication", () => {
  for (const prefix of ["media_", "comfyui_"]) {
    const generated = { id: "generation", name: `${prefix}generate_image`, result: {
      content: [{ type: "image", data: "image-bytes", mimeType: "image/png" }], details: { files: ["C:/Pi/data/image-generation/test.png"] },
    } };
    assert.equal(collectAnswerMedia([generated]).parts.length, 1);
    const audio = { type: "audio", path: "C:/Pi/data/music-generation/test.flac", mimeType: "audio/flac" };
    const published = { id: "selection", name: `${prefix}publish_music`, result: {
      content: [], details: { audioSelection: true, media: [audio], files: [audio.path] },
    } };
    assert.equal(collectAnswerMedia([published]).parts.length, 1);
  }
});
