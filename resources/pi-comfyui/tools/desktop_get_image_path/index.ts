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
    name: "desktop_get_image_path", label: "Путь к изображению из чата",
    description: "Get a usable absolute local path for ONE selected chat image. For a pasted clipboard image, pass its attachment: reference from comfyui_list_attachments; only that image is saved on demand in portable data/chat-attachments, without publishing it to the chat. Repeated calls for the same bytes reuse the same file. For an original absolute file path, validate and return it without copying. Use this authoritative path before file-based scripts or exact cropping. ComfyUI image/3D tools can instead use attachment: directly.",
    promptSnippet: "Pasted chat images have no original disk path. Resolve the selected attachment: reference with desktop_get_image_path before shell scripts or cropping.",
    parameters: Type.Object({ image: Type.String({ description: "One attachment: reference from comfyui_list_attachments, or an existing absolute PNG/JPEG/WebP path." }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const image = await imagePathForTool(dataDir, params.image, reference => resolveHistoryImage(ctx.sessionManager.getBranch(), reference));
      return { content: [{ type: "text", text: `Selected image path: ${image.path}\nSize: ${image.width}x${image.height}. Use this path for file-based tools or cropping.` }], details: { files: [image.path], displayInAnswer: false } };
    },
  });

}
