import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(source))) return next(source.href, context);
  }
  return next(specifier, context);
} });
const { ensureComfyAddon } = await import("../electron/comfy-addon.ts");
const { discoverAndLoadExtensions } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js");
const appRoot = fileURLToPath(new URL("../", import.meta.url));
const { runApiWorkflow } = await import("../resources/pi-comfyui/lib/workflow.ts");
const { saveComfySettings } = await import("../resources/pi-comfyui/lib/comfy-client.ts");
const { DEFAULT_COMFY_SETTINGS } = await import("../resources/pi-comfyui/shared/comfy.ts");

test("first install seeds addon; updates preserve edits and user deletion", async t => {
  const data = await mkdtemp(path.join(os.tmpdir(), "pi-comfy-install-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  await ensureComfyAddon(data, appRoot);
  const folder = path.join(data, "agent/extensions/pi-comfyui");
  const entry = path.join(folder, "index.ts");
  assert.match(await readFile(entry, "utf8"), /comfyAddon/);
  await writeFile(entry, "// user edit\n", "utf8");
  await ensureComfyAddon(data, appRoot);
  assert.equal(await readFile(entry, "utf8"), "// user edit\n");
  await rm(folder, { recursive: true });
  await ensureComfyAddon(data, appRoot);
  assert.equal(existsSync(folder), false);
});

test("real Pi loader discovers portable addon, new tools and changes; duplicate is atomic", async t => {
  const data = await mkdtemp(path.join(os.tmpdir(), "pi-comfy-load-"));
  const previous = { data: process.env.PI_DESKTOP_DATA_DIR, app: process.env.PI_DESKTOP_APP_ROOT };
  process.env.PI_DESKTOP_DATA_DIR = data;
  process.env.PI_DESKTOP_APP_ROOT = appRoot;
  t.after(async () => {
    for (const [key, value] of [["PI_DESKTOP_DATA_DIR", previous.data], ["PI_DESKTOP_APP_ROOT", previous.app]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(data, { recursive: true, force: true });
  });
  await ensureComfyAddon(data, appRoot);
  const folder = path.join(data, "agent/extensions/pi-comfyui");
  const load = () => discoverAndLoadExtensions([], data, path.join(data, "agent"));
  let result = await load();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions[0].tools.size, 25);
  assert.ok(result.extensions[0].tools.has("comfyui_design_voice"));
  assert.ok(result.extensions[0].tools.has("comfyui_clone_voice"));
  for (const name of ["comfyui_inpaint_image", "comfyui_outpaint_image"]) {
    const definition = result.extensions[0].tools.get(name).definition;
    assert.equal(definition.parameters.properties.width, undefined);
    assert.equal(definition.parameters.properties.height, undefined);
    assert.equal(definition.parameters.properties.count.const, 1);
    assert.equal(definition.parameters.properties.canvas_image.const, 1);
    assert.ok(definition.promptGuidelines.some(line => line.includes("Do not supply width or height")));
    assert.ok(definition.promptGuidelines.every(line => !line.includes("set both width and height together")));
  }
  const publication = result.extensions[0].tools.get("comfyui_publish_music").definition;
  assert.ok(publication.promptGuidelines.some(line => line.includes("two out of ten")));
  const noTracks = await publication.execute("publish-none", { tracks: [] }, new AbortController().signal);
  assert.equal(noTracks.details.audioSelection, true);
  assert.deepEqual(noTracks.details.media, []);
  const tool = path.join(folder, "tools/comfyui_test");
  await mkdir(tool);
  const source = label => `import { Type } from "typebox";\nexport default function(pi) { pi.registerTool({name: "comfyui_test", label: ${JSON.stringify(label)}, description: "test", parameters: Type.Object({}), async execute() { return {content: [{type: "text", text: "ok"}], details: {}}; }}); }\n`;
  await writeFile(path.join(tool, "index.ts"), source("first"), "utf8");
  result = await load();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions[0].tools.size, 26);
  assert.equal(result.extensions[0].tools.get("comfyui_test").definition.label, "first");
  await writeFile(path.join(tool, "index.ts"), source("changed"), "utf8");
  result = await load();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions[0].tools.get("comfyui_test").definition.label, "changed");
  const duplicate = path.join(folder, "tools/comfyui_duplicate");
  await mkdir(duplicate);
  await writeFile(path.join(duplicate, "index.ts"), source("duplicate"), "utf8");
  result = await load();
  assert.equal(result.extensions.length, 0);
  assert.match(result.errors[0].error, /duplicate tool comfyui_test/);
});

test("new-model workflow runner selects final nodes, saves portable files and rejects cloud nodes", async t => {
  const data = await mkdtemp(path.join(os.tmpdir(), "pi-comfy-workflow-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  let cloud = false;
  let submitted = 0;
  const graph = { final: { class_type: "NewModelSave", inputs: { seed: 0, new_setting: true } } };
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/object_info") return res.end(JSON.stringify({ NewModelSave: { api_node: cloud } }));
    if (req.url === "/prompt") {
      let body = ""; for await (const chunk of req) body += chunk;
      assert.deepEqual(JSON.parse(body).prompt, graph);
      submitted++;
      return res.end(JSON.stringify({ prompt_id: "custom-job" }));
    }
    if (req.url === "/history/custom-job") return res.end(JSON.stringify({ "custom-job": { status: { status_str: "success" }, outputs: {
      preview: { images: [{ filename: "intermediate.png", type: "output" }] },
      final: { images: [{ filename: "result.png", type: "output" }] },
    } } }));
    if (req.url.startsWith("/view?")) {
      assert.equal(new URL(req.url, "http://localhost").searchParams.get("filename"), "result.png");
      res.setHeader("Content-Type", "image/png"); return res.end(Buffer.from("test-image"));
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await saveComfySettings(data, { ...DEFAULT_COMFY_SETTINGS, enabled: true, url: `http://127.0.0.1:${server.address().port}` });
  const result = await runApiWorkflow(data, graph, { kind: "image", outputNodes: ["final"] });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].nodeId, "final");
  assert.equal(path.dirname(result.files[0].path), path.join(data, "image-generation"));
  assert.equal((await readFile(result.files[0].path)).toString("base64"), result.files[0].data);
  cloud = true;
  await assert.rejects(runApiWorkflow(data, graph, { kind: "image" }), /Облачный узел/);
  assert.equal(submitted, 1);
  await saveComfySettings(data, { ...DEFAULT_COMFY_SETTINGS, enabled: false });
  await assert.rejects(runApiWorkflow(data, graph, { kind: "image" }), /отключён/);
});
