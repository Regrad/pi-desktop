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
    name: "comfyui_list_attachments", label: "Изображения из чата",
    description: "List the latest 20 user image attachments in this chat. Use the original absolute path when available. Pasted clipboard images have no original path: pass their attachment: reference directly to ComfyUI image/3D tools. If a command, script or precise crop requires a path, call desktop_get_image_path with just the chosen reference. Never search Temp or guess a filename. Listing does not copy images.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const images = listHistoryImages(ctx.sessionManager.getBranch()).slice(-20);
      return { content: [{ type: "text", text: JSON.stringify(images) }], details: {} };
    },
  });

}
