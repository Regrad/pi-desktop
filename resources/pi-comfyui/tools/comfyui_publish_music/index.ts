import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ToolContext } from "../../lib/context.js";
import { selectMusicForAnswer } from "../../lib/music-publication.js";
import { musicPublicationGuidelines } from "../../lib/music-instructions.js";

export default function register(pi: ExtensionAPI, { dataDir }: ToolContext) {
  pi.registerTool({
    name: "comfyui_publish_music",
    label: "Выбрать треки для ответа",
    description: "Explicitly select ready music-generation audio files to display as players in the final chat answer. Pass exactly the tracks the user should see, in the desired order: e.g. 2 selected variants from 10 generated tracks. Can publish existing tracks from earlier turns using their saved absolute paths, without generating again. A successful call REPLACES the entire audio selection for the current answer; [] selects no tracks. Generated tracks remain in their tools until the final answer completes. No files are deleted or modified. Works when ComfyUI is disabled. Audible quality comparisons require evidence because the language model cannot listen to audio.",
    promptSnippet: "Before finishing a music answer, call comfyui_publish_music with the complete ordered list of exact saved track paths; this call controls the audio players.",
    promptGuidelines: musicPublicationGuidelines,
    parameters: Type.Object({
      tracks: Type.Array(Type.String({ description: "Absolute path to a ready audio file in Pi Desktop data/music-generation, from this request or chat history." }), { maxItems: 64, description: "Complete ordered selection for this answer. Replaces any previous selection; [] hides all audio players in the final answer." }),
    }),
    async execute(_id, params, signal) {
      const media = await selectMusicForAnswer(dataDir, params.tracks, signal);
      return {
        content: [{ type: "text", text: `Final answer audio selection replaced: ${media.length} track(s).\n${media.map(part => part.path).join("\n")}\nOnly these tracks will be published when the final answer completes. No audio was provided for listening to the language model.` }],
        details: { files: media.map(part => part.path), media, audioSelection: true, displayInAnswer: true },
      };
    },
  });
}
