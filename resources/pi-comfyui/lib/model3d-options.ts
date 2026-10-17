import { Type } from "typebox";

export const processingDefaults = {
  repair: false, remesh: false, simplify: false, transfer_textures: false, bake_normal: false, bake_ao: false,
  target_triangles: 30000, remesh_vertices: 5000, repair_resolution: 512, proxy_points: 1000000,
  components: "keep_all", texture_resolution: 2048,
  blender_path: "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe", repair_position: "after_remesh",
};
export const processingProperties = {
  repair: Type.Optional(Type.Boolean({ description: "WTiVo watertight reconstruction: closes holes; can change details. Inspect topology report." })),
  remesh: Type.Optional(Type.Boolean({ description: "Instant Meshes quad retopology. Returns a separate quad OBJ; GLB is triangulated." })),
  simplify: Type.Optional(Type.Boolean({ description: "Blender decimation to target_triangles (approximate, not exact)." })),
  transfer_textures: Type.Optional(Type.Boolean({ description: "Bake source appearance onto new geometry/UV. Keep on when changing textured geometry." })),
  bake_normal: Type.Optional(Type.Boolean()), bake_ao: Type.Optional(Type.Boolean()),
  target_triangles: Type.Optional(Type.Integer({ minimum: 100, maximum: 2000000 })),
  remesh_vertices: Type.Optional(Type.Integer({ minimum: 50, maximum: 200000 })),
  repair_resolution: Type.Optional(Type.Integer({ minimum: 64, maximum: 2048, multipleOf: 64 })),
  proxy_points: Type.Optional(Type.Integer({ minimum: 10000, maximum: 25000000 })),
  components: Type.Optional(Type.Union([Type.Literal("keep_all"), Type.Literal("largest"), Type.Literal("auto")])),
  texture_resolution: Type.Optional(Type.Integer({ minimum: 64, maximum: 8192, multipleOf: 64 })),
  blender_path: Type.Optional(Type.String({ description: "Blender executable path on the ComfyUI computer; omit for installed default." })),
  repair_position: Type.Optional(Type.Union([Type.Literal("before_remesh"), Type.Literal("after_remesh")])),
};
export type ProcessingOptions = Partial<typeof processingDefaults>;

export function processingInputs(options: ProcessingOptions = {}) {
  for (const key of Object.keys(options)) if (!(key in processingDefaults)) throw new Error(`Неизвестный параметр 3D: ${key}`);
  const result = { ...processingDefaults, ...options };
  for (const key of ["repair", "remesh", "simplify", "transfer_textures", "bake_normal", "bake_ao"] as const)
    if (typeof result[key] !== "boolean") throw new Error(`Некорректный параметр 3D: ${key}`);
  for (const [key, min, max, step] of [["target_triangles", 100, 2000000, 1], ["remesh_vertices", 50, 200000, 1], ["repair_resolution", 64, 2048, 64], ["proxy_points", 10000, 25000000, 1], ["texture_resolution", 64, 8192, 64]] as const) {
    const value = result[key];
    if (!Number.isInteger(value) || value < min || value > max || value % step) throw new Error(`Некорректный параметр 3D: ${key}`);
  }
  if (!["keep_all", "largest", "auto"].includes(result.components) || !["before_remesh", "after_remesh"].includes(result.repair_position) || typeof result.blender_path !== "string") throw new Error("Некорректные настройки обработки 3D");
  return result;
}

export const modelGuidelines = [
  "For existing meshes choose the matching processing tool: comfyui_process_3d (repair/retopology/simplify/texture transfer), comfyui_texture_3d (new appearance from an image), comfyui_lod_3d (multiple LODs), or comfyui_asset_3d (cleanup/UV/export/render views). Image-to-shape generation is for requests that need new geometry.",
  "Quad retopology returns a separate OBJ; GLB is triangulated. Watertight repair can alter details and reduce small gaps. Treat successful execution as pipeline completion; topology counts, warnings, watertight reports and requested visual checks determine what was actually verified. When repairing after retopology, the quad OBJ is the pre-repair mesh, not the final watertight model.",
  "Preserve source files. Transfer textures after geometry or UV changes if appearance must be retained. UV unwrap alone does not restore textures. Export formats differ: STL/PLY do not preserve full PBR; OBJ may require separate material/texture files. These utilities do not preserve rigs or animation.",
  "The normal result is the completed GLB shown in the chat's interactive viewer. Additional rendered views and iterations are optional validation steps when requested or when they are materially useful for the task. Visual conclusions require returned images; a GLB path alone provides no visual evidence to the language model.",
  "Processing source/target paths must be accessible on the ComfyUI computer (same PC or shared filesystem). Image references are uploaded automatically. Keep expensive settings at workflow defaults unless requested or justified by reports.",
];
