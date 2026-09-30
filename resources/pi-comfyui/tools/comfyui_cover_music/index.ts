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
    name: "comfyui_cover_music", label: "Кавер YuE2",
    description: "Create a YuE2 melody-based cover from source audio or abc_file. For a vocal-free variation use comfyui_generate_instrumental_music with source audio or the saved abc_file and the intended mode; keep_harmony controls source chords. This regenerates audio, not stem separation. The model cannot listen to audio.",
    promptSnippet: "Make local YuE2 covers with vocals from saved audio or ABC. For an instrumental cover or minus, use comfyui_generate_instrumental_music so the score is checked and Vocal notes are handled automatically.",
    promptGuidelines: instrumentalGuidelines,
    parameters: Type.Object({
      audio: Type.Optional(Type.String({ description: "Absolute path to source audio. Required unless abc_file is supplied. Uploaded only to configured local/LAN ComfyUI." })),
      abc_file: Type.Optional(Type.String({ description: "Absolute path to a saved .abc plan instead of source audio; useful after editing the plan." })),
      prompt: Type.String({ description: "New musical style and performance direction." }),
      lyrics: Type.Optional(Type.String({ description: "Words to sing with English section labels, e.g. [Verse] and [Chorus], or [Instrumental]. Required unless vocal_mode is set." })),
      vocal_mode: Type.Optional(vocalMode),
      keep_harmony: Type.Optional(Type.Boolean({ description: "For cover source audio or ABC: true retains chords; false removes chords for a new accompaniment. Omit to preserve existing behavior." })),
      duration: Type.Optional(Type.Number({ minimum: 1, maximum: 900, description: "Only when explicitly requested; maximum seconds." })),
      seed: Type.Optional(Type.Integer({ minimum: 0 })),
      steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      music_options: Type.Optional(musicOptions),
    }),
    async execute(_id, params, signal, onUpdate) {
      const result = await runComfy(dataDir, "music_cover", params, signal, text => onUpdate?.({ content: [{ type: "text", text }], details: {} }));
      return {
        content: [{ type: "text", text: `YuE2 cover ${generationStatus(result.generationLimitReached)}. Saved tracks:\n${result.audio.map(audio => audio.path).join("\n")}\nABC plan: ${result.abcFile ?? "not returned"}\nGeneration record: ${result.recordFile}\nReports:\n${reportText(result.reports)}\nJob: ${result.promptId}. Returned ${result.audio.length} of ${result.totalAudio} tracks. Audio has not been provided for listening to the language model.` }],
        details: { promptId: result.promptId, files: [...result.audio.map(audio => audio.path), ...(result.abcFile ? [result.abcFile] : []), ...(result.recordFile ? [result.recordFile] : [])], media: result.audio.map(audio => ({ type: "audio", ...audio })) },
      };
    },
  });

}
