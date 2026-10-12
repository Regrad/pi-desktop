import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ToolContext } from "../../lib/context.js";
import { modelGuidelines } from "../../lib/model3d-options.js";
import { modelSource, uploadModelImage, modelJobPrefix } from "../../lib/model3d-tools.js";
import { runApiWorkflow } from "../../lib/workflow.js";
import { resolveHistoryImage } from "../../shared/image-attachments.js";
import { TEXTURE_GRAPH } from "./workflow.js";

export function textureGraph(source: string, image: string, options: { seed?: number; steps?: number; cfg?: number; denoise?: number; encoder_resolution?: number; texture_resolution?: number; padding?: number; weld_distance?: number; shape_encoder?: string }) {
  const graph = structuredClone(TEXTURE_GRAPH);
  graph["1"].inputs.image = image;
  graph["5"].inputs.mesh_filename = source;
  graph["5"].inputs.resolution = options.encoder_resolution ?? 512;
  graph["5"].inputs.shape_encoder = options.shape_encoder ?? "shape_enc_next_dc_f16c32_fp16.safetensors";
  Object.assign(graph["8"].inputs, { seed: options.seed ?? Math.floor(Math.random() * 2 ** 48), steps: options.steps ?? 12, cfg: options.cfg ?? 1, denoise: options.denoise ?? 1 });
  Object.assign(graph["11"].inputs, { resolution: options.texture_resolution ?? 2048, padding: options.padding ?? 4, weld_distance: options.weld_distance ?? 0 });
  graph["12"].inputs.texture_size = options.texture_resolution ?? 2048;
  graph["15"].inputs.filename_prefix = `${modelJobPrefix()}/retextured`;
  return graph;
}

export default function register(pi: ExtensionAPI, { dataDir }: ToolContext) {
  pi.registerTool({
    name: "comfyui_texture_3d", label: "Текстурирование 3D-модели по изображению",
    description: "Generate new color, metallic and roughness appearance on an existing mesh with Trellis2MeshEncoder and a reference image; return a self-contained textured GLB. Not texture copying: for exact appearance transfer use comfyui_process_3d with source, target and transfer_textures=true. Encoder/UV processing may change normalization/UV; originals are preserved. Requires Trellis2 encoder/model files on ComfyUI. Source path must be accessible on the ComfyUI computer; image paths/attachment: references are uploaded automatically. Keep workflow defaults unless needed; changing seed gives another texture variant. GLB is not visual input: use render_views for inspection.",
    promptSnippet: "Retexture an existing 3D mesh from a reference image, without image-to-shape regeneration.", promptGuidelines: modelGuidelines,
    parameters: Type.Object({ source: Type.String(), image: Type.String(), seed: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })), steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), cfg: Type.Optional(Type.Number({ minimum: 0, maximum: 20 })), denoise: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })), encoder_resolution: Type.Optional(Type.Integer({ minimum: 256, maximum: 2048, multipleOf: 128 })), texture_resolution: Type.Optional(Type.Integer({ minimum: 64, maximum: 8192, multipleOf: 64 })), padding: Type.Optional(Type.Integer({ minimum: 0, maximum: 64 })), weld_distance: Type.Optional(Type.Number({ minimum: 0, maximum: 0.01 })), shape_encoder: Type.Optional(Type.String()) }),
    async execute(_id, params, signal, update, ctx) {
      const source = await modelSource(params.source);
      const image = await uploadModelImage(dataDir, params.image, signal, reference => resolveHistoryImage(ctx.sessionManager.getBranch(), reference));
      const result = await runApiWorkflow(dataDir, textureGraph(source, image, params), { kind: "model", outputNodes: ["15"] }, signal, text => update?.({ content: [{ type: "text", text }], details: {} }));
      return { content: [{ type: "text", text: `Textured model saved:\n${result.files.map(file => file.path).join("\n")}\nJob: ${result.promptId}. GLB is not visual input; render views before judging appearance.` }], details: { promptId: result.promptId, files: result.files.map(file => file.path), media: result.files.map(file => ({ type: "model3d", path: file.path, mimeType: file.mimeType })) } };
    },
  });
}
