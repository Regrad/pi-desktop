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
    name: "media_status", label: "Доступность медиа-инструментов",
    description: "Check availability of built-in image, music, speech and 3D tools and list available YuE2 adapters. Call before selecting an adapter name.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      const settings = await loadComfySettings(dataDir);
      if (!settings.enabled) return { content: [{ type: "text", text: "Media tools are disabled in application settings." }], details: {} };
      await checkComfyConnection(settings.url, signal);
      const adapters = await listComfyMusicAdapters(settings.url, signal).catch(error => {
        if (signal?.aborted) throw error;
        return ["adapter list unavailable"];
      });
      const text = JSON.stringify({ available: true, operations: ["image", "music", "speech", "3d"], music_adapters: adapters });
      return { content: [{ type: "text", text }], details: {} };
    },
  });

}
