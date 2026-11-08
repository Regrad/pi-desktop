import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(source))) return next(source.href, context);
  }
  return next(specifier, context);
} });
const { modelGraph } = await import("../resources/pi-comfyui/tools/comfyui_generate_3d/workflows.ts");
const { CHARACTER_GRAPH } = await import("../resources/pi-comfyui/tools/comfyui_generate_3d/pixelartistry-graphs.ts");
const { DEFAULT_COMFY_SETTINGS } = await import("../resources/pi-comfyui/shared/comfy.ts");
const { modelSummary } = await import("../resources/pi-comfyui/tools/comfyui_generate_3d/model-summary.ts");
const images = ["front.png", "left.png", "back.png", "right.png"];
function make(mode = "model3d", input = {}) {
  return modelGraph(DEFAULT_COMFY_SETTINGS, mode, input, mode === "model3d" ? images.slice(0, 1) : images);
}
test("author chain preserves high-poly normal detail and exports one final GLB", () => {
  const g = make("model3d", { seed: 0 });
  for (const type of ["MeshReconstructWithQuad", "WTiVoNativeMeshToMesh", "LODTailorTheMeshTrimmer", "LODTailorBakeForger", "UTXGenerateTextureViewsV23", "UTXApplyMaterials", "UTXCreate3DFile"])
    assert.ok(Object.values(g).some(n => n.class_type === type), type);
  assert.equal(Object.values(g).filter(n => n.class_type === "Save3DAdvanced").length, 1);
  assert.ok(!Object.values(g).some(n => ["UltraTexSampler", "UltraTexBake", "Trellis2TextureStage"].includes(n.class_type)));
  assert.deepEqual(g[341].inputs.high_poly, ["340", 1]);
  assert.deepEqual(g[341].inputs.low_poly, ["340", 0]);
  assert.equal(g[341].inputs.bake_normal_detail, true);
  assert.equal(g[374].inputs.uv_mode, "keep_existing");
  assert.equal(g[335].inputs.target_tris, 12000);
  assert.equal(g[377].inputs.texture_size, 2048);
  for (const n of Object.values(g)) if (n.class_type === "KSampler" || n.class_type === "UTXGenerateTextureViewsV23") assert.equal(n.inputs.seed, 0);
  assert.equal(g[377].inputs.upscale_mode, "Quality");
  assert.equal(CHARACTER_GRAPH[377].inputs.upscale_mode, "sharp_anchor_v2");
  assert.equal(make("model3d", { model3d_options: { geometry_model: "trellis2" } })[316].inputs.value, true);
  assert.throws(() => make("model3d_multiview", { model3d_options: { geometry_model: "trellis2" } }), /Four-view/);
});
test("four views condition both geometry and texture without example-sheet crops", () => {
  const g = make("model3d_multiview", { seed: 42 });
  assert.deepEqual([338, 341, 342, 345].map(id => g[`mv_${id}`].inputs.image), images);
  assert.equal(g.mv_324.class_type, "Pixal3DMultiViewConditioning");
  assert.deepEqual(g[325].inputs.mesh, ["mv_92", 0]);
  assert.deepEqual(g[375].inputs.reference_back, ["mv_342", 0]);
  assert.deepEqual(g[375].inputs.reference_character_left_side, ["mv_341", 0]);
  assert.deepEqual(g[375].inputs.reference_character_right_side, ["mv_345", 0]);
  assert.deepEqual(g[374].inputs.mesh, ["pi_orient", 0]);
  assert.deepEqual(g[384].inputs.mesh, ["pi_orient", 0]);
  assert.equal(g.pi_orient.inputs["mode.angle_y"], 180);
  assert.ok(!g[92]);
  assert.ok(!Object.values(g).some(n => n.class_type === "MoGeInference"));
  assert.ok(g[372]); assert.ok(!g[322]);
});
test("polygon, texture, reconstruction, sampler and Blender controls reach their owner nodes", () => {
  const g = make("model3d", { seed: 11,
    model3d_options: { target_face_count: 50000, shape_resolution: 1024, texture_resolution: 4096, watertight_resolution: 1024, watertight_proxy_points: 6000000, component_mode: "auto" },
    texture_options: { steps: 25, cfg: 2, albedo_resolution: 2048, mr_resolution: 1024, sparse_topk: 0.5, token_chunk: 8192 },
    postprocess: { blender_path: "D:/Blender/blender.exe" },
  });
  assert.equal(g[335].inputs.target_tris, 50000);
  assert.equal(g[94].inputs.target_resolution, 1024);
  assert.equal(g[327].inputs.input_res, 1024);
  assert.equal(g[327].inputs.final_res, 1024);
  assert.equal(g[327].inputs.proxy_points, 6000000);
  assert.equal(g[327].inputs.faithc_component_mode, "auto");
  assert.equal(g[325].inputs.remove_inner_faces, false);
  assert.equal(g[324].inputs.value, "D:/Blender/blender.exe");
  for (const id of [337, 374, 377]) assert.equal(g[id].inputs.resolution ?? g[id].inputs.atlas_size ?? g[id].inputs.texture_size, 4096);
  assert.equal(g[341].inputs.normal_map_resolution, 4096);
  assert.equal(g[358].inputs.steps, 25); assert.equal(g[364].inputs.steps, 25);
  assert.equal(g[358].inputs.view_resolution, 2048);
  assert.equal(g[364].inputs.view_resolution, 1024);
  assert.equal(g[387].inputs.token_chunk, 8192);
  assert.ok(!g.pi_model_process);
  assert.equal(make("model3d", { model3d_options: { texture_resolution: 512 } }).pi_resize_base_color.inputs.width, 512);
});
test("raw output, disabled watertight and optional postprocessing remain explicit", () => {
  for (const mode of ["model3d", "model3d_multiview"]) {
    const g = make(mode, { model3d_options: { target_face_count: 0, watertight: false } });
    assert.ok(!g[335]); assert.ok(!g[325]); assert.ok(!g[327]);
    assert.equal(g[328].inputs.voxel_rebuild, false);
    assert.deepEqual(g[328].inputs.mesh, [mode === "model3d" ? "92" : "mv_92", 0]);
    const post = make(mode, { postprocess: { simplify: true, target_triangles: 5000, transfer_textures: true } });
    assert.equal(post.pi_model_process.inputs.target_triangles, 5000);
    assert.deepEqual(post[388].inputs.passthrough, ["pi_model_process", 0]);
  }
  assert.throws(() => make("model3d", { model3d_options: { target_face_count: -1 } }));
  assert.throws(() => make("model3d", { model3d_options: { shape_resolution: 1100 } }));
});
test("both graph modes match installed ComfyUI nodes", { skip: !process.env.PI_TEST_COMFY_SCHEMA }, async () => {
  const schema = await (await fetch("http://127.0.0.1:8188/object_info")).json();
  for (const mode of ["model3d", "model3d_multiview"]) for (const [id, n] of Object.entries(make(mode))) {
    const s = schema[n.class_type]; assert.ok(s && !s.api_node, `${id}/${n.class_type}`);
    for (const key of Object.keys(s.input.required ?? {})) assert.ok(key in n.inputs, `${id}: missing ${key}`);
    for (const [key, value] of Object.entries(n.inputs)) {
      const spec = s.input.required?.[key] ?? s.input.optional?.[key];
      if (!spec && key.startsWith("mode.") && n.class_type === "RotateMesh") continue;
      assert.ok(spec, `${id}: unknown ${key}`);
      const options = Array.isArray(spec[0]) ? spec[0] : spec[0] === "COMBO" ? spec[1].options : undefined;
      if (options && n.class_type !== "LoadImage" && !Array.isArray(value)) assert.ok(options.includes(value), `${id}/${key}: ${value}`);
    }
  }
});
test("GLB report counts triangles and PBR maps without treating them as topology proof", async () => {
  await mkdir("C:/AI_Temp", { recursive: true });
  const dir = await mkdtemp("C:/AI_Temp/pi-glb-summary-");
  try {
    const model = { asset: { version: "2.0" }, accessors: [{count: 150000}, {count: 32000}],
      meshes: [{primitives: [{indices: 0, attributes: {POSITION: 1}, material: 0}]}],
      materials: [{normalTexture: {index: 0}, pbrMetallicRoughness: {baseColorTexture: {index: 1}, metallicRoughnessTexture: {index: 2}}}] };
    const text = JSON.stringify(model), chunk = Buffer.from(text + " ".repeat((4 - Buffer.byteLength(text) % 4) % 4));
    const header = Buffer.alloc(20); header.write("glTF"); header.writeUInt32LE(2, 4); header.writeUInt32LE(20 + chunk.length, 8);
    header.writeUInt32LE(chunk.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
    const file = dir + "/model.glb";
    await writeFile(file, Buffer.concat([header, chunk]));
    const report = await modelSummary(file);
    assert.equal(report.triangles, 50000); assert.equal(report.vertices, 32000);
    assert.equal(report.normalMaps, 1); assert.equal(report.baseColorMaps, 1); assert.equal(report.metallicRoughnessMaps, 1);
    assert.match(report.verification, /not verified/);
    await writeFile(file, Buffer.from("bad file"));
    await assert.rejects(modelSummary(file), /Invalid GLB/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
