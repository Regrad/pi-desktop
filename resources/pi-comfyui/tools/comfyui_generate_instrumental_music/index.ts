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
    name: "media_generate_instrumental_music", label: "Инструментальная музыка YuE2",
    description: "Generate a NEW vocal-free YuE2 track in one call. For 'instrumental', 'no vocals', or music without singing choose instrumental_lead: plan ABC with [Instrumental], inspect Vocal notes, move any Vocal melody to Ins while preserving non-overlapping accompaniment, then render and verify the final ABC. For 'minus', 'backing track', or accompaniment without lead melody choose accompaniment_only: silence Vocal notes and keep only existing Ins accompaniment; reject an empty accompaniment. If the ABC already has no Vocal notes, keep it unchanged. Optionally start from source audio (transcribed to ABC) OR an existing abc_file; otherwise make a new score from prompt. For a cover, keep_harmony=false allows new accompaniment; true preserves transcribed chords. Source audio is not split into stems: a NEW track is generated. Automatic duration is the default; set a maximum for a concrete timing request. Inspect generation_limit: reached means the ending may be truncated. Symbolic verification cannot guarantee that the audio model never hallucinates a voice; the model cannot listen to the audio.",
    promptSnippet: "For requested instrumental YuE2 music, use this one-call tool: instrumental_lead keeps the melody as instruments; accompaniment_only makes a minus from existing accompaniment. [Instrumental] is the required lyrics marker.",
    promptGuidelines: instrumentalGuidelines,
    parameters: Type.Object({
      prompt: Type.String({ description: "Musical style and instrumentation; sung words belong in the lyrics field for vocal music." }),
      mode: vocalMode,
      audio: Type.Optional(Type.String({ description: "Absolute path to a source recording to transcribe to ABC first; not stem separation. Cannot be combined with abc_file." })),
      abc_file: Type.Optional(Type.String({ description: "Absolute path to an existing YuE2 ABC plan. Cannot be combined with audio." })),
      keep_harmony: Type.Optional(Type.Boolean({ description: "For an audio or ABC cover: true preserves source chords; false allows YuE2 to create new accompaniment. Default for audio is false." })),
      duration: Type.Optional(Type.Number({ minimum: 1, maximum: 900, description: "Optional maximum for a concrete requested track length or time limit." })),
      seed: Type.Optional(Type.Integer({ minimum: 0 })),
      steps: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      music_options: Type.Optional(musicOptions),
    }),
    async execute(_id, params, signal, onUpdate) {
      const result = await runInstrumentalComfy(dataDir, { ...params, vocal_mode: params.mode }, signal, text => onUpdate?.({ content: [{ type: "text", text }], details: {} }));
      return {
        content: [{ type: "text", text: `YuE2 instrumental ${generationStatus(result.generationLimitReached)}. Saved tracks:\n${result.audio.map(audio => audio.path).join("\n")}\nSource ABC: ${result.sourceAbcFile}\nFinal ABC: ${result.abcFile}\nGeneration record: ${result.recordFile}\nReports:\n${reportText(result.reports)}\nJob: ${result.promptId}. Audio has not been provided for listening to the language model.` }],
        details: { promptId: result.promptId, files: [...result.audio.map(audio => audio.path), ...(result.abcFile ? [result.abcFile] : []), ...(result.recordFile ? [result.recordFile] : []), ...(result.plannedHere ? [result.sourceAbcFile] : [])], media: result.audio.map(audio => ({ type: "audio", ...audio })) },
      };
    },
  });

}
