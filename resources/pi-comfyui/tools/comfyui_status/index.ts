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
    name: "comfyui_status", label: "Подключение ComfyUI",
    description: "Check configured local ComfyUI, available image/3D profiles and installed YuE2 LoRA/LoKr adapters. Call before selecting a YuE2 adapter name. All processing stays on the local/LAN server.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      const settings = await loadComfySettings(dataDir);
      if (!settings.enabled) return { content: [{ type: "text", text: "ComfyUI disabled. Enable it in Pi Desktop settings → ComfyUI." }], details: {} };
      const connection = await checkComfyConnection(settings.url, signal);
      const adapters = await listComfyMusicAdapters(settings.url, signal).catch(error => {
        if (signal?.aborted) throw error;
        return [`unavailable: ${error instanceof Error ? error.message : String(error)}`];
      });
      const text = `${connection}\nYuE2 adapters: ${adapters.join(", ") || "not available"}\n${JSON.stringify(settings)}`;
      return { content: [{ type: "text", text }], details: {} };
    },
  });

}
