import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadComfySettings, checkComfyConnection, listComfyMusicAdapters, runComfy, runInstrumentalComfy, editComfyMusicVocals, type ComfyInput } from "../../lib/comfy-client.js";
import type { ComfyMode } from "../../shared/comfy.js";
import { listHistoryImages, resolveHistoryImage } from "../../shared/image-attachments.js";
import { imagePathForTool, publishImage } from "../../lib/image-input.js";
import type { ToolContext } from "../../lib/context.js";
import { processingProperties, modelGuidelines } from "../../lib/model3d-options.js";

export default function register(pi: ExtensionAPI, context: ToolContext) {
  const { dataDir, reportText, generationStatus, vocalMode, musicOptions } = context;
  pi.registerTool({
    name: "media_generate_3d", label: "Генерация 3D-модели",
    description: "Generate a textured GLB locally: Pixal3D/Trellis2 builds geometry, then UltraTex FLUX.2 Klein creates PBR textures. Supply one image or four views ordered front, left, back, right; image paths and attachment: references are supported. A positive target_face_count performs approximate mesh reduction, not native generation at that face count; 0 skips final decimation. Postprocessing runs only when requested. The result is displayed in an interactive viewer; GLB geometry is not visual input to the language model.",
    promptSnippet: "Generate textured 3D models locally from one image or four views; show an interactive model in chat.",
    promptGuidelines: [...modelGuidelines,
      "Before the first generation, briefly confirm use and style, references, solid or multipart geometry, removable internal parts, polygon and texture targets, and rig or animation needs. Reuse these answers on retries.",
      "Use the default watertight=true and component_mode=largest for one solid game mesh. Use component_mode=auto for intentional separate parts. Valid closed geometry is repaired without resampling; damaged topology receives one WTiVo reconstruction.",
      "The default completion is the first finished GLB in the interactive viewer. Choose additional rendered views or another iteration when the request or a meaningful validation need justifies them.",
      "The generated result stays at its requested generation budget and texture resolution. Use postprocess only for an explicitly requested repair, retopology, polygon reduction or texture reduction. Inspect returned processing reports, not just the success label."],
    parameters: Type.Object({
      images: Type.Array(Type.String(), { minItems: 1, maxItems: 4, description: "One image, or four views in order: front, left, back, right. Absolute paths or attachment: references." }),
      seed: Type.Optional(Type.Integer({ minimum: 0 })),
      postprocess: Type.Optional(Type.Object(processingProperties)),
      texture_options: Type.Optional(Type.Object({
        steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), cfg: Type.Optional(Type.Number({ minimum: 0, maximum: 30 })),
        albedo_resolution: Type.Optional(Type.Integer({ minimum: 256, maximum: 4096, multipleOf: 16 })),
        mr_resolution: Type.Optional(Type.Integer({ minimum: 256, maximum: 4096, multipleOf: 16 })),
        memory_factor: Type.Optional(Type.Number({ minimum: 0, maximum: 200 })),
        attention: Type.Optional(Type.Union([Type.Literal("ultratex_sparse"), Type.Literal("standard")])),
        sparse_topk: Type.Optional(Type.Number({ minimum: 0.05, maximum: 1 })),
        token_chunk: Type.Optional(Type.Integer({ minimum: 0, maximum: 131072, multipleOf: 1024 })),
      })),
      model3d_options: Type.Optional(Type.Object({
        target_face_count: Type.Optional(Type.Integer({ minimum: 0, maximum: 50000000, description: "Final mesh decimation target (default 700000), approximate; not a native generation size. 0 disables decimation." })),
        watertight: Type.Optional(Type.Boolean({ description: "Run solid-mesh cleanup before UV and texture baking. Default true; valid shells use Manifold, damaged topology falls back to WTiVo." })),
        watertight_resolution: Type.Optional(Type.Integer({ minimum: 1024, maximum: 2048, multipleOf: 512, description: "Resolution used only by the WTiVo fallback. Default 1536; use 2048 only when maximum detail is explicitly needed." })),
        watertight_proxy_points: Type.Optional(Type.Integer({ minimum: 1000000, maximum: 25000000, multipleOf: 1000000, description: "Proxy budget used only by the WTiVo fallback. Default 16000000; use 25000000 with the explicit 2048 maximum-detail mode." })),
        component_mode: Type.Optional(Type.Union([Type.Literal("largest"), Type.Literal("auto"), Type.Literal("keep_all")], { description: "Output components: largest for one solid asset (default), auto for intentional separate parts, keep_all only when every fragment matters." })),
        shape_resolution: Type.Optional(Type.Integer({ minimum: 1024, maximum: 2048, multipleOf: 128, description: "Trellis upsampled shape resolution. Default 1536; higher uses more VRAM." })),
        texture_resolution: Type.Optional(Type.Integer({ minimum: 512, maximum: 8192, multipleOf: 512, description: "UV atlas and UltraTex PBR texture size. Default 4096." })),
      })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (![1, 4].includes(params.images.length)) throw new Error("Нужно одно изображение или четыре ракурса");
      const result = await runComfy(dataDir, params.images.length === 1 ? "model3d" : "model3d_multiview", params, signal,
        (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }),
        (reference) => resolveHistoryImage(ctx.sessionManager.getBranch(), reference));
      return {
        content: [{ type: "text", text: `3D generation completed. Saved GLB models:\n${result.models.map((model) => model.path).join("\n")}\nReport: ${result.recordFile ?? "not supplied by custom operation"}\n${reportText(result.reports)}\nJob: ${result.promptId}. Returned ${result.models.length} of ${result.totalModels} models. Interactive preview is available to the user; model geometry was not supplied to the language model.` }],
        details: { promptId: result.promptId, files: [...result.models.map((model) => model.path), ...(result.recordFile ? [result.recordFile] : [])], reports: result.reports, media: result.models.map((model) => ({ type: "model3d", ...model })) },
      };
    },
  });

}
