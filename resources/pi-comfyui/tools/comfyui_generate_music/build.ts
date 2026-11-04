import { randomUUID } from "node:crypto";
import type { ComfySettings } from "../../shared/comfy.js";
import type { ComfyInput } from "../../lib/comfy-client.js";
import { workflow as music } from "./workflow.js";
import { workflow as music_cover } from "../comfyui_cover_music/workflow.js";
const MUSIC_GRAPHS = { music, music_cover };
type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
export function musicGraph(settings: ComfySettings, mode: "music" | "music_cover", input: ComfyInput): Graph {
  const graph = structuredClone(MUSIC_GRAPHS[mode]) as Graph;
  const findEntry = (type: string) => {
    const entry = Object.entries(graph).find(([, node]) => node.class_type === type);
    if (!entry) throw new Error(`Во встроенном YuE2 workflow нет узла ${type}`);
    return entry;
  };
  const find = (type: string) => {
    const node = findEntry(type)[1];
    if (!node) throw new Error(`Во встроенном YuE2 workflow нет узла ${type}`);
    return node.inputs;
  };
  find("YuE2NativePipelineLoader").checkpoint = settings.musicCheckpoint;
  find("PrimitiveInt").value = input.seed ?? Math.floor(Math.random() * 2 ** 48);
  find("YuE2StyleBuilder").extra = input.prompt ?? "";
  find("YuE2LyricsStructurer").lyrics_text = input.lyrics ?? "";
  find("KSampler").steps = input.steps ?? settings.musicSteps;
  if (input.duration !== undefined) find("YuE2NativeGenerateMusic").max_duration = input.duration;
  if (mode === "music_cover") find("LoadAudio").audio = input.audio ?? "";
  if (mode === "music_cover" && input.keep_harmony !== undefined) {
    find("YuE2NativeAudioToABC").mode = input.keep_harmony ? "full" : "melody";
    find("YuE2NativeGenerateMusic").mode = input.keep_harmony ? "full" : "melody";
  }
  if (input.abc_text) find("YuE2ABCModifier").abc = input.abc_text;
  const optionNodes: Record<string, string> = {
    vram: "YuE2MemoryPreset", language: "YuE2StyleBuilder", genre: "YuE2StyleBuilder", secondary_genres: "YuE2StyleBuilder",
    era: "YuE2StyleBuilder", vocal: "YuE2StyleBuilder", instruments: "YuE2StyleBuilder", drums: "YuE2StyleBuilder",
    mood: "YuE2StyleBuilder", tempo: "YuE2StyleBuilder", structure: "YuE2LyricsStructurer",
    verse_lines: "YuE2LyricsStructurer", section_plan: "YuE2LyricsStructurer",
    tempo_mode: "YuE2ABCModifier", bpm: "YuE2ABCModifier", tempo_multiplier: "YuE2ABCModifier",
    transpose_scope: "YuE2ABCModifier", semitones: "YuE2ABCModifier", remove_chords: "YuE2ABCModifier",
    drop_sections: "YuE2ABCModifier", vocal_transpose: "YuE2ABCModifier", instrumental_transpose: "YuE2ABCModifier",
    octave_shift: "YuE2ABCModifier", target_voice: "YuE2VocalRangeRetarget", manual_semitones: "YuE2VocalRangeRetarget",
    remove_notes_shorter_than_ms: "YuE2MelodyCleanup", remove_pitch_outliers: "YuE2MelodyCleanup",
    outlier_semitones: "YuE2MelodyCleanup", adapter: "YuE2NativeUniversalAdapterLoader",
    ar_strength: "YuE2NativeUniversalAdapterLoader", nar_strength: "YuE2NativeUniversalAdapterLoader",
    headroom_percent: "YuE2ABCDurationBudget", tail_seconds: "YuE2ABCDurationBudget",
    adapter_enabled: "YuE2NativeUniversalAdapterLoader",
    abc_max_tokens: "YuE2NativeGenerateABC", abc_temperature: "YuE2NativeGenerateABC",
    abc_top_p: "YuE2NativeGenerateABC", abc_top_k: "YuE2NativeGenerateABC",
    abc_repetition_penalty: "YuE2NativeGenerateABC", abc_penalty_window: "YuE2NativeGenerateABC",
    music_temperature: "YuE2NativeGenerateMusic", music_top_p: "YuE2NativeGenerateMusic",
    music_top_k: "YuE2NativeGenerateMusic", music_repetition_penalty: "YuE2NativeGenerateMusic",
  };
  for (const [key, value] of Object.entries(input.music_options ?? {})) {
    if (!["string", "number", "boolean"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value))) throw new Error(`Некорректная настройка YuE2: ${key}`);
    if (key === "analysis_language") continue;
    if (key.startsWith("abc_") && (mode === "music_cover" || input.abc_text)) throw new Error("Настройки генерации ABC не применяются к каверу или готовому нотному плану");
    const type = optionNodes[key] ?? ({ vocal_range_mode: "YuE2VocalRangeRetarget", cleanup_preset: "YuE2MelodyCleanup" } as Record<string, string>)[key];
    if (!type) throw new Error(`Неизвестная настройка YuE2: ${key}`);
    const name = key === "vocal_range_mode" ? "mode" : key === "cleanup_preset" ? "preset" : key === "adapter_enabled" ? "enabled" : key === "abc_max_tokens" ? "max_abc_tokens" : key.startsWith("abc_") ? key.slice(4) : key.startsWith("music_") ? key.slice(6) : key;
    find(type)[name] = value;
  }
  if (mode === "music_cover" && input.keep_harmony !== undefined) find("YuE2ABCModifier").remove_chords = !input.keep_harmony;
  const abc = findEntry("YuE2MelodyCleanup")[0];
  const style = findEntry("YuE2StyleBuilder")[0];
  const lyrics = findEntry("YuE2LyricsStructurer")[0];
  const modifier = findEntry("YuE2ABCModifier")[0];
  const range = findEntry("YuE2VocalRangeRetarget")[0];
  const cleanup = findEntry("YuE2MelodyCleanup")[0];
  const budget = findEntry("YuE2ABCDurationBudget")[0];
  const report = (name: string, source: [string, number]) => { graph[`pi_${name}`] = { class_type: "PreviewAny", inputs: { source } }; };
  report("abc", [abc, 0]);
  report("style", [style, 0]);
  report("effective_lyrics", [lyrics, 0]);
  report("modifier", [modifier, 1]);
  report("range", [range, 2]);
  report("cleanup", [cleanup, 1]);
  report("duration", [budget, 3]);
  if (!input.plan_only) {
    const generator = findEntry("YuE2NativeGenerateMusic")[0];
    report("generation_limit", [generator, 4]);
    report("generation_info", [generator, 5]);
    report("generated_seconds", [generator, 3]);
  }
  if (input.lyrics?.trim()) {
    report("lyrics", [lyrics, 1]);
    graph.pi_analysis_node = { class_type: "YuE2ABCAnalyzer", inputs: { abc: [abc, 0] } };
    report("analysis", ["pi_analysis_node", 0]);
    const analysisLanguage = (input.music_options as Record<string, unknown> | undefined)?.analysis_language;
    graph.pi_fit_node = { class_type: "YuE2LyricsMelodyFit", inputs: { abc: [abc, 0], lyrics: [lyrics, 0], language: analysisLanguage === "English" ? "English" : "generic" } };
    report("fit", ["pi_fit_node", 0]);
  } else {
    graph.pi_analysis_node = { class_type: "YuE2ABCAnalyzer", inputs: { abc: [abc, 0] } };
    report("analysis", ["pi_analysis_node", 0]);
  }
  const roots = Object.keys(graph).filter(id => id.startsWith("pi_") && graph[id].class_type === "PreviewAny");
  if (!input.plan_only) roots.push("10");
  const used = new Set<string>();
  const visit = (id: string) => {
    if (used.has(id)) return;
    const node = graph[id];
    if (!node) throw new Error(`YuE2 workflow: нет зависимости ${id}`);
    used.add(id);
    for (const value of Object.values(node.inputs)) if (Array.isArray(value) && typeof value[0] === "string" && Number.isInteger(value[1])) visit(value[0]);
  };
  roots.forEach(visit);
  for (const id of Object.keys(graph)) if (!used.has(id)) delete graph[id];
  return graph;

}
