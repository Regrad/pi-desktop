import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { writeFile } from "node:fs/promises";
import { runComfy } from "../../lib/comfy-client.js";
import { resolveHistoryImage } from "../../shared/image-attachments.js";
import type { ToolContext } from "../../lib/context.js";
import { processingProperties, modelGuidelines } from "../../lib/model3d-options.js";
import { modelSummary } from "./model-summary.js";

export default function register(pi: ExtensionAPI, context: ToolContext) {
  const { dataDir, reportText } = context;
  pi.registerTool({
    name: "media_generate_3d", label: "Генерация 3D-модели",
    description: "Generate a textured GLB from one image or four views ordered front, left, back, right. Pixal3D/Trellis2 geometry is prepared as a solid mesh, reduced to the requested triangle budget, and given a high-to-low normal map and UltraTex PBR textures. Defaults: 12000 triangles, 2K textures. target_face_count controls approximate reduction, not native generation at that count; 0 skips final reduction. Accepts absolute image paths or attachment: references. The finished model appears in the chat's interactive viewer; the language model receives file metadata, not visual geometry.",
    promptSnippet: "Generate textured 3D models locally from one image or four views; show an interactive model in chat.",
    promptGuidelines: [...modelGuidelines,
      "Use the supplied reference and requirements; ask only about missing choices that materially affect the result. Reuse agreed settings on retries.",
      "Default output is one solid static mesh with watertight preparation and baked normal/PBR maps. Use component_mode=auto for intentional separate parts. One-image generation supports Pixal3D or Trellis2; four views guide Pixal3D geometry. Texturing uses the front reference to generate six views on the actual mesh; enable use_view_references only for extra texture references aligned with that mesh.",
      "Preserve the reference's intended low-poly style. For a texture-only defect, reuse the finished mesh with media_texture_3d instead of regenerating geometry or adding automatic smoothing, remeshing or repeated repair passes.",
      "The default completion is the first finished GLB in the interactive viewer. Choose additional rendered views or another iteration when the request or a meaningful validation need justifies them.",
      "The generated result stays at its requested generation budget and texture resolution. Use postprocess only for an explicitly requested repair, retopology, polygon reduction or texture reduction. Inspect returned processing reports, not just the success label."],
    parameters: Type.Object({
      images: Type.Array(Type.String(), { minItems: 1, maxItems: 4, description: "One image, or four views in order: front, left, back, right. Absolute paths or attachment: references." }),
      seed: Type.Optional(Type.Integer({ minimum: 0 })),
      postprocess: Type.Optional(Type.Object(processingProperties)),
      texture_options: Type.Optional(Type.Object({
        steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Texture sampling steps per PBR branch; default 25. Lower values trade quality for speed." })), cfg: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })),
        use_view_references: Type.Optional(Type.Boolean({ description: "Hold fitted side/back reference pixels during texturing; default false. Enable only when those views align with the generated mesh, otherwise clothing boundaries and facial details can be misplaced." })),
        albedo_resolution: Type.Optional(Type.Integer({ minimum: 256, maximum: 4096, multipleOf: 16 })),
        mr_resolution: Type.Optional(Type.Integer({ minimum: 256, maximum: 4096, multipleOf: 16 })),
        memory_factor: Type.Optional(Type.Union([Type.Literal(0), Type.Number({ minimum: 4, maximum: 64, multipleOf: 0.5 })], { description: "Activation-memory estimate; 0 uses the installed default." })),
        attention: Type.Optional(Type.Literal("ultratex_sparse")),
        sparse_topk: Type.Optional(Type.Number({ minimum: 0.05, maximum: 1 })),
        token_chunk: Type.Optional(Type.Integer({ minimum: 0, maximum: 32768, multipleOf: 256 })),
      })),
      model3d_options: Type.Optional(Type.Object({
        geometry_model: Type.Optional(Type.Union([Type.Literal("pixal3d"), Type.Literal("trellis2")], { description: "Geometry model; default Pixal3D. Trellis2 accepts one image." })),
        target_face_count: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000000, description: "Approximate final triangle target, default 12000. 0 skips final reduction; the high-poly preparation cap remains 6 million." })),
        watertight: Type.Optional(Type.Boolean({ description: "Solid-mesh preparation before normal/PBR baking; default true. False skips reconstruction and voxel rebuilding." })),
        watertight_resolution: Type.Optional(Type.Integer({ minimum: 1024, maximum: 2048, multipleOf: 512, description: "Solid-mesh reconstruction resolution; default 1536. Higher uses more memory and time." })),
        watertight_proxy_points: Type.Optional(Type.Integer({ minimum: 1000000, maximum: 25000000, multipleOf: 1000000, description: "Reconstruction proxy budget, default 12000000. Higher uses more RAM and time." })),
        component_mode: Type.Optional(Type.Union([Type.Literal("largest"), Type.Literal("auto"), Type.Literal("keep_all")], { description: "Output components: largest for one solid asset (default), auto for intentional separate parts, keep_all only when every fragment matters." })),
        shape_resolution: Type.Optional(Type.Integer({ minimum: 1024, maximum: 2048, multipleOf: 128, description: "Trellis upsampled shape resolution. Default 1536; higher uses more VRAM." })),
        texture_resolution: Type.Optional(Type.Integer({ minimum: 512, maximum: 8192, multipleOf: 512, description: "Normal map, UV atlas and PBR texture size; default 2048." })),
      })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (![1, 4].includes(params.images.length)) throw new Error("Нужно одно изображение или четыре ракурса");
      const result = await runComfy(dataDir, params.images.length === 1 ? "model3d" : "model3d_multiview", params, signal,
        (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }),
        (reference) => resolveHistoryImage(ctx.sessionManager.getBranch(), reference));
      const summary = await Promise.all(result.models.map(async model => ({ file: model.path, ...await modelSummary(model.path) })));
      const reports = { ...result.reports, model_summary: JSON.stringify(summary) };
      const recordFile = `${result.models[0].path}.generation.json`;
      await writeFile(recordFile, JSON.stringify({ job: result.promptId, request: { seed: params.seed, model3d_options: params.model3d_options, texture_options: params.texture_options }, models: summary }, null, 2), { encoding: "utf8", flag: "wx" });
      return {
        content: [{ type: "text", text: `3D generation completed. Saved GLB models:\n${result.models.map((model) => model.path).join("\n")}\nReport: ${recordFile}\n${reportText(reports)}\nJob: ${result.promptId}. Returned ${result.models.length} of ${result.totalModels} models. Interactive preview is available to the user; model geometry was not supplied to the language model.` }],
        details: { promptId: result.promptId, files: [...result.models.map((model) => model.path), recordFile], reports, media: result.models.map((model) => ({ type: "model3d", ...model })) },
      };
    },
  });

}
