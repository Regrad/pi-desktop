import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ToolContext } from "../../lib/context.js";
import { modelGuidelines, processingDefaults } from "../../lib/model3d-options.js";
import { modelSource, modelJobPrefix, runModelTool } from "../../lib/model3d-tools.js";

export default function register(pi: ExtensionAPI, { dataDir }: ToolContext) {
  pi.registerTool({
    name: "comfyui_asset_3d", label: "Очистка, экспорт и ракурсы 3D-модели",
    description: "Clean an existing mesh, merge close vertices, filter small components, recalculate/smooth normals, unwrap UV, export GLB plus OBJ/FBX/STL/PLY, and/or render 1–16 orbit views. Defaults leave geometry/UV unchanged except normal recalculation. Render image blocks are supplied to the language model for visual inspection; a GLB alone is not visible to it. Originals are preserved. UV changes may require texture transfer; static utility does not preserve rigs/animation. OBJ may need companion material/texture files; use GLB for a self-contained textured result. Source must be accessible to ComfyUI.",
    promptSnippet: "Render existing 3D models for visual inspection, or clean geometry, unwrap UV and export another format.", promptGuidelines: modelGuidelines,
    parameters: Type.Object({ source: Type.String(), clean_geometry: Type.Optional(Type.Boolean()), merge_distance: Type.Optional(Type.Number({ minimum: 0, maximum: 0.01 })), components: Type.Optional(Type.Union([Type.Literal("keep_all"), Type.Literal("largest"), Type.Literal("min_faces")])), min_component_faces: Type.Optional(Type.Integer({ minimum: 1, maximum: 100000 })), recalculate_normals: Type.Optional(Type.Boolean()), smooth_normals: Type.Optional(Type.Boolean()), unwrap_uv: Type.Optional(Type.Boolean()), export_format: Type.Optional(Type.Union([Type.Literal("glb"), Type.Literal("obj"), Type.Literal("fbx"), Type.Literal("stl"), Type.Literal("ply")])), render_views: Type.Optional(Type.Boolean()), view_count: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })), render_size: Type.Optional(Type.Integer({ minimum: 64, maximum: 2048, multipleOf: 64 })), elevation: Type.Optional(Type.Number({ minimum: -80, maximum: 80 })), transparent_background: Type.Optional(Type.Boolean()), blender_path: Type.Optional(Type.String()) }),
    async execute(_id, params, signal, update) {
      const prefix = modelJobPrefix();
      const { source, ...options } = params;
      const inputs = { clean_geometry: false, merge_distance: 0.000001, components: "keep_all", min_component_faces: 20, recalculate_normals: true, smooth_normals: false, unwrap_uv: false, export_format: "glb", render_views: false, view_count: 8, render_size: 512, elevation: 25, transparent_background: true, blender_path: processingDefaults.blender_path, ...options, source_path: await modelSource(source), output_prefix: prefix };
      return runModelTool(dataDir, { asset: { class_type: "ModelAssetUtilities", inputs } }, prefix, ["asset"], signal, text => update?.({ content: [{ type: "text", text }], details: {} }), inputs.render_views);
    },
  });
}
