import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ToolContext } from "../../lib/context.js";
import { speechParameters, speechGraph, uploadSpeechReference, runSpeech } from "../../lib/omnivoice.js";

export default function register(pi: ExtensionAPI, { dataDir }: ToolContext) {
  pi.registerTool({
    name: "comfyui_clone_voice", label: "OmniVoice: реплики персонажа",
    description: "Speak new dialogue locally with OmniVoice using a reference voice. audio is an absolute audio path, including outputs of comfyui_design_voice; uploaded automatically. ref_text is the exact transcript of THAT sample, never the new dialogue. If unknown explicitly set auto_transcribe=true (Whisper may download once; review accuracy). Reuse the same sample for stable character identity. All generation settings and supported speaker attributes are available; combining attributes with a reference can change its voice. No arbitrary emotion labels or guaranteed Russian stress control. Leave duration automatic unless requested. Returns playable saved audio.",
    parameters: Type.Object({ ...speechParameters, audio: Type.String({ minLength: 1 }), ref_text: Type.Optional(Type.String()), auto_transcribe: Type.Optional(Type.Boolean()), asr_model_name: Type.Optional(Type.Union(["openai/whisper-large-v3-turbo", "openai/whisper-large-v3", "distil-whisper/distil-large-v3", "openai/whisper-medium", "openai/whisper-small", "openai/whisper-base", "openai/whisper-tiny"].map(value => Type.Literal(value)), { description: "Optional reference ASR model, default whisper-small; may download." })), asr_device: Type.Optional(Type.String({ description: "Reference ASR device; default cpu to avoid a second TTS copy on GPU." })) }),
    async execute(_id, params, signal, update) {
      const voice = { audio: params.audio, ref_text: params.ref_text ?? "", auto_transcribe: params.auto_transcribe, asr_model_name: params.asr_model_name, asr_device: params.asr_device };
      speechGraph(params, voice);
      voice.audio = await uploadSpeechReference(dataDir, params.audio, signal);
      return runSpeech(dataDir, speechGraph(params, voice), signal, text => update?.({ content: [{ type: "text", text }], details: {} }));
    },
  });
}
