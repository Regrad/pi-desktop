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
    name: "comfyui_generate_3d", label: "Генерация 3D-модели",
    description: "Generate a textured GLB model locally with Pixal3D/Trellis2. Supply exactly one image, or exactly four consistent views ordered front, left, back, right. Use original absolute paths or attachment: references from comfyui_list_attachments. For a text-only request, first generate an image with comfyui_generate_image, then pass its saved path here. The default solid workflow first unions valid closed components with Manifold, removing enclosed surfaces without resampling the exterior. Only damaged topology falls back to one standard WTiVo reconstruction at 1536/16M; 2048/25M is available when maximum detail is explicitly needed. The result must pass a watertight audit, then the graph produces about 700000 triangles and bakes 4096 textures. No separate low-poly copy or texture downscale is made unless explicitly requested through postprocess. Returns real model paths; the chat shows an interactive 3D viewer. No animation or rigging is provided. Visual inspection requires rendered images because the GLB itself is not visual input to the language model.",
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
      model3d_options: Type.Optional(Type.Object({
        target_face_count: Type.Optional(Type.Integer({ minimum: 0, maximum: 50000000, description: "Generated mesh budget (default 700000); approximate. This does not create a second low-poly copy. 0 disables final decimation." })),
        watertight: Type.Optional(Type.Boolean({ description: "Run solid-mesh cleanup before UV and texture baking. Default true; valid shells use Manifold, damaged topology falls back to WTiVo." })),
        watertight_resolution: Type.Optional(Type.Integer({ minimum: 1024, maximum: 2048, multipleOf: 512, description: "Resolution used only by the WTiVo fallback. Default 1536; use 2048 only when maximum detail is explicitly needed." })),
        watertight_proxy_points: Type.Optional(Type.Integer({ minimum: 1000000, maximum: 25000000, multipleOf: 1000000, description: "Proxy budget used only by the WTiVo fallback. Default 16000000; use 25000000 with the explicit 2048 maximum-detail mode." })),
        component_mode: Type.Optional(Type.Union([Type.Literal("largest"), Type.Literal("auto"), Type.Literal("keep_all")], { description: "Output components: largest for one solid asset (default), auto for intentional separate parts, keep_all only when every fragment matters." })),
        shape_resolution: Type.Optional(Type.Integer({ minimum: 1024, maximum: 2048, multipleOf: 128, description: "Trellis upsampled shape resolution. Default 1536; higher uses more VRAM." })),
        texture_resolution: Type.Optional(Type.Integer({ minimum: 64, maximum: 8192, multipleOf: 64, description: "UV unwrap and color/metallic/roughness texture size. Default 4096." })),
        normal_map_resolution: Type.Optional(Type.Integer({ minimum: 64, maximum: 8192, multipleOf: 64, description: "Baked normal-map size. Default 2048." })),
        ao_resolution: Type.Optional(Type.Integer({ minimum: 64, maximum: 8192, multipleOf: 64, description: "Baked ambient-occlusion map size. Default 1024." })),
        ao_samples: Type.Optional(Type.Integer({ minimum: 4, maximum: 1024, multipleOf: 4, description: "Ambient-occlusion rays per texel. Default 64; more is smoother but slower." })),
      })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (![1, 4].includes(params.images.length)) throw new Error("Нужно одно изображение или четыре ракурса");
      const result = await runComfy(dataDir, params.images.length === 1 ? "model3d" : "model3d_multiview", params, signal,
        (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }),
        (reference) => resolveHistoryImage(ctx.sessionManager.getBranch(), reference));
      return {
        content: [{ type: "text", text: `3D generation completed. Saved GLB models:\n${result.models.map((model) => model.path).join("\n")}\nReport: ${result.recordFile ?? "not supplied by custom workflow"}\n${reportText(result.reports)}\nJob: ${result.promptId}. Returned ${result.models.length} of ${result.totalModels} models. Interactive preview is available to the user; model geometry was not supplied to the language model.` }],
        details: { promptId: result.promptId, files: [...result.models.map((model) => model.path), ...(result.recordFile ? [result.recordFile] : [])], reports: result.reports, media: result.models.map((model) => ({ type: "model3d", ...model })) },
      };
    },
  });

}
