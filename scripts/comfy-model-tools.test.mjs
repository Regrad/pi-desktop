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
const { textureGraph } = await import("../resources/pi-comfyui/lib/texture-graph.ts");
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

test("both generation modes bridge MESH to UltraTex through a path without processing geometry", () => {
  for (const mode of ["model3d", "model3d_multiview"]) {
    const images = mode === "model3d" ? ["one.png"] : ["front.png", "left.png", "back.png", "right.png"];
    const graph = builtinGraph(DEFAULT_COMFY_SETTINGS, mode, { model3d_options: { target_face_count: 50000 } }, images);
    assert.equal(graph.pi_model_mesh_file.class_type, "MeshToFile3D");
    assert.deepEqual(graph.pi_model_mesh_file.inputs.mesh, ["196", 0]);
    assert.equal(graph.pi_model_mesh_path.class_type, "UniversalModelTools");
    assert.deepEqual(graph.pi_model_mesh_path.inputs.source_model, ["pi_model_mesh_file", 0]);
    for (const flag of ["repair", "remesh", "simplify", "transfer_textures", "bake_normal", "bake_ao"])
      assert.equal(graph.pi_model_mesh_path.inputs[flag], false, flag);
    assert.deepEqual(graph.pi_tex_prep.inputs.mesh_path, ["pi_model_mesh_path", 1]);
    assert.equal(graph.pi_tex_prep.inputs.trimesh, undefined);
    assert.equal(graph[186].inputs.target_face_count, 50000);
    assert.equal(graph.pi_tex_prep.inputs.uv_mode, "keep_existing");
    assert.deepEqual(graph[mode === "model3d" ? "322" : "372"].inputs.model_3d, ["pi_tex_bake", 4]);
  }
  const trimesh = textureGraph(["existing_trimesh", 0], "reference.png");
  assert.deepEqual(trimesh.pi_tex_prep.inputs.trimesh, ["existing_trimesh", 0]);
  assert.equal(trimesh.pi_tex_prep.inputs.mesh_path, "");
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

test("UltraTex binds existing geometry, reference, PBR LoRAs and explicit zero/false controls", () => {
  const graph = textureGraph("C:/models/mesh.glb", "uploaded.png", { seed: 0, steps: 30, cfg: 2, texture_resolution: 4096, drop_background_tokens: false, token_chunk: 0 });
  assert.equal(graph.pi_tex_image.inputs.image, "uploaded.png");
  assert.equal(graph.pi_tex_prep.inputs.mesh_path, "C:/models/mesh.glb");
  assert.deepEqual(["seed", "steps", "guidance"].map(key => graph.pi_tex_albedo.inputs[key]), [0, 30, 2]);
  assert.equal(graph.pi_tex_albedo.inputs.drop_background_tokens, false);
  assert.equal(graph.pi_tex_albedo.inputs.token_chunk, 0);
  assert.equal(graph.pi_tex_bake.inputs.texture_size, 4096);
  assert.equal(graph.pi_tex_albedo_lora.inputs.lora_name, "ultratex_flux2.safetensors");
  assert.equal(graph.pi_tex_mr_lora.inputs.lora_name, "ultratex_flux2_mr.safetensors");
  assert.ok(!Object.values(graph).some(node => node.class_type === "Trellis2TextureStage"));
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
test("texture and both generation workflows match installed node input and output types", { skip: !process.env.PI_TEST_COMFY_SCHEMA }, async () => {
  const info = await (await fetch("http://127.0.0.1:8188/object_info")).json();
  const graphs = [textureGraph("C:/models/mesh.glb", "upload.png", {}),
    builtinGraph(DEFAULT_COMFY_SETTINGS, "model3d", {}, ["upload.png"]),
    builtinGraph(DEFAULT_COMFY_SETTINGS, "model3d_multiview", {}, ["front.png", "left.png", "back.png", "right.png"])];
  for (const graph of graphs) {
  for (const [id, node] of Object.entries(graph)) {
    const schema = info[node.class_type]; assert.ok(schema, node.class_type);
    for (const name of Object.keys(schema.input.required ?? {})) assert.ok(name in node.inputs, `${id}: missing ${name}`);
    for (const [name, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value)) {
        const upstream = graph[value[0]]; assert.ok(upstream, `${id}/${name}: missing source`);
        const sourceSchema = info[upstream.class_type]; assert.ok(sourceSchema, upstream.class_type);
        const received = sourceSchema.output[value[1]];
        const expected = (schema.input.required?.[name] ?? schema.input.optional?.[name])?.[0];
        assert.notEqual(received, undefined, `${id}/${name}: missing output ${value[1]}`);
        // Dynamic switches and match-type sockets are resolved by ComfyUI itself.
        if (typeof expected === "string" && typeof received === "string"
          && !["*", "COMFY_MATCHTYPE_V3"].includes(expected) && !["*", "COMFY_MATCHTYPE_V3"].includes(received))
          assert.ok(expected.split(",").includes(received), `${id}/${name}: ${received} -> ${expected}`);
        continue;
      }
      const expected = schema.input.required?.[name] ?? schema.input.optional?.[name];
      assert.ok(expected, `${id}: unknown ${name}`);
      if (Array.isArray(expected[0]) && !(node.class_type === "LoadImage" && name === "image")) assert.ok(expected[0].includes(value), `${id}/${name}: choice ${value}`);
      const bounds = expected[1];
      if (typeof value === "number" && bounds) { if (bounds.min !== undefined) assert.ok(value >= bounds.min, `${id}/${name} min`); if (bounds.max !== undefined) assert.ok(value <= bounds.max, `${id}/${name} max`); }
    }
  }
  }
});
