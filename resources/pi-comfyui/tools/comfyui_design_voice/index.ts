import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ToolContext } from "../../lib/context.js";
import { speechParameters, speechGraph, runSpeech } from "../../lib/omnivoice.js";

export default function register(pi: ExtensionAPI, { dataDir }: ToolContext) {
  pi.registerTool({
    name: "media_design_voice", label: "OmniVoice: создание голоса",
    description: "Generate spoken dialogue locally with OmniVoice without reference audio. Set supported speaker attributes: gender, age, pitch, whisper style, English accent or Chinese dialect. These use a finite vocabulary rather than free-form descriptions or arbitrary emotions. All attributes are optional (automatic voice). Russian is the default; english_accent applies to English speech. All diffusion, timing, cleanup, padding, fade and text normalization controls are exposed. Automatic duration is the default; use a fixed value for a concrete timing target. Returns playable saved audio rather than music. To preserve a character across lines use generated audio and its exact transcript with media_clone_voice; seed alone does not preserve identity. Russian lexical stress control is not guaranteed.",
    parameters: Type.Object(speechParameters),
    async execute(_id, params, signal, update) {
      return runSpeech(dataDir, speechGraph(params), signal, text => update?.({ content: [{ type: "text", text }], details: {} }));
    },
  });
}
