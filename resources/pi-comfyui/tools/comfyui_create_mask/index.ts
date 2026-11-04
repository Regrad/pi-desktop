import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadComfySettings, checkComfyConnection, listComfyMusicAdapters, runComfy, runInstrumentalComfy, editComfyMusicVocals, type ComfyInput } from "../../lib/comfy-client.js";
import type { ComfyMode } from "../../shared/comfy.js";
import { listHistoryImages, resolveHistoryImage } from "../../shared/image-attachments.js";
import { imagePathForTool, publishImage } from "../../lib/image-input.js";
import type { ToolContext } from "../../lib/context.js";

export default function register(pi: ExtensionAPI, context: ToolContext) {
  const { dataDir, reportText, generationStatus, vocalMode, musicOptions } = context;
  const point = Type.Object({ x: Type.Integer({ minimum: 0 }), y: Type.Integer({ minimum: 0 }) });
  pi.registerTool({
    name: "media_create_mask", label: "Выделение объекта SAM 3.1",
    description: "Create a selection mask locally with SAM 3.1 without redrawing the source. image is one original path or attachment: reference. targets are short English object concepts; max_objects caps detections per concept (default 1). For specific instances use original pixel-coordinate positive/negative points or boxes. Text, boxes and points can produce a UNION, not an intersection: use boxes/points alone for spatial targeting. Returns same-size grayscale PNG (white selected/edit, black preserve) and selection preview on black background. Inspect both before passing mask_path to media_inpaint_image; masks can miss objects or include unwanted ones.",
    promptSnippet: "Choose media_create_mask for semantic objects/complex contours, scripts for exact geometric regions, or reuse user masks.",
    promptGuidelines: [
      "Choose the simplest useful selection method: reuse an existing user mask; use a script for exact rectangles, circles or polygons; use media_create_mask for people, objects and complex outlines. Broad Qwen edits can work directly without a mask.",
      "Use short English object names, not edit instructions. Default selects one highest-confidence instance per concept; increase max_objects explicitly to select several. Coordinates refer to the original image in pixels, not a resized screenshot. For spatial targeting prefer boxes/points alone; adding text combines selections rather than restricting them.",
      "Inspect the mask and selection preview before editing. When the selection is wrong or empty, refine the description or points/boxes and retry. threshold changes confidence, not area. Pass mask_path, not preview_path, to inpaint (red channel). Segmentation is not guaranteed perfect matting for hair, glass or translucency. To show an intermediate mask to the user call desktop_show_image.",
    ],
    parameters: Type.Object({
      image: Type.String({ description: "Original absolute file path or attachment: reference" }),
      targets: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 160 }), { minItems: 1, maxItems: 8 })),
      max_objects: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      positive_points: Type.Optional(Type.Array(point, { maxItems: 64 })),
      negative_points: Type.Optional(Type.Array(point, { maxItems: 64 })),
      boxes: Type.Optional(Type.Array(Type.Object({ x: Type.Integer({ minimum: 0 }), y: Type.Integer({ minimum: 0 }), width: Type.Integer({ minimum: 1 }), height: Type.Integer({ minimum: 1 }) }), { maxItems: 16 })),
      threshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      refine_iterations: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const { image, ...selection } = params;
      const result = await runComfy(dataDir, "segment", { ...selection, images: [image] }, signal,
        text => onUpdate?.({ content: [{ type: "text", text }], details: {} }),
        reference => resolveHistoryImage(ctx.sessionManager.getBranch(), reference));
      const mask = result.images.find(output => output.nodeId === "save_mask");
      const preview = result.images.find(output => output.nodeId === "save_preview");
      if (!mask || !preview) throw new Error("SAM3 не вернул маску и предпросмотр выделения");
      return {
        content: [
          { type: "text", text: JSON.stringify({ mask_path: mask.path, preview_path: preview.path, source: image, source_size: result.inputDimensions[0], convention: "white=selected/edit; black=preserve", warning: "Inspect both images before editing. Mask first; selection on black background second." }) },
          { type: "image", data: mask.data, mimeType: mask.mimeType },
          { type: "image", data: preview.data, mimeType: preview.mimeType },
        ],
        details: { promptId: result.promptId, files: [mask.path, preview.path], displayInAnswer: false, maskPath: mask.path, previewPath: preview.path, maskFor: image },
      };
    },
  });

}
