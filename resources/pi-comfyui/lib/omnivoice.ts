import { Type, type Static } from "typebox";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadComfySettings, request } from "./comfy-client.js";
import { runApiWorkflow } from "./workflow.js";

const gender = ["male", "female"];
const age = ["child", "teenager", "young adult", "middle-aged", "elderly"];
const pitch = ["very low pitch", "low pitch", "moderate pitch", "high pitch", "very high pitch"];
const accents = ["american accent", "australian accent", "british accent", "canadian accent", "chinese accent", "indian accent", "japanese accent", "korean accent", "portuguese accent", "russian accent"];
const dialects: Record<string, string> = {
  "henan dialect": "河南话", "shaanxi dialect": "陕西话", "sichuan dialect": "四川话", "guizhou dialect": "贵州话",
  "yunnan dialect": "云南话", "guilin dialect": "桂林话", "jinan dialect": "济南话", "shijiazhuang dialect": "石家庄话",
  "gansu dialect": "甘肃话", "ningxia dialect": "宁夏话", "qingdao dialect": "青岛话", "northeast dialect": "东北话",
};
const presets: Record<string, string[]> = {
  none: [], "female narrator": ["female", "middle-aged", "moderate pitch"], "male narrator": ["male", "middle-aged", "low pitch"],
  "young bright female": ["female", "young adult", "high pitch"], "warm elderly male": ["male", "elderly", "low pitch"],
  "soft whisper female": ["female", "young adult", "whisper"], "soft whisper male": ["male", "young adult", "whisper"],
  "british female": ["female", "young adult", "british accent"], "british male": ["male", "young adult", "british accent"],
  "american female": ["female", "young adult", "american accent"], "american male": ["male", "young adult", "american accent"],
  "sichuan female": ["female", "young adult", "四川话"], "northeast male": ["male", "middle-aged", "东北话"],
};
const translations: Record<string, string> = {
  "男": "male", "女": "female", "儿童": "child", "少年": "teenager", "青年": "young adult", "中年": "middle-aged", "老年": "elderly",
  "极低音调": "very low pitch", "低音调": "low pitch", "中音调": "moderate pitch", "高音调": "high pitch", "极高音调": "very high pitch", "耳语": "whisper",
};
const categories = [gender, age, pitch, ["whisper"], accents, Object.values(dialects)];
const choice = (values: string[], description: string) => Type.Optional(Type.Union(values.map(value => Type.Literal(value)), { description }));
export const speechParameters = {
  text: Type.String({ minLength: 1, description: "Exact speech text in its original language. Preserve the dialogue language. English ARPABET in brackets and Chinese numbered pinyin are supported; Russian stress marks are not guaranteed." }),
  language: Type.Optional(Type.String({ description: "Full OmniVoice language name, e.g. Russian, English, Chinese, or Auto. Supports the full installed language list; default Russian." })),
  preset: choice(Object.keys(presets), "Optional starting combination of speaker attributes; explicit attributes override the preset."),
  gender: choice(gender, "Speaker gender."), age: choice(age, "Speaker age group."), pitch: choice(pitch, "Speaker pitch range, not an exact musical frequency."),
  style: choice(["none", "whisper"], "Only whisper is an official style attribute; arbitrary emotion labels are unsupported. none disables preset whisper."),
  english_accent: choice(["none", ...accents], "Applies ONLY to English speech, including russian accent. It is not a Russian-language pronunciation setting."),
  chinese_dialect: choice(["none", ...Object.keys(dialects)], "Applies ONLY to Chinese speech."),
  instruct: Type.Optional(Type.String({ description: "Optional comma-separated OFFICIAL attributes in English/Chinese, not free-form voice descriptions. One value per category; conflicts are errors. Prefer structured fields. Empty attributes let the model choose a voice." })),
  seed: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Variation seed; does not by itself preserve a character's voice. Reuse reference audio for identity." })),
  num_step: Type.Optional(Type.Integer({ minimum: 1, maximum: 128, description: "Diffusion decoding steps, default 32." })),
  guidance_scale: Type.Optional(Type.Number({ minimum: 0, maximum: 20, description: "Classifier-free guidance, default 2." })),
  speed: Type.Optional(Type.Number({ minimum: 0.05, maximum: 8, description: "Speaking speed multiplier, default 1. Greater than 1 is faster. Used only when duration is 0/omitted." })),
  duration: Type.Optional(Type.Number({ minimum: 0, maximum: 3600, description: "Requested generation duration in seconds; 0/omitted is automatic. Overrides speed. Use a fixed duration for a concrete timing target." })),
  t_shift: Type.Optional(Type.Number({ minimum: 0, maximum: 4, description: "Diffusion time-step shift, default 0.1." })),
  denoise: Type.Optional(Type.Boolean({ description: "Denoising conditioning, default true." })),
  preprocess_prompt: Type.Optional(Type.Boolean({ description: "Reference silence cleanup and text punctuation, default true." })),
  postprocess_output: Type.Optional(Type.Boolean({ description: "Remove excessive output silence, default true; edge padding/fades have separate controls." })),
  layer_penalty_factor: Type.Optional(Type.Number({ minimum: 0, maximum: 20, description: "Codebook unmasking layer penalty, default 5." })),
  position_temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 20, description: "Position selection temperature, default 5." })),
  class_temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 20, description: "Token sampling temperature, default 0 (greedy)." })),
  audio_chunk_duration: Type.Optional(Type.Number({ minimum: 0.1, maximum: 120, description: "Long-speech chunk duration in seconds, default 15." })),
  audio_chunk_threshold: Type.Optional(Type.Number({ minimum: 0.1, maximum: 600, description: "Estimated duration above which chunking is enabled, default 30 seconds." })),
  normalize_text: Type.Optional(Type.Boolean({ description: "Optional numbers-to-words normalization, default false. Russian integers supported via num2words; English/Chinese rich normalization needs optional WeTextProcessing." })),
  pad_duration: Type.Optional(Type.Number({ minimum: 0, maximum: 10, description: "Silence added at EACH edge in seconds, default 0.1; 0 disables." })),
  fade_duration: Type.Optional(Type.Number({ minimum: 0, maximum: 10, description: "Fade-in/out duration in seconds, default 0.1; 0 disables." })),
  device: Type.Optional(Type.String({ description: "Inference device, default cuda; auto, cpu, cuda:0, etc." })),
  dtype: choice(["auto", "float16", "float32", "bfloat16"], "Inference precision, default bfloat16."),
};
const speechSchema = Type.Object(speechParameters);
type SpeechOptions = Static<typeof speechSchema>;
type VoiceReference = { audio: string; ref_text: string; auto_transcribe?: boolean; asr_model_name?: string; asr_device?: string };
type ApiGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

export function voiceInstruct(options: SpeechOptions) {
  const selected = new Map<number, string>();
  function add(value: string, overwrite: boolean) {
    value = translations[value] ?? value.toLowerCase();
    const category = categories.findIndex(values => values.includes(value));
    if (category < 0) throw new Error(`OmniVoice: неподдерживаемый атрибут «${value}». Используйте gender, age, pitch, style, english_accent, chinese_dialect; произвольное описание не поддерживается.`);
    if (!overwrite && selected.has(category) && selected.get(category) !== value) throw new Error(`OmniVoice: конфликт атрибутов «${selected.get(category)}» и «${value}»`);
    selected.set(category, value);
  }
  const preset = options.preset ?? "none";
  if (!presets[preset]) throw new Error(`OmniVoice: неизвестный preset ${preset}`);
  for (const value of presets[preset]) add(value, true);
  const explicit = [options.gender, options.age, options.pitch, options.style, options.english_accent, options.chinese_dialect];
  for (let i = 0; i < explicit.length; i++) {
    const value = explicit[i];
    if (value === "none") selected.delete(i);
    else if (value) add(i === 5 ? dialects[value] ?? value : value, true);
  }
  for (const value of (options.instruct ?? "").split(/[,，\n]/).map(part => part.trim()).filter(Boolean)) add(value, false);
  return [...selected.entries()].sort(([a], [b]) => a - b).map(([, value]) => value).join(", ");
}

export function speechGraph(options: SpeechOptions, voice?: VoiceReference): ApiGraph {
  if (!options.text.trim()) throw new Error("Текст реплики не должен быть пустым");
  if (voice && !voice.audio.trim()) throw new Error("Нужен аудиообразец");
  if (voice && !voice.ref_text.trim() && !voice.auto_transcribe) throw new Error("Нужна точная расшифровка образца или auto_transcribe=true; не выдумывайте расшифровку");
  const language = (options.language ?? "russian").trim().toLowerCase();
  const inputs: Record<string, unknown> = {
    model: ["1", 0], text: options.text, language: language === "auto" ? "Auto" : language, ref_text: "", instruct: voiceInstruct(options),
    seed: options.seed ?? Math.floor(Math.random() * 2 ** 48), num_step: options.num_step ?? 32,
    guidance_scale: options.guidance_scale ?? 2, speed: options.speed ?? 1, duration: options.duration ?? 0,
    t_shift: options.t_shift ?? 0.1, denoise: options.denoise ?? true, preprocess_prompt: options.preprocess_prompt ?? true,
    postprocess_output: options.postprocess_output ?? true, layer_penalty_factor: options.layer_penalty_factor ?? 5,
    position_temperature: options.position_temperature ?? 5, class_temperature: options.class_temperature ?? 0,
    audio_chunk_duration: options.audio_chunk_duration ?? 15, audio_chunk_threshold: options.audio_chunk_threshold ?? 30,
    normalize_text: options.normalize_text ?? false, pad_duration: options.pad_duration ?? 0.1, fade_duration: options.fade_duration ?? 0.1,
  };
  const graph: ApiGraph = {
    "1": { class_type: "OmniVoiceLoadModel", inputs: { download_missing_files: false, device: options.device ?? "cuda", dtype: options.dtype ?? "bfloat16" } },
    "3": { class_type: "OmniVoiceGenerate", inputs },
    "9": { class_type: "SaveAudio", inputs: { audio: ["3", 0], filename_prefix: `audio/OmniVoice/PiDesktop/${voice ? "VoiceClone" : "VoiceDesign"}` } },
  };
  if (voice) {
    graph["4"] = { class_type: "LoadAudio", inputs: { audio: voice.audio } };
    let transcript: unknown = voice.ref_text;
    if (!voice.ref_text.trim()) {
      graph["5"] = { class_type: "OmniVoiceTranscribeReference", inputs: { ref_audio: ["4", 0], download_missing_asr_files: true, device: voice.asr_device ?? "cpu", asr_model_name: voice.asr_model_name ?? "openai/whisper-small", custom_asr_model: "" } };
      transcript = ["5", 0];
    }
    graph["6"] = { class_type: "OmniVoiceCreateVoiceClonePrompt", inputs: { model: ["1", 0], ref_audio: ["4", 0], ref_text: transcript, use_ref_text_from_input: true, preprocess_prompt: options.preprocess_prompt ?? true } };
    inputs.voice_clone_prompt = ["6", 0];
  }
  return graph;
}

export async function uploadSpeechReference(dataDir: string, audio: string, signal?: AbortSignal) {
  const extension = path.extname(audio).toLowerCase();
  if (!path.isAbsolute(audio) || ![".wav", ".flac", ".mp3", ".ogg", ".opus", ".m4a"].includes(extension)) throw new Error("Нужен абсолютный путь к аудиообразцу WAV, FLAC, MP3, OGG, OPUS или M4A");
  const info = await stat(audio);
  if (!info.isFile() || info.size < 1 || info.size > 128 * 1024 * 1024) throw new Error("Аудиообразец должен быть файлом до 128 МБ");
  const settings = await loadComfySettings(dataDir);
  if (!settings.enabled) throw new Error("ComfyUI отключён в настройках Pi Desktop");
  const body = new FormData();
  body.append("image", new Blob([new Uint8Array(await readFile(audio))]), `pi-tts-${randomUUID()}${extension}`);
  const uploaded = await (await request(settings.url, "/upload/image", { method: "POST", body }, signal)).json() as { name: string; subfolder?: string };
  if (!uploaded.name || /[\\/\0]/.test(uploaded.name) || /[\\\0]/.test(uploaded.subfolder ?? "") || (uploaded.subfolder ?? "").split("/").some(part => part === "..")) throw new Error("Некорректный путь загруженного аудио");
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
}

export async function runSpeech(dataDir: string, graph: ReturnType<typeof speechGraph>, signal?: AbortSignal, progress?: (text: string) => void) {
  const result = await runApiWorkflow(dataDir, graph, { kind: "audio", outputNodes: ["9"] }, signal, progress);
  return {
    content: [{ type: "text" as const, text: `Speech saved:\n${result.files.map(file => file.path).join("\n")}\nJob: ${result.promptId}. File presence does not verify pronunciation or speaker similarity.` }],
    details: { promptId: result.promptId, files: result.files.map(file => file.path), media: result.files.map(file => ({ type: "audio", path: file.path, mimeType: file.mimeType })) },
  };
}
