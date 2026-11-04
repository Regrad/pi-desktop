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
  await mkdir(path.join(data, "comfy-library"));
  await writeFile(path.join(data, "comfy-library", "card.json"), "old prepared description");
  await mkdir(path.join(data, "chats"));
  await writeFile(path.join(data, "chats", "user-file.txt"), "keep user files");
  await ensureComfyAddon(data, appRoot);
  assert.equal(existsSync(path.join(data, "comfy-library")), false);
  assert.equal(await readFile(path.join(data, "chats", "user-file.txt"), "utf8"), "keep user files");
  const folder = path.join(data, "agent/extensions/pi-comfyui");
  const entry = path.join(folder, "index.ts");
  assert.match(await readFile(entry, "utf8"), /comfyAddon/);
  const retiredTool = path.join(folder, "tools", "comfyui_workflows");
  await mkdir(retiredTool, { recursive: true });
  await writeFile(path.join(retiredTool, "index.ts"), "old universal tool");
  await writeFile(entry, "// user edit\n", "utf8");
  await ensureComfyAddon(data, appRoot);
  assert.equal(existsSync(retiredTool), false);
  assert.equal(await readFile(entry, "utf8"), "// user edit\n");
  await rm(folder, { recursive: true });
  await ensureComfyAddon(data, appRoot);
  assert.equal(existsSync(folder), false);
});

test("replacing app alone refreshes stock addon files at startup without replacing user data or edits", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-comfy-app-update-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, "data"), template = path.join(root, "app", "resources", "pi-comfyui");
  await mkdir(template, { recursive: true }); await mkdir(data);
  for (const name of ["index.ts", "custom.ts", "removed.ts", "deleted.ts"]) await writeFile(path.join(template, name), "old stock");
  await writeFile(path.join(data, "desktop-state.json"), "user chats");
  await ensureComfyAddon(data, path.join(root, "app"));
  const active = path.join(data, "agent", "extensions", "pi-comfyui");
  await writeFile(path.join(active, "custom.ts"), "user customization"); await rm(path.join(active, "deleted.ts"));
  await writeFile(path.join(template, "index.ts"), "new stock"); await rm(path.join(template, "removed.ts"));
  await writeFile(path.join(template, "new.ts"), "new tool");
  await ensureComfyAddon(data, path.join(root, "app"));
  assert.equal(await readFile(path.join(active, "index.ts"), "utf8"), "new stock");
  assert.equal(await readFile(path.join(active, "new.ts"), "utf8"), "new tool");
  assert.equal(await readFile(path.join(active, "custom.ts"), "utf8"), "user customization");
  assert.equal(existsSync(path.join(active, "deleted.ts")), false); assert.equal(existsSync(path.join(active, "removed.ts")), false);
  assert.equal(await readFile(path.join(data, "desktop-state.json"), "utf8"), "user chats");
});

test("real Pi loader exposes specialized modules; universal copies stay inactive and load failure is atomic", async t => {
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
  for (const name of ["comfyui_generate_image", "comfyui_generate_music", "comfyui_generate_3d", "comfyui_texture_3d", "comfyui_status"]) assert.ok(result.extensions[0].tools.has(name));
  assert.equal(result.extensions[0].tools.has("comfyui_generate_idol_3d"), false);
  for (const name of ["comfyui_workflows", "comfyui_run_workflow", "comfyui_job"]) assert.ok(!result.extensions[0].tools.has(name));
  const contextHook = result.extensions[0].handlers.get("before_agent_start")[0];
  assert.equal(await contextHook({ systemPrompt: "base" }, {}), undefined);
  await saveComfySettings(data, { ...DEFAULT_COMFY_SETTINGS, enabled: true });
  const firstContext = await contextHook({ systemPrompt: "base" }, {});
  await mkdir(path.join(data, "comfy-workflows"), { recursive: true });
  await writeFile(path.join(data, "comfy-workflows/new-image.json"), JSON.stringify({ workflow: "new graph data" }));
  assert.deepEqual(await contextHook({ systemPrompt: "base" }, {}), firstContext, "Catalog edits must not rewrite the system prefix");
  assert.match(firstContext.systemPrompt, /specialized tool/);
  assert.doesNotMatch(firstContext.systemPrompt, /new-image|new graph data|127\.0\.0\.1/);
  assert.doesNotMatch(firstContext.systemPrompt, /comfyui_workflows|comfyui_run_workflow|comfyui_job/);
  // Even edited stale modules preserved by portable updates must never be imported.
  const retired = path.join(folder, "tools/comfyui_run_workflow");
  await mkdir(retired, { recursive: true });
  await writeFile(path.join(retired, "index.ts"), 'throw new Error("retired module evaluated");');
  result = await load();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions[0].tools.size, 25);
  const selected = path.join(folder, "tools/desktop_show_image/index.ts");
  const original = await readFile(selected, "utf8");
  await writeFile(selected, original.replace('label: "Показать изображение в ответе"', 'label: "changed"'));
  result = await load();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions[0].tools.get("desktop_show_image").definition.label, "changed");
  await writeFile(selected, original.replace('name: "desktop_show_image"', 'name: "comfyui_generate_image"'));
  result = await load();
  assert.equal(result.extensions.length, 0);
  assert.match(result.errors[0].error, /duplicate tool comfyui_generate_image/);
  await writeFile(selected, 'throw new Error("broken module");');
  result = await load();
  assert.equal(result.extensions.length, 0);
  assert.ok(result.errors.length > 0);
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
