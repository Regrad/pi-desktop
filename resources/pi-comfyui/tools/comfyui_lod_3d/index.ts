import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ToolContext } from "../../lib/context.js";
import { modelGuidelines, processingDefaults } from "../../lib/model3d-options.js";
import { modelSource, modelJobPrefix, runModelTool } from "../../lib/model3d-tools.js";

export default function register(pi: ExtensionAPI, { dataDir }: ToolContext) {
  pi.registerTool({
    name: "comfyui_lod_3d", label: "Создать LOD 3D-модели",
    description: "Create 1–6 decreasing polygon-budget LODs of an existing model using ModelLODGenerator. Optionally transfer source textures and bake normal/AO per LOD. Every LOD GLB and its maps/report are saved; original is unchanged. Targets are approximate triangle budgets, not exact counts. Source must be accessible to ComfyUI.",
    promptSnippet: "Create multiple textured LODs from an existing mesh without regenerating its shape.", promptGuidelines: modelGuidelines,
    parameters: Type.Object({ source: Type.String(), triangle_counts: Type.Array(Type.Integer({ minimum: 100, maximum: 2000000 }), { minItems: 1, maxItems: 6, description: "Strictly decreasing target counts, e.g. [30000,15000,5000]." }), transfer_textures: Type.Optional(Type.Boolean()), texture_resolution: Type.Optional(Type.Integer({ minimum: 64, maximum: 8192, multipleOf: 64 })), bake_normal: Type.Optional(Type.Boolean()), bake_ao: Type.Optional(Type.Boolean()), blender_path: Type.Optional(Type.String()) }),
    async execute(_id, params, signal, update) {
      if (params.triangle_counts.some((n, i) => i > 0 && n >= params.triangle_counts[i - 1])) throw new Error("Количество треугольников LOD должно строго уменьшаться");
      const prefix = modelJobPrefix();
      const inputs = { source_path: await modelSource(params.source), triangle_counts: params.triangle_counts.join(","), transfer_textures: params.transfer_textures ?? true, texture_resolution: params.texture_resolution ?? 2048, bake_normal: params.bake_normal ?? true, bake_ao: params.bake_ao ?? false, blender_path: params.blender_path ?? processingDefaults.blender_path, output_prefix: prefix };
      return runModelTool(dataDir, { lod: { class_type: "ModelLODGenerator", inputs } }, prefix, ["lod"], signal, text => update?.({ content: [{ type: "text", text }], details: {} }));
    },
  });
}
