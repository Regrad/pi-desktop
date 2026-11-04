import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadComfySettings, checkComfyConnection, listComfyMusicAdapters, runComfy, runInstrumentalComfy, editComfyMusicVocals, type ComfyInput } from "../../lib/comfy-client.js";
import type { ComfyMode } from "../../shared/comfy.js";
import { listHistoryImages, resolveHistoryImage } from "../../shared/image-attachments.js";
import { imagePathForTool, publishImage } from "../../lib/image-input.js";
import type { ToolContext } from "../../lib/context.js";
import { instrumentalGuidelines } from "../../lib/music-instructions.js";

export default function register(pi: ExtensionAPI, context: ToolContext) {
  const { dataDir, reportText, generationStatus, vocalMode, musicOptions } = context;
  pi.registerTool({
    name: "media_edit_vocals", label: "Убрать вокал из нот YuE2",
    description: "Create a NEW ABC file locally from a saved YuE2 two-voice ABC plan. instrumental_lead moves Vocal melody to Ins and retains non-overlapping fills; accompaniment_only silences Vocal and retains only existing Ins accompaniment. Original ABC remains unchanged. This edits notes, not recorded audio. Then pass the returned abc_file to media_generate_instrumental_music with the same mode for checked rendering. Unsupported ABC fails without writing output. A score without Vocal notes does not prove the generated audio has no voice.",
    promptSnippet: "For a vocal-free version of YuE2 music, plan ABC first, then choose instrumental lead or accompaniment-only and render the edited ABC. This is not audio stem separation.",
    promptGuidelines: instrumentalGuidelines,
    parameters: Type.Object({
      abc_file: Type.String({ description: "Absolute path to an existing YuE2 two-voice .abc score." }),
      mode: vocalMode,
    }),
    async execute(_id, params) {
      const result = await editComfyMusicVocals(dataDir, params.abc_file, params.mode);
      return { content: [{ type: "text", text: `Vocal-free ABC saved: ${result.abcFile}\nVerification: ${JSON.stringify(result.report)}\nOriginal ABC unchanged. This is symbolic score editing, not verification of audible vocal absence. Render with media_generate_instrumental_music, abc_file=${result.abcFile}, mode=${params.mode}.` }], details: { files: [result.abcFile] } };
    },
  });

}
