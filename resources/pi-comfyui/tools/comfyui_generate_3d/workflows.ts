import { randomUUID } from "node:crypto";
import type { ComfySettings } from "../../shared/comfy.js";
import type { ComfyInput } from "../../lib/comfy-client.js";
import { fillWorkflow } from "../../lib/api-graph.js";
import { processingInputs, processingDefaults } from "../../lib/model3d-options.js";
import { CHARACTER_GRAPH, MULTIVIEW_SHAPE } from "./pixelartistry-graphs.js";

type Graph = typeof CHARACTER_GRAPH;
type GenerationInput = ComfyInput & {
  model3d_options?: NonNullable<ComfyInput["model3d_options"]> & { geometry_model?: "pixal3d" | "trellis2" };
  texture_options?: NonNullable<ComfyInput["texture_options"]> & { use_view_references?: boolean };
};

function prune(graph: Graph, output: string) {
  const used = new Set<string>();
  function visit(id: string) {
    if (used.has(id)) return;
    if (!graph[id]) throw new Error(`3D workflow: missing dependency ${id}`);
    used.add(id);
    for (const v of Object.values(graph[id].inputs))
      if (Array.isArray(v) && typeof v[0] === "string" && Number.isInteger(v[1])) visit(v[0]);
  }
  visit(output);
  for (const id of Object.keys(graph)) if (!used.has(id)) delete graph[id];
  return graph;
}

function number(value: number | undefined, fallback: number, name: string, min: number, max: number, step = 1) {
  const n = value ?? fallback;
  if (!Number.isFinite(n) || n < min || n > max || (step > 0 && Math.abs(n / step - Math.round(n / step)) > 1e-7))
    throw new Error(`Invalid 3D ${name}: ${min}–${max}, step ${step}`);
  return n;
}

export function modelGraph(settings: ComfySettings, mode: "model3d" | "model3d_multiview", input: GenerationInput, images: string[]): Graph {
  const graph = fillWorkflow(CHARACTER_GRAPH, input, images, settings.steps);
  const o = input.model3d_options ?? {};
  const t = input.texture_options ?? {};
  if (t.use_view_references !== undefined && typeof t.use_view_references !== "boolean")
    throw new Error("Invalid use_view_references flag");
  const target = number(o.target_face_count, 12000, "target_face_count", 0, 10000000);
  const resolution = number(o.shape_resolution, 1536, "shape_resolution", 1024, 2048, 128);
  const texture = number(o.texture_resolution ?? t.texture_resolution, 2048, "texture_resolution", 512, 8192, 512);
  const waterResolution = number(o.watertight_resolution, 1536, "watertight_resolution", 1024, 2048, 512);
  const proxy = number(o.watertight_proxy_points, 12000000, "watertight_proxy_points", 1000000, 25000000, 1000000);
  if (o.watertight !== undefined && typeof o.watertight !== "boolean") throw new Error("Invalid watertight flag");
  if (o.component_mode !== undefined && !["largest", "auto", "keep_all"].includes(o.component_mode)) throw new Error("Invalid component_mode");
  if (o.geometry_model !== undefined && !["pixal3d", "trellis2"].includes(o.geometry_model)) throw new Error("Invalid geometry_model");
  if (mode === "model3d_multiview" && o.geometry_model === "trellis2") throw new Error("Four-view generation uses Pixal3D; Trellis2 accepts one image");
  graph["316"].inputs.value = o.geometry_model === "trellis2";
  graph["324"].inputs.value = input.postprocess?.blender_path ?? processingDefaults.blender_path;
  graph["94"].inputs.target_resolution = resolution;
  graph["325"].inputs.resolution = resolution <= 1024 ? 1024 : resolution <= 1536 ? 1536 : 2048;
  Object.assign(graph["327"].inputs, { input_res: waterResolution, final_res: waterResolution, proxy_points: proxy,
    faithc_component_mode: o.component_mode ?? "largest" });
  // Filtering inner faces is only appropriate when a single solid component was requested.
  graph["325"].inputs.remove_inner_faces = (o.component_mode ?? "largest") === "largest";
  graph["325"].inputs.remove_floaters = (o.component_mode ?? "largest") === "largest";
  graph["335"].inputs.target_tris = target || 6000000;
  if (target === 0) {
    graph["337"].inputs.mesh = ["328", 0];
    delete graph["335"];
  }
  if (o.watertight === false) {
    graph["328"].inputs.mesh = ["92", 0];
    graph["328"].inputs.voxel_rebuild = false;
    if (graph["335"]) graph["335"].inputs.voxel_rebuild = false;
  }
  if (mode === "model3d_multiview") {
    Object.assign(graph, fillWorkflow(MULTIVIEW_SHAPE, input, images, settings.steps));
    graph["mv_94"].inputs.target_resolution = resolution;
    graph["325"].inputs.mesh = ["mv_92", 0];
    if (o.watertight === false) graph["328"].inputs.mesh = ["mv_92", 0];
    // These inputs hold fitted reference pixels during sampling. A generated
    // mesh need not match their silhouettes, so use them only when requested.
    if (t.use_view_references) {
      graph["375"].inputs.reference_back = ["mv_342", 0];
      graph["375"].inputs.reference_character_left_side = ["mv_341", 0];
      graph["375"].inputs.reference_character_right_side = ["mv_345", 0];
    }
    // Pixal's four-view mesh faces -Z; UltraTex's front camera expects +Z.
    // Rotate the complete baked mesh (normals/tangents included), retaining its UV atlas.
    graph.pi_orient = { class_type: "RotateMesh", inputs: { mesh: ["353", 0], mode: "euler_xyz",
      "mode.angle_x": 0, "mode.angle_y": 180, "mode.angle_z": 0 } };
    graph["374"].inputs.mesh = ["pi_orient", 0];
    graph["384"].inputs.mesh = ["pi_orient", 0];
  }
  // 8b37156 replaces the old sharp_anchor_v2/completion controls with Quality.
  delete graph["377"].inputs.completion;
  graph["377"].inputs.upscale_mode = "Quality";
  const bakeSize = [1024, 2048, 4096, 8192].find(size => size >= texture)!;
  graph["377"].inputs.texture_size = bakeSize;
  graph["374"].inputs.atlas_size = texture;
  graph["337"].inputs.resolution = texture;
  graph["341"].inputs.normal_map_resolution = texture;
  graph["341"].inputs.load_output_images = false;
  for (const id of ["358", "364"]) Object.assign(graph[id].inputs, {
    steps: number(t.steps, 25, "texture steps", 1, 100),
    extra_steps: number(t.steps, 25, "texture steps", 1, 100),
    // The baker uses the canonical six for covered surfaces; extra cameras
    // require another diffusion pass and only contribute to unseen regions.
    view_count: 6,
    guidance: number(t.cfg, 4, "texture cfg", 0, 20, 0),
    sparse_retention: number(t.sparse_topk, 0.2, "sparse_topk", 0.01, 1, 0),
    refine_denoise: 0, refine_steps: 4,
  });
  for (const [id, requested] of [["358", t.albedo_resolution], ["364", t.mr_resolution]] as const) {
    const size = number(requested, id === "358" ? 2048 : 1024, "view resolution", 256, 4096, 16);
    graph[id].inputs.view_resolution = size;
  }
  graph["375"].inputs.normal_view_resolution = Math.max(1024, ...[t.albedo_resolution ?? 2048, t.mr_resolution ?? 1024].map(size => size <= 1024 ? 1024 : size <= 2048 ? 2048 : 4096));
  graph["387"].inputs.token_chunk = number(t.token_chunk, 4096, "token_chunk", 0, 32768, 256);
  if (t.memory_factor !== undefined && t.memory_factor !== 0)
    graph["387"].inputs.activation_factor = number(t.memory_factor, 12, "memory_factor", 4, 64, 0.5);
  if (t.attention === "standard" || t.attention === "comfy_default")
    throw new Error("This workflow uses UltraTex sparse sampling; set sparse_topk=1 for full token retention");
  for (const [name, slot] of [["base_color", 2], ["roughness", 3], ["metallic", 4]] as const) {
    if (texture === bakeSize) continue;
    const id = `pi_resize_${name}`;
    graph[id] = { class_type: "ImageScale", inputs: { image: ["377", slot], upscale_method: "area", width: texture, height: texture, crop: "disabled" } };
    graph["384"].inputs[name] = [id, 0];
  }
  const output = mode === "model3d" ? "322" : "372";
  const prefix = `3d/pi-desktop/${randomUUID()}`;
  graph[output] = graph["386"];
  delete graph["386"];
  graph[output].inputs.filename_prefix = prefix;
  if (input.postprocess && Object.keys(input.postprocess).some(key => key !== "blender_path")) {
    graph.pi_model_process = { class_type: "UniversalModelTools", inputs: {
      ...processingInputs(input.postprocess), source_path: "", target_path: "", source_model: ["385", 0], output_prefix: prefix,
    } };
    graph["388"].inputs.passthrough = ["pi_model_process", 0];
  }
  return prune(graph, output);
}
