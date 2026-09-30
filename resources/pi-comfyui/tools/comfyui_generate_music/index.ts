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
    name: "comfyui_generate_music", label: "Генерация музыки YuE2",
    description: "Generate songs with vocals locally with YuE2. lyrics contains sung words with English section labels [Verse], [Chorus], [Bridge], [Outro]. For any request for instrumental music, no vocals, or a minus, prefer comfyui_generate_instrumental_music instead: it plans, checks, transforms and verifies ABC automatically. Omit duration unless explicitly requested. The model cannot listen to the audio.",
    promptSnippet: "Generate songs locally with YuE2 using separate style and section-labelled lyrics.",
    promptGuidelines: [
      ...instrumentalGuidelines,
      "Omit duration unless the user explicitly requests a track length or time limit. The advanced workflow's ABC duration budget supplies the default. When explicitly requested, duration is a maximum in seconds.",
      "When generating a YuE2 song, put language, musical style and performance directions in prompt; put only section labels and words to sing in lyrics. Use English labels such as [Verse], [Chorus], [Bridge], [Outro], optionally [Intro], [Pre-Chorus], [Interlude]. Preserve these labels even when the lyrics are Russian. Do not remove them.",
      "Example lyrics format: [Verse]\\nFirst lyric line\\nSecond lyric line\\n\\n[Chorus]\\nChorus lyric line\\n\\n[Bridge]\\nBridge lyric line\\n\\n[Outro]\\nFinal lyric line. Replace the example words with the requested lyrics; spell out repeated choruses instead of writing 'repeat chorus'.",
      "Use target_voice only to retarget melody pitch range, not to change the singer identity. For LoRA/LoKr, first call comfyui_status to see installed adapter names; 'none' has no effect. Leave all advanced options at workflow defaults unless the user requests a change or the ABC reports justify one.",
      "For instrumental or minus requests, use comfyui_generate_instrumental_music. It passes [Instrumental] lyrics, never an empty lyrics field, and checks Vocal/Ins notes before and after generation.",
    ],
    parameters: Type.Object({
      prompt: Type.String(),
      lyrics: Type.Optional(Type.String({ description: "Song lyrics with English section labels on separate lines: [Verse], [Chorus], [Bridge], [Outro], or [Instrumental]. Required unless vocal_mode is set." })),
      duration: Type.Optional(Type.Number({ minimum: 1, maximum: 900, description: "Set only when the user explicitly requests a duration. Otherwise the workflow calculates its duration budget from ABC. This is a maximum, not an exact length." })),
      abc_file: Type.Optional(Type.String({ description: "Absolute path to an existing .abc score to revise/render instead of generating a new plan. Use the file returned by comfyui_plan_music or a locally edited copy." })),
      vocal_mode: Type.Optional(vocalMode),
      seed: Type.Optional(Type.Integer({ minimum: 0 })),
      steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      music_options: Type.Optional(musicOptions),
    }),
    async execute(_id, params, signal, onUpdate) {
      const result = await runComfy(dataDir, "music", params, signal, (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }));
      return {
        content: [{ type: "text", text: `YuE2 ${generationStatus(result.generationLimitReached)}. Saved tracks:\n${result.audio.map((audio) => audio.path).join("\n")}\nABC plan: ${result.abcFile ?? "not returned"}\nGeneration record: ${result.recordFile}\nReports:\n${reportText(result.reports)}\nJob: ${result.promptId}. Returned ${result.audio.length} of ${result.totalAudio} tracks. Audio has not been provided for listening to the language model.` }],
        details: { promptId: result.promptId, files: [...result.audio.map((audio) => audio.path), ...(result.abcFile ? [result.abcFile] : []), ...(result.recordFile ? [result.recordFile] : [])], media: result.audio.map((audio) => ({ type: "audio", ...audio })) },
      };
    },
  });

}
