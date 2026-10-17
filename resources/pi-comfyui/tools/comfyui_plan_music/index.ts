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
    name: "comfyui_plan_music", label: "Нотный план YuE2",
    description: "Create or revise a YuE2 ABC score without rendering audio. For a new song provide lyrics with section labels; for instrumental music use lyrics=[Instrumental] as the required marker. For a cover provide audio (absolute local path); to revise a plan provide abc_file. Return a portable ABC path plus reports. For a complete instrumental or minus in one call, prefer comfyui_generate_instrumental_music, which checks and handles Vocal notes automatically. The automatic score budget supplies duration by default.",
    promptSnippet: "Plan music first as an editable ABC file; inspect reports, revise the file if needed, then render audio from that ABC.",
    promptGuidelines: instrumentalGuidelines,
    parameters: Type.Object({
      prompt: Type.Optional(Type.String({ description: "Style description; required when generating a new ABC plan from text, optional for analyzing source audio or an existing ABC." })),
      lyrics: Type.Optional(Type.String({ description: "Section-labelled lyrics; required for a new song plan, optional for cover/ABC analysis." })),
      audio: Type.Optional(Type.String({ description: "Absolute source audio path for a cover plan; text-only planning uses prompt and lyrics instead." })),
      abc_file: Type.Optional(Type.String({ description: "Absolute path to an existing .abc file to revise/analyze." })),
      seed: Type.Optional(Type.Integer({ minimum: 0 })),
      music_options: Type.Optional(musicOptions),
    }),
    async execute(_id, params, signal, onUpdate) {
      const mode = params.audio ? "music_cover" : "music";
      const result = await runComfy(dataDir, mode, { ...params, plan_only: true }, signal, text => onUpdate?.({ content: [{ type: "text", text }], details: {} }));
      return {
        content: [{ type: "text", text: `ABC plan saved: ${result.abcFile}\nReports:\n${reportText(result.reports)}\nNo audio was rendered. For instrumental music, pass this abc_file to comfyui_generate_instrumental_music with mode=instrumental_lead (or accompaniment_only for an explicitly requested minus). For a song with singing, use the generation or cover tool. Zero Vocal notes checks the score only, not whether the rendered audio contains a voice.` }],
        details: { promptId: result.promptId, files: result.abcFile ? [result.abcFile] : [] },
      };
    },
  });

}
