import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(source))) return next(source.href, context);
  }
  return next(specifier, context);
} });
const { processingInputs } = await import("../resources/pi-comfyui/lib/model3d-options.ts");
const { saveModelArtifacts, modelArtifactLocation } = await import("../resources/pi-comfyui/lib/model3d-artifacts.ts");
const { textureGraph } = await import("../resources/pi-comfyui/tools/comfyui_texture_3d/index.ts");
const { builtinGraph } = await import("../resources/pi-comfyui/lib/comfy-client.ts");
const { DEFAULT_COMFY_SETTINGS } = await import("../resources/pi-comfyui/shared/comfy.ts");
const { saveComfySettings } = await import("../resources/pi-comfyui/lib/comfy-client.ts");
const { collectComfyMedia } = await import("../src/comfy-images.ts");
function glb() {
  const text = '{"asset":{"version":"2.0"}}';
  const data = Buffer.from(text + " ".repeat((4 - Buffer.byteLength(text) % 4) % 4));
  const head = Buffer.alloc(20); head.write("glTF"); head.writeUInt32LE(2, 4);
  head.writeUInt32LE(20 + data.length, 8); head.writeUInt32LE(data.length, 12); head.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([head, data]);
}
test("processing runs only when explicitly requested", () => {
  for (const mode of ["model3d", "model3d_multiview"]) {
    const images = mode === "model3d" ? ["one.png"] : ["a.png", "b.png", "c.png", "d.png"];
    const base = builtinGraph(DEFAULT_COMFY_SETTINGS, mode, {}, images);
    assert.ok(!base.pi_model_process);
    assert.equal(base[186].inputs.target_face_count, 700000);
    assert.equal(base[288].inputs.value, 4096);
    const generatedBudget = builtinGraph(DEFAULT_COMFY_SETTINGS, mode, { model3d_options: { target_face_count: 20000 } }, images);
    assert.equal(generatedBudget[186].inputs.target_face_count, 20000);
    assert.ok(!generatedBudget.pi_model_process);
    const explicit = builtinGraph(DEFAULT_COMFY_SETTINGS, mode, { postprocess: { simplify: true, target_triangles: 5000, transfer_textures: true } }, images).pi_model_process.inputs;
    assert.equal(explicit.target_triangles, 5000);
    assert.equal(explicit.simplify, true);
    assert.equal(explicit.transfer_textures, true);
  }
  assert.equal(processingInputs({}).simplify, false);
  assert.equal(processingInputs({}).transfer_textures, false);
  for (const invalid of [{ repair: "yes" }, { target_triangles: 0 }, { texture_resolution: 111 }, { components: "none" }, { unknown: 1 }]) assert.throws(() => processingInputs(invalid));
});

test("explicit OBJ materials are saved once, not downloaded and rewritten as companions", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-model-materials-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prefix = "3d/pi-desktop/test-job";
  const report = { files: [`${prefix}/mesh.obj`, `${prefix}/material.mtl`] };
  const requests = [];
  const result = await saveModelArtifacts(dir, "job", prefix, { report: { text: [JSON.stringify(report)] } }, ["report"],
    async filename => { requests.push(filename); return Buffer.from(filename.endsWith(".obj") ? "mtllib material.mtl\nv 0 0 0\n" : "newmtl material\n"); });
  assert.deepEqual(requests, ["mesh.obj", "material.mtl"]);
  assert.equal(result.files.length, 2);
});
test("alternate spellings of one artifact share one file and one download", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-model-aliases-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prefix = "3d/pi-desktop/test-job";
  const relative = `${prefix}/mesh.obj`, absolute = `C:/ComfyUI/output/${relative}`;
  let downloads = 0;
  const result = await saveModelArtifacts(dir, "job", prefix, { report: { text: [JSON.stringify({ result: absolute, files: [relative, absolute.replaceAll("/", "\\")] })] } }, ["report"],
    async () => { downloads++; return Buffer.from("v 0 0 0\n"); });
  assert.equal(downloads, 1);
  assert.equal(result.files.length, 1);
  assert.equal(result.artifactReports.report.result, result.artifactReports.report.files[0]);
  assert.equal(result.artifactReports.report.files[0], result.artifactReports.report.files[1]);
});

test("new texture workflow binds existing geometry, reference and sampling controls", () => {
  const graph = textureGraph("C:/models/mesh.glb", "uploaded.png", { seed: 0, steps: 30, cfg: 2, denoise: 0.8, encoder_resolution: 1024, texture_resolution: 4096, padding: 8 });
  assert.equal(graph["1"].inputs.image, "uploaded.png");
  assert.equal(graph["5"].inputs.mesh_filename, "C:/models/mesh.glb");
  assert.equal(graph["5"].inputs.resolution, 1024);
  assert.deepEqual(["seed", "steps", "cfg", "denoise"].map(key => graph["8"].inputs[key]), [0, 30, 2, 0.8]);
  assert.equal(graph["11"].inputs.resolution, 4096); assert.equal(graph["12"].inputs.texture_size, 4096);
  assert.deepEqual(graph["15"].inputs.viewport_state, {});
  assert.ok(!Object.values(graph).some(node => node.class_type === "SaveImage"));
});
test("artifact reports save all six LODs, maps, quad OBJ and rendered views with local paths", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-model-artifacts-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prefix = "3d/pi-desktop/test-job";
  const server = `C:/ComfyUI/output/${prefix}`;
  const report = { lod_paths: Array.from({ length: 6 }, (_, i) => `${server}/lod${i}/result.glb`), lod_reports: [{ quad_obj: `${server}/lod0/quads.obj`, texture_maps: { base_color: `${server}/lod0/textures/color.png` } }], renders: [`${server}/views/01.png`] };
  const requests = [];
  const result = await saveModelArtifacts(dir, "job", prefix, { lod: { text: [JSON.stringify(report)] } }, ["lod"], async (filename, subfolder) => { requests.push([filename, subfolder]); return filename.endsWith(".glb") ? glb() : Buffer.from(filename.endsWith(".obj") ? "v 0 0 0\n" : "image"); });
  assert.equal(result.files.filter(file => file.mimeType === "model/gltf-binary").length, 6);
  assert.equal(requests.length, 9);
  assert.equal(new Set(result.files.map(file => file.path)).size, 9);
  for (const file of result.files) assert.ok((await readFile(file.path)).length);
  assert.ok(result.artifactReports.lod.renders[0].includes("image-generation"));
  assert.ok(result.artifactReports.lod.lod_reports[0].quad_obj.includes("job-assets"));
  assert.deepEqual(JSON.parse(await readFile(result.recordFile, "utf8")), result.artifactReports);
});
test("artifact downloads reject traversal before making requests; OBJ preserves MTL filename", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-model-paths-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prefix = "3d/pi-desktop/test-job";
  for (const file of [`${prefix}/../secret.glb`, "C:/secret.glb", `${prefix}/model.exe`]) assert.throws(() => modelArtifactLocation(file, prefix));
  let downloaded = 0;
  await assert.rejects(saveModelArtifacts(dir, "bad", prefix, { node: { text: [JSON.stringify({ result: `${prefix}/good.glb`, quad_obj: "C:/secret.obj" })] } }, ["node"], async () => { downloaded++; return glb(); }));
  assert.equal(downloaded, 0);
  const result = await saveModelArtifacts(dir, "obj", prefix, { node: { text: [JSON.stringify({ files: [`${prefix}/result.obj`] })] } }, ["node"], async filename => Buffer.from(filename.endsWith(".obj") ? "mtllib result.mtl\nv 0 0 0\n" : "newmtl material\nKd 1 1 1\n"));
  assert.equal(path.basename(result.files[0].path), "result.obj");
  assert.equal(path.basename(result.files[1].path), "result.mtl");
  assert.equal(path.dirname(result.files[0].path), path.dirname(result.files[1].path));
});
test("texture workflow inputs match running ComfyUI node schema", { skip: !process.env.PI_TEST_COMFY_SCHEMA }, async () => {
  const info = await (await fetch("http://127.0.0.1:8188/object_info")).json();
  const graph = textureGraph("C:/models/mesh.glb", "upload.png", {});
  for (const [id, node] of Object.entries(graph)) {
    const schema = info[node.class_type]; assert.ok(schema, node.class_type);
    for (const name of Object.keys(schema.input.required ?? {})) assert.ok(name in node.inputs, `${id}: missing ${name}`);
    for (const [name, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value)) { assert.ok(graph[value[0]]); continue; }
      const expected = schema.input.required?.[name] ?? schema.input.optional?.[name];
      assert.ok(expected, `${id}: unknown ${name}`);
      if (Array.isArray(expected[0]) && !(node.class_type === "LoadImage" && name === "image")) assert.ok(expected[0].includes(value), `${id}/${name}: choice ${value}`);
      const bounds = expected[1];
      if (typeof value === "number" && bounds) { if (bounds.min !== undefined) assert.ok(value >= bounds.min, `${id}/${name} min`); if (bounds.max !== undefined) assert.ok(value <= bounds.max, `${id}/${name} max`); }
    }
  }
});

test("registered process, LOD and asset tools submit complete graphs and return render paths in image order", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-model-tools-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, "source.glb"); await writeFile(source, glb());
  const definitions = new Map();
  for (const name of ["comfyui_process_3d", "comfyui_lod_3d", "comfyui_asset_3d"]) {
    const register = (await import(`../resources/pi-comfyui/tools/${name}/index.ts`)).default;
    register({ registerTool: tool => definitions.set(tool.name, tool) }, { dataDir: dir });
  }
  const info = process.env.PI_TEST_COMFY_SCHEMA ? await (await fetch("http://127.0.0.1:8188/object_info")).json() : Object.fromEntries(["UniversalModelTools", "ModelLODGenerator", "ModelAssetUtilities"].map(name => [name, {}]));
  let submitted;
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/object_info") return res.end(JSON.stringify(info));
    if (req.url === "/prompt") {
      let body = ""; for await (const chunk of req) body += chunk;
      submitted = JSON.parse(body).prompt;
      for (const node of Object.values(submitted)) {
        const schema = info[node.class_type]; assert.ok(schema);
        for (const name of Object.keys(schema.input?.required ?? {})) assert.ok(name in node.inputs, `${node.class_type}/${name}`);
        assert.equal(node.inputs.source_path, source);
      }
      return res.end(JSON.stringify({ prompt_id: `job-${Object.keys(submitted)[0]}` }));
    }
    if (req.url.startsWith("/history/")) {
      const [nodeId, node] = Object.entries(submitted)[0];
      const result = `${node.inputs.output_prefix}/out/result.glb`;
      const report = nodeId === "lod" ? { lod_paths: node.inputs.triangle_counts.split(",").map((_, i) => `${node.inputs.output_prefix}/lod${i}/result.glb`) }
        : { result, ...(nodeId === "asset" ? { renders: [`${node.inputs.output_prefix}/out/view.png`] } : {}) };
      return res.end(JSON.stringify({ [`job-${nodeId}`]: { outputs: { [nodeId]: { text: [JSON.stringify(report)] } }, status: { status_str: "success" } } }));
    }
    if (req.url.startsWith("/view?")) { res.setHeader("Content-Type", "application/octet-stream"); return res.end(req.url.includes(".png") ? Buffer.from("render") : glb()); }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await saveComfySettings(dir, { ...DEFAULT_COMFY_SETTINGS, enabled: true, url: `http://127.0.0.1:${server.address().port}` });
  const processResult = await definitions.get("comfyui_process_3d").execute("process", { source, repair: true, remesh: true, target_triangles: 5000 });
  assert.equal(submitted.process.inputs.repair, true); assert.equal(processResult.details.media.length, 1);
  const lodResult = await definitions.get("comfyui_lod_3d").execute("lod", { source, triangle_counts: [30000, 10000, 5000] });
  assert.equal(lodResult.details.media.length, 3);
  const assetResult = await definitions.get("comfyui_asset_3d").execute("asset", { source, render_views: true });
  const media = collectComfyMedia([{ id: "asset", name: "comfyui_asset_3d", result: assetResult }]);
  assert.equal(media[0].type, "image"); assert.ok(media[0].path.includes("image-generation"));
  assert.equal(media[1].type, "model3d");
});
