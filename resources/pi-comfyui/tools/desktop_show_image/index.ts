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
    name: "desktop_show_image", label: "Показать изображение в ответе",
    description: "Publish an existing local PNG/JPEG/WebP or attachment: image directly in the chat answer, outside collapsed tools. Use this when the user asks to see an image, including images made with scripts or downloaded into the workspace. read is for inspection, not publication. Copies only the explicitly selected image into portable image-generation storage; never scans directories. Works even when ComfyUI is disabled.",
    promptSnippet: "Show an existing image in the chat answer with desktop_show_image; read alone does not publish it.",
    parameters: Type.Object({ image: Type.String({ description: "Absolute local path or attachment: reference" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const image = await publishImage(dataDir, params.image, reference => resolveHistoryImage(ctx.sessionManager.getBranch(), reference));
      return { content: [{ type: "text", text: `Image displayed in the chat answer. Portable copy: ${image.path}` }, { type: "image", data: image.data, mimeType: image.mimeType }], details: { files: [image.path], displayInAnswer: true } };
    },
  });

}
