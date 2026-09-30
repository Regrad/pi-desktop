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
    async execute() {
      const settings = await loadComfySettings(dataDir);
      const text = settings.enabled ? `${await checkComfyConnection(settings.url)}\nYuE2 adapters: ${(await listComfyMusicAdapters(settings.url)).join(", ") || "not available"}\n${JSON.stringify(settings)}` : "ComfyUI disabled. Enable it in Pi Desktop settings → ComfyUI.";
      return { content: [{ type: "text", text }], details: {} };
    },
  });

}
