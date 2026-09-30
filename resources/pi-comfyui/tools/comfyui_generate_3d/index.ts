import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadComfySettings, checkComfyConnection, listComfyMusicAdapters, runComfy, runInstrumentalComfy, editComfyMusicVocals, type ComfyInput } from "../../lib/comfy-client.js";
import type { ComfyMode } from "../../shared/comfy.js";
import { listHistoryImages, resolveHistoryImage } from "../../shared/image-attachments.js";
import { imagePathForTool, publishImage } from "../../lib/image-input.js";
import type { ToolContext } from "../../lib/context.js";

export default function register(pi: ExtensionAPI, context: ToolContext) {
  const { dataDir, reportText, generationStatus, vocalMode, musicOptions } = context;
  pi.registerTool({
    name: "comfyui_generate_3d", label: "Генерация 3D-модели",
    description: "Generate a textured GLB model locally with Pixal3D/Trellis2. Supply exactly one image, or exactly four consistent views ordered front, left, back, right. Use original absolute paths or attachment: references from comfyui_list_attachments. If cropping an attachment first, call desktop_get_image_path for that one image and crop the returned path; do not search Temp. For a text-only request, first generate an image with comfyui_generate_image, then pass its saved path here. model3d_options controls polygon budget, shape/remesh detail and baked texture quality; leave defaults unless requested. target_face_count is an upper target, not an exact final count; 0 disables decimation. Higher resolutions and AO samples use more time/VRAM. Returns real model paths; the chat shows an interactive 3D viewer. No animation or rigging is provided. The GLB is not visual input to the language model: do not claim to have inspected the model.",
    promptSnippet: "Generate textured 3D models locally from one image or four views; show an interactive model in chat.",
    parameters: Type.Object({
      images: Type.Array(Type.String(), { minItems: 1, maxItems: 4, description: "One image, or four views in order: front, left, back, right. Absolute paths or attachment: references." }),
      seed: Type.Optional(Type.Integer({ minimum: 0 })),
      model3d_options: Type.Optional(Type.Object({
        target_face_count: Type.Optional(Type.Integer({ minimum: 0, maximum: 50000000, description: "Maximum target polygon faces after remeshing. 0 disables decimation; final count is not guaranteed exact. Default 700000." })),
        remesh_resolution: Type.Optional(Type.Integer({ minimum: 32, maximum: 2048, description: "Voxel grid density before decimation. Default 768; higher is slower and uses more VRAM." })),
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
        content: [{ type: "text", text: `3D generation completed. Saved GLB models:\n${result.models.map((model) => model.path).join("\n")}\nJob: ${result.promptId}. Returned ${result.models.length} of ${result.totalModels} models. Interactive preview is available to the user; model geometry was not supplied to the language model.` }],
        details: { promptId: result.promptId, files: result.models.map((model) => model.path), media: result.models.map((model) => ({ type: "model3d", ...model })) },
      };
    },
  });

}
