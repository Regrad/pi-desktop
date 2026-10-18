import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_COMFY_SETTINGS, localComfyUrl, type ComfyMode, type ComfySettings } from "../shared/comfy.js";
import type { HistoryImage } from "../shared/image-attachments.js";
import { MODEL_GRAPHS } from "./comfy-3d-graphs.js";
import { MUSIC_GRAPHS } from "./comfy-music-graphs.js";
import { validateLocalGlb } from "../shared/glb.js";
import { imageGraph, type ImageDimensions } from "../tools/comfyui_generate_image/workflow.js";
import { readImageInput } from "./image-input.js";
import { segmentationGraph, validateSegmentation } from "../tools/comfyui_create_mask/workflow.js";
import { editYuE2VocalScore, type VocalEditMode } from "./yue2-vocal-edit.js";
import { processingInputs, type ProcessingOptions } from "./model3d-options.js";
import { saveModelArtifacts } from "./model3d-artifacts.js";

type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
type Output = { filename: string; subfolder?: string; type?: string };
type Model3dOptions = { target_face_count?: number; watertight?: boolean; watertight_resolution?: number; watertight_proxy_points?: number; component_mode?: "largest" | "auto" | "keep_all"; shape_resolution?: number; texture_resolution?: number; normal_map_resolution?: number; ao_resolution?: number; ao_samples?: number };
type NumericModel3dOption = Exclude<keyof Model3dOptions, "watertight" | "component_mode">;
export type ComfyInput = { prompt?: string; lyrics?: string; duration?: number; audio?: string; abc_file?: string; abc_text?: string; plan_only?: boolean; vocal_mode?: VocalEditMode; keep_harmony?: boolean; music_options?: object; negative_prompt?: string; width?: number; height?: number; seed?: number; images?: string[]; transparent_background?: boolean;
  model3d_options?: Model3dOptions;
  postprocess?: ProcessingOptions;
  mask?: string; mask_channel?: "red" | "green" | "blue" | "alpha"; invert_mask?: boolean; mask_grow?: number; mask_blur?: number;
  padding?: { left: number; top: number; right: number; bottom: number }; feathering?: number;
  canvas_image?: number; reference_resolution?: number; count?: number; steps?: number; cfg?: number; denoise?: number;
  targets?: string[]; threshold?: number; max_objects?: number; refine_iterations?: number;
  positive_points?: { x: number; y: number }[]; negative_points?: { x: number; y: number }[];
  boxes?: { x: number; y: number; width: number; height: number }[] };

export async function loadComfySettings(dataDir: string): Promise<ComfySettings> {
  try {
    const value = JSON.parse(await readFile(path.join(dataDir, "comfyui.json"), "utf8"));
    return normalizeSettings(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return structuredClone(DEFAULT_COMFY_SETTINGS);
  }
}

function normalizeSettings(value: ComfySettings): ComfySettings {
  if (!value || typeof value.enabled !== "boolean") throw new Error("Некорректные настройки ComfyUI");
  const merged = { ...DEFAULT_COMFY_SETTINGS, ...value, workflows: { ...DEFAULT_COMFY_SETTINGS.workflows, ...value.workflows } };
  merged.url = localComfyUrl(merged.url);
  if (merged.workflowFolders !== undefined && (!Array.isArray(merged.workflowFolders) || merged.workflowFolders.length > 20 || merged.workflowFolders.some(folder => typeof folder !== "string" || !path.isAbsolute(folder))))
    throw new Error("Папки workflow: не более 20 абсолютных путей");
  if (!Number.isInteger(merged.steps) || merged.steps < 1 || merged.steps > 100) throw new Error("Количество шагов: от 1 до 100");
  if (!Number.isInteger(merged.musicSteps) || merged.musicSteps < 1 || merged.musicSteps > 100) throw new Error("Шаги YuE2: от 1 до 100");
  for (const key of ["diffusionModel", "textEncoder", "vae", "backgroundModel", "musicCheckpoint", "segmentationCheckpoint"] as const)
    if (typeof merged[key] !== "string" || !merged[key].trim()) throw new Error("Укажите имена моделей");
  for (const entry of Object.values(merged.workflows)) if (typeof entry !== "string") throw new Error("Некорректный workflow");
  return merged;
}

export async function saveComfySettings(dataDir: string, value: ComfySettings): Promise<ComfySettings> {
  const saved = normalizeSettings(value);
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "comfyui.json"), `${JSON.stringify(saved, null, 2)}\n`, "utf8");
  return saved;
}

export function validateGraph(value: unknown): Graph {
  if (!value || typeof value !== "object" || Array.isArray(value) || "nodes" in value)
    throw new Error("Нужен workflow в формате API: в ComfyUI выберите Export (API). Обычный JSON редактора не подходит.");
  const graph = value as Graph;
  if (!Object.keys(graph).length || Object.keys(graph).length > 500) throw new Error("Некорректный размер workflow");
  for (const node of Object.values(graph)) {
    if (!node || typeof node.class_type !== "string" || !node.inputs || typeof node.inputs !== "object") throw new Error("Некорректный API workflow");
    if (Array.isArray(node.inputs)) throw new Error("Входы узла должны быть объектом");
  }
  return graph;
}

export async function importComfyWorkflow(dataDir: string, source: string): Promise<string> {
  const info = await stat(source);
  if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error("Workflow должен быть JSON-файлом до 2 МБ");
  const graph = validateGraph(JSON.parse(await readFile(source, "utf8")));
  const relative = `comfy-workflows/${randomUUID()}.json`;
  await mkdir(path.join(dataDir, "comfy-workflows"), { recursive: true });
  await writeFile(path.join(dataDir, relative), `${JSON.stringify(graph, null, 2)}\n`, "utf8");
  return relative;
}

export async function request(url: string, route: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch(`${localComfyUrl(url)}${route}`, { ...init, redirect: "error", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!response.ok) throw new Error(`ComfyUI ${response.status}: ${(await response.text()).slice(0, 2000)}`);
  return response;
}

export async function limitedBody(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get("content-length")) > limit) { await response.body?.cancel(); throw new Error("Результат превышает допустимый размер"); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("ComfyUI вернул пустой результат");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error("Результат превышает допустимый размер"); }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks, size);
  } finally { reader.releaseLock(); }
}

export async function checkComfyConnection(url: string): Promise<string> {
  const response = await request(url, "/system_stats");
  const info = await response.json() as { system?: { comfyui_version?: string }; devices?: { name: string }[] };
  return `ComfyUI ${info.system?.comfyui_version ?? ""}: ${info.devices?.map((d) => d.name).join(", ") || "подключено"}`;
}

export async function listComfyMusicAdapters(url: string): Promise<string[]> {
  const info = await (await request(url, "/object_info/YuE2NativeUniversalAdapterLoader")).json() as Record<string, { input?: { required?: { adapter?: [unknown] } } }>;
  const choices = info.YuE2NativeUniversalAdapterLoader?.input?.required?.adapter?.[0];
  return Array.isArray(choices) ? choices.filter((value): value is string => typeof value === "string") : [];
}

export function builtinGraph(settings: ComfySettings, mode: ComfyMode, input: ComfyInput, images: string[], sizes: ImageDimensions[] = [], maskName?: string): Graph {
  if (mode === "segment") return segmentationGraph(settings, input, images[0]);
  if (mode === "model3d" || mode === "model3d_multiview") {
    const graph = fillWorkflow(MODEL_GRAPHS[mode], input, images, settings.steps);
    const options = input.model3d_options ?? {};
    const fields: { key: NumericModel3dOption; id: string; name: string; min: number; max: number; step?: number }[] = [
      { key: "target_face_count", id: "186", name: "target_face_count", min: 0, max: 50_000_000 },
      { key: "watertight_resolution", id: "pi_watertight", name: "input_res", min: 1024, max: 2048, step: 512 },
      { key: "watertight_proxy_points", id: "pi_watertight", name: "proxy_points", min: 1_000_000, max: 25_000_000, step: 1_000_000 },
      { key: "shape_resolution", id: "94", name: "target_resolution", min: 1024, max: 2048, step: 128 },
      { key: "texture_resolution", id: "288", name: "value", min: 64, max: 8192, step: 64 },
      { key: "normal_map_resolution", id: "224", name: "resolution", min: 64, max: 8192, step: 64 },
      { key: "ao_resolution", id: "233", name: "resolution", min: 64, max: 8192, step: 64 },
      { key: "ao_samples", id: "233", name: "samples", min: 4, max: 1024, step: 4 },
    ];
    for (const { key, id, name, min, max, step } of fields) {
      const value = options[key];
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < min || value > max || (step && (value - min) % step !== 0))
        throw new Error(`Некорректный параметр 3D ${key}: ${min}–${max}${step ? `, шаг ${step}` : ""}`);
      graph[id].inputs[name] = value;
    }
    if (options.watertight_resolution !== undefined) graph.pi_watertight.inputs.final_res = options.watertight_resolution;
    if (options.watertight !== undefined && typeof options.watertight !== "boolean") throw new Error("Некорректный параметр 3D watertight");
    if (options.component_mode !== undefined) {
      if (!["largest", "auto", "keep_all"].includes(options.component_mode)) throw new Error("Некорректный параметр 3D component_mode");
      graph.pi_watertight.inputs.faithc_component_mode = options.component_mode;
    }
    if (options.watertight === false) {
      for (const node of Object.values(graph)) {
        for (const [name, value] of Object.entries(node.inputs)) {
          if (Array.isArray(value) && value[0] === "pi_watertight") node.inputs[name] = ["202", value[1]];
        }
      }
      delete graph.pi_memory_clean;
      delete graph.pi_watertight;
    }
    const output = mode === "model3d" ? "322" : "372";
    const outputPrefix = `3d/pi-desktop/${randomUUID()}`;
    graph[output].inputs.filename_prefix = outputPrefix;
    if (input.postprocess && Object.keys(input.postprocess).length) {
      graph.pi_model_process = { class_type: "UniversalModelTools", inputs: {
        ...processingInputs(input.postprocess), source_path: "", target_path: "", source_model: ["285", 0], output_prefix: outputPrefix,
      } };
      graph[output].inputs.model_3d = ["pi_model_process", 0];
    }
    return graph;
  }
  if (mode === "music" || mode === "music_cover") {
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
  return imageGraph(settings, mode, input, images, sizes, maskName);
}

export function fillWorkflow(graph: Graph, input: ComfyInput, images: string[], steps: number, maskName?: string): Graph {
  const values: Record<string, unknown> = { prompt: input.prompt ?? "", lyrics: input.lyrics ?? "", duration: input.duration ?? 360, audio: input.audio ?? "", abc: input.abc_text ?? "", negative_prompt: input.negative_prompt ?? "", width: input.width ?? 1024, height: input.height ?? 1024, seed: input.seed ?? Math.floor(Math.random() * 2 ** 48), steps: input.steps ?? steps, count: input.count ?? 1, cfg: input.cfg ?? 1, denoise: input.denoise ?? 1, reference_resolution: input.reference_resolution ?? 0, transparent_background: input.transparent_background ?? false, canvas_image: input.canvas_image ?? 1, mask_channel: input.mask_channel ?? "red", invert_mask: input.invert_mask ?? false, mask_grow: input.mask_grow ?? 0, mask_blur: input.mask_blur ?? 0, feathering: input.feathering ?? 0 };
  if (maskName) values.mask = maskName;
  for (const side of ["left", "top", "right", "bottom"] as const) values[`padding_${side}`] = input.padding?.[side] ?? 0;
  images.forEach((name, i) => { values[`image_${i + 1}`] = name; });
  function fill(value: unknown): unknown {
    if (typeof value === "string") {
      const exact = /^\{\{(\w+)\}\}$/.exec(value);
      if (exact) { if (!(exact[1] in values)) throw new Error(`Нет параметра ${exact[1]} для workflow`); return values[exact[1]]; }
      return value.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => { if (!(key in values)) throw new Error(`Нет параметра ${key}`); return String(values[key]); });
    }
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, fill(v)]));
    return value;
  }
  return validateGraph(fill(graph));
}

async function readYuE2Abc(file: string): Promise<string> {
  if (!path.isAbsolute(file) || !/\.abc$/i.test(file)) throw new Error("Укажите абсолютный путь к сохранённому .abc файлу");
  const info = await stat(file);
  if (!info.isFile() || info.size < 1 || info.size > 1024 * 1024) throw new Error("ABC должен быть файлом до 1 МБ");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file));
  if (!text.trim()) throw new Error("ABC файл пуст");
  return text;
}

export async function editComfyMusicVocals(dataDir: string, file: string, mode: VocalEditMode) {
  const result = editYuE2VocalScore(await readYuE2Abc(file), mode);
  const folder = path.join(dataDir, "music-generation");
  await mkdir(folder, { recursive: true });
  const abcFile = path.join(folder, `${randomUUID()}-${mode}.abc`);
  await writeFile(abcFile, result.abc, { encoding: "utf8", flag: "wx" });
  return { abcFile, report: result.report };
}

export async function runInstrumentalComfy(dataDir: string, input: ComfyInput & { prompt: string; vocal_mode: VocalEditMode }, signal?: AbortSignal, progress?: (text: string) => void) {
  if (!input.prompt.trim()) throw new Error("Опишите стиль инструментальной композиции");
  if (input.audio && input.abc_file) throw new Error("Выберите один источник: аудио или ABC");
  if (!["instrumental_lead", "accompaniment_only"].includes(input.vocal_mode)) throw new Error("Неизвестный режим инструментальной музыки");
  if (input.keep_harmony !== undefined && typeof input.keep_harmony !== "boolean") throw new Error("Сохранение гармонии должно быть true или false");
  if (input.keep_harmony !== undefined && !input.audio && !input.abc_file) throw new Error("Выбор гармонии требует исходное аудио или ABC");
  const mode: ComfyMode = input.audio || (input.abc_file && input.keep_harmony !== undefined) ? "music_cover" : "music";
  let abcFile = input.abc_file;
  if (!abcFile) {
    progress?.("YuE2: создаю нотный план ABC без генерации звука");
    const planned = await runComfy(dataDir, mode, { ...input, keep_harmony: input.audio ? input.keep_harmony ?? false : input.keep_harmony, vocal_mode: undefined, lyrics: "[Instrumental]", plan_only: true }, signal, progress);
    if (!planned.abcFile) throw new Error("YuE2 не вернул нотный план ABC");
    abcFile = planned.abcFile;
  }
  const original = await readYuE2Abc(abcFile);
  const checked = editYuE2VocalScore(original, input.vocal_mode);
  progress?.(checked.report.alreadyInstrumental
    ? "YuE2: вокальных нот нет; инструментальная партия проверена"
    : input.vocal_mode === "instrumental_lead"
      ? "YuE2: вокальная мелодия переносится в инструментальную партию"
      : "YuE2: вокальная партия заменяется паузами, сопровождение сохраняется");
  const scoreOptions = new Set([
    "tempo_mode", "bpm", "tempo_multiplier", "transpose_scope", "semitones", "remove_chords", "drop_sections",
    "vocal_transpose", "instrumental_transpose", "octave_shift", "target_voice", "vocal_range_mode", "manual_semitones",
    "cleanup_preset", "remove_notes_shorter_than_ms", "remove_pitch_outliers", "outlier_semitones",
  ]);
  const renderOptions = Object.fromEntries(Object.entries(input.music_options ?? {}).filter(([key]) => !key.startsWith("abc_") && !scoreOptions.has(key)));
  const rendered = await runComfy(dataDir, mode, {
    ...input, keep_harmony: input.audio ? input.keep_harmony ?? false : input.keep_harmony,
    audio: undefined, abc_file: abcFile, plan_only: false, lyrics: "[Instrumental]",
    music_options: input.abc_file ? input.music_options : renderOptions,
  }, signal, progress);
  return { ...rendered, sourceAbcFile: abcFile, plannedHere: !input.abc_file };
}

export async function runComfy(dataDir: string, mode: ComfyMode, input: ComfyInput, signal?: AbortSignal, progress?: (text: string) => void, resolveAttachment?: (reference: string) => HistoryImage) {
  const settings = await loadComfySettings(dataDir);
  if (!settings.enabled) throw new Error("ComfyUI отключён в настройках Pi Desktop");
  if (mode === "segment" && settings.workflows.segment) throw new Error("Для маски используйте встроенный SAM3 workflow: он возвращает отдельные маску и предпросмотр");
  const model3d = mode === "model3d" || mode === "model3d_multiview";
  if (!model3d && mode !== "remove_background" && mode !== "segment" && !input.prompt?.trim() && !(input.plan_only && (mode === "music" || mode === "music_cover") && (input.audio || input.abc_file))) throw new Error("Укажите описание изображения, изменения или музыки");
  if (mode === "segment") validateSegmentation(input);
  const music = mode === "music" || mode === "music_cover";
  if (input.plan_only && !music) throw new Error("Нотный план ABC доступен только для YuE2");
  if (music && !input.lyrics?.trim() && !input.vocal_mode && !(input.plan_only && (mode === "music_cover" || input.abc_file))) throw new Error("Для YuE2 укажите текст песни с разделами или [Instrumental]");
  if (input.vocal_mode && (!music || !input.abc_file)) throw new Error("Сначала получите ABC через comfyui_plan_music, затем укажите abc_file и vocal_mode");
  const localEdit = mode === "inpaint" || mode === "outpaint";
  if (!music && mode !== "generate" && !input.images?.length) throw new Error("Укажите исходное изображение");
  if (music && input.images?.length) throw new Error("Музыкальный workflow не принимает изображения");
  if (mode === "music_cover" && !input.audio && !input.abc_file) throw new Error("Для кавера укажите исходный аудиофайл или сохранённый ABC");
  if (mode === "music_cover" && input.audio && input.abc_file) throw new Error("Для кавера выберите либо аудиофайл, либо сохранённый ABC");
  if (mode !== "music_cover" && input.audio) throw new Error("Исходное аудио используется только для кавера");
  if (input.abc_file && !music) throw new Error("ABC используется только для YuE2");
  if (input.duration !== undefined && (!Number.isFinite(input.duration) || input.duration < 1 || input.duration > 900)) throw new Error("Длительность YuE2: от 1 до 900 секунд");
  if (mode === "remove_background" && input.images?.length !== 1) throw new Error("Для удаления фона укажите ровно одно изображение");
  if (mode === "extract" && input.images?.length !== 1) throw new Error("Для извлечения объекта укажите одно изображение");
  if ((input.images?.length ?? 0) > 10) throw new Error("Не более 10 изображений");
  if (mode === "model3d" && input.images?.length !== 1) throw new Error("Для 3D укажите одно изображение");
  if (mode === "model3d_multiview" && input.images?.length !== 4) throw new Error("Для 3D по ракурсам нужны четыре изображения: спереди, слева, сзади, справа");
  for (const size of [input.width, input.height]) if (size !== undefined && (!Number.isInteger(size) || size < 32 || size > 4096 || size % 32)) throw new Error("Размеры: от 32 до 4096, кратные 32");
  if (input.seed !== undefined && (!Number.isSafeInteger(input.seed) || input.seed < 0)) throw new Error("Некорректный seed");
  if ((input.width !== undefined) !== (input.height !== undefined)) throw new Error("Задайте ширину и высоту вместе");
  if (input.count !== undefined && (!Number.isInteger(input.count) || input.count < 1 || input.count > 4)) throw new Error("Количество вариантов: 1–4");
  if (input.steps !== undefined && (!Number.isInteger(input.steps) || input.steps < 1 || input.steps > 100)) throw new Error("Количество шагов: 1–100");
  if (input.cfg !== undefined && (!Number.isFinite(input.cfg) || input.cfg < 0 || input.cfg > 20)) throw new Error("CFG: 0–20");
  if (input.denoise !== undefined && (!Number.isFinite(input.denoise) || input.denoise <= 0 || input.denoise > 1)) throw new Error("Denoise: больше 0 и не больше 1");
  if (input.denoise !== undefined && input.denoise < 1 && !input.images?.length) throw new Error("Denoise < 1 требует исходное изображение");
  if (input.reference_resolution !== undefined && (!Number.isInteger(input.reference_resolution) || input.reference_resolution < 0 || input.reference_resolution > 4096 || input.reference_resolution % 32)) throw new Error("Разрешение референсов: 0–4096, кратное 32");
  if (input.canvas_image !== undefined && (!Number.isInteger(input.canvas_image) || input.canvas_image < 1 || input.canvas_image > (input.images?.length ?? 0))) throw new Error("Некорректный номер изображения-холста");
  if (localEdit && (input.width !== undefined || input.height !== undefined || (input.canvas_image ?? 1) !== 1 || (input.count ?? 1) !== 1)) throw new Error("Маска и расширение холста: одно изображение результата, первый вход — холст; размер задаётся оригиналом и padding");
  if (mode === "inpaint" && !input.mask) throw new Error("Нужна маска: белое — изменять, чёрное — сохранять");
  if (input.mask && mode !== "inpaint") throw new Error("Для маски используйте инструмент локального редактирования");
  if (input.mask_channel && !["red", "green", "blue", "alpha"].includes(input.mask_channel)) throw new Error("Некорректный канал маски");
  if (input.mask_grow !== undefined && (!Number.isInteger(input.mask_grow) || Math.abs(input.mask_grow) > 256)) throw new Error("Расширение маски: от -256 до 256");
  if (input.mask_blur !== undefined && (!Number.isInteger(input.mask_blur) || input.mask_blur < 0 || input.mask_blur > 31)) throw new Error("Размытие маски: 0–31");
  if (localEdit && (input.images?.length ?? 0) > 9) throw new Error("Не более 9 изображений плюс маска");
  if (mode === "outpaint" && (!input.padding || !Object.values(input.padding).some(v => v > 0))) throw new Error("Укажите расширение холста по сторонам в пикселях");
  if (input.padding) for (const side of ["left", "top", "right", "bottom"] as const) { const n = input.padding[side]; if (!Number.isInteger(n) || n < 0 || n > 4096 || n % 8) throw new Error("Padding: 0–4096 по стороне, кратное 8"); }
  if (input.feathering !== undefined && (!Number.isInteger(input.feathering) || input.feathering < 0 || input.feathering > 256)) throw new Error("Растушёвка: 0–256");
  let abcText: string | undefined;
  let vocalReport: ReturnType<typeof editYuE2VocalScore>["report"] | undefined;
  if (input.abc_file) {
    abcText = await readYuE2Abc(input.abc_file);
    if (input.vocal_mode) {
      const edited = editYuE2VocalScore(abcText, input.vocal_mode);
      abcText = edited.abc;
      vocalReport = edited.report;
    }
  }
  const musicInput = input.vocal_mode ? {
    ...input,
    prompt: `Instrumental, no singing, no choir, no spoken words. ${input.prompt ?? ""}`,
    lyrics: "[Instrumental]",
    music_options: { ...input.music_options, vocal: "" },
  } : input;
  const images: string[] = [];
  const sources = await Promise.all((input.images ?? []).map(reference => readImageInput(reference, resolveAttachment)));
  if (mode === "segment") validateSegmentation(input, sources[0]);
  const maskSource = input.mask ? await readImageInput(input.mask, resolveAttachment) : undefined;
  if (maskSource && Math.abs(maskSource.width / maskSource.height - sources[0].width / sources[0].height) > 0.01) throw new Error("Маска должна иметь те же пропорции, что и холст");
  const sizes = sources.map(({ width, height }) => ({ width, height }));
  const original = sizes[(input.canvas_image ?? 1) - 1];
  if (original && localEdit && (original.width + (input.padding?.left ?? 0) + (input.padding?.right ?? 0) > 4096 || original.height + (input.padding?.top ?? 0) + (input.padding?.bottom ?? 0) > 4096)) throw new Error("Холст с расширением не должен превышать 4096 по стороне");
  let maskName: string | undefined;
  for (const [index, source] of [...sources, ...(maskSource ? [maskSource] : [])].entries()) {
    const body = new FormData();
    body.append("image", new Blob([new Uint8Array(source.bytes)]), `pi-${randomUUID()}${source.extension}`);
    const uploaded = await (await request(settings.url, "/upload/image", { method: "POST", body }, signal)).json() as { name: string; subfolder?: string };
    const name = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
    if (index === sources.length) maskName = name; else images.push(name);
  }
  let uploadedAudio: string | undefined;
  if (mode === "music_cover" && !abcText) {
    const source = input.audio!;
    if (!path.isAbsolute(source) || !/\.(flac|wav|mp3|ogg|opus|m4a)$/i.test(source)) throw new Error("Для кавера нужен абсолютный путь к FLAC, WAV, MP3, OGG, OPUS или M4A");
    const fileInfo = await stat(source);
    if (!fileInfo.isFile() || fileInfo.size < 1 || fileInfo.size > 128 * 1024 * 1024) throw new Error("Исходное аудио должно быть файлом до 128 МБ");
    const bytes = await readFile(source);
    const body = new FormData();
    // ComfyUI's /upload/image handler stores any uploaded file in input; LoadAudio reads it by name.
    body.append("image", new Blob([new Uint8Array(bytes)]), `pi-cover-${randomUUID()}${path.extname(source).toLowerCase()}`);
    const uploaded = await (await request(settings.url, "/upload/image", { method: "POST", body }, signal)).json() as { name: string; subfolder?: string };
    uploadedAudio = uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
  }
  const custom = settings.workflows[mode];
  if (custom && input.plan_only) throw new Error("Отдельное планирование ABC поддерживается встроенным YuE2 workflow");
  if (custom && input.vocal_mode) throw new Error("Проверка инструментального ABC поддерживается встроенным YuE2 workflow");
  const graph = custom
    ? fillWorkflow(validateGraph(JSON.parse(await readFile(path.resolve(dataDir, custom), "utf8"))), { ...musicInput, audio: uploadedAudio, abc_text: abcText }, images, music ? settings.musicSteps : settings.steps, maskName)
    : builtinGraph(settings, mode, { ...musicInput, audio: uploadedAudio, abc_text: abcText }, images, sizes, maskName);
  const nodes = await (await request(settings.url, "/object_info", {}, signal)).json() as Record<string, { api_node?: boolean }>;
  for (const node of Object.values(graph)) {
    if (!(node.class_type in nodes)) throw new Error(`В ComfyUI отсутствует узел ${node.class_type}. Обновите ComfyUI или выберите другой workflow.`);
    if (nodes[node.class_type].api_node) throw new Error(`Облачный узел ${node.class_type} не разрешён в локальной интеграции`);
  }
  const queued = await (await request(settings.url, "/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: graph, client_id: randomUUID() }) }, signal)).json() as { prompt_id?: string; error?: unknown; node_errors?: unknown };
  if (!queued.prompt_id) throw new Error(`Workflow отклонён: ${JSON.stringify(queued).slice(0, 3000)}`);
  const id = queued.prompt_id;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("ComfyUI вернул некорректный идентификатор задания");
  const started = Date.now();
  let history: { status?: { status_str?: string; messages?: unknown[] }; outputs?: Record<string, { images?: Output[]; audio?: Output[]; "3d"?: Output[]; text?: string[] }> } | undefined;
  try {
    while (Date.now() - started < (music || model3d ? 60 : 20) * 60_000) {
      const all = await (await request(settings.url, `/history/${encodeURIComponent(id)}`, {}, signal)).json() as Record<string, typeof history>;
      history = all[id];
      if (history) break;
      progress?.(`ComfyUI: ожидание результата, ${Math.floor((Date.now() - started) / 1000)} с. Задание ${id}`);
      await delay(2000, undefined, { signal });
    }
    if (!history) throw new Error(`Время ожидания истекло. Задание ComfyUI: ${id}`);
    if (history.status?.status_str === "error") throw new Error(`Ошибка ComfyUI: ${JSON.stringify(history.status.messages).slice(0, 3000)}`);
    if (model3d && !custom && graph.pi_model_process) {
      const prefix = String(graph.pi_model_process.inputs.output_prefix);
      const artifacts = await saveModelArtifacts(dataDir, id, prefix, history.outputs ?? {}, ["pi_model_process"],
        async (filename, subfolder, limit) => limitedBody(await request(settings.url, `/view?${new URLSearchParams({ filename, subfolder, type: "output" })}`, {}, signal), limit));
      const models = artifacts.files.filter(file => file.mimeType === "model/gltf-binary").map(({ path, mimeType }) => ({ path, mimeType }));
      if (!models.length) throw new Error("Обработка 3D не вернула GLB-модель");
      return { promptId: id, images: [], audio: [], models, abcFile: undefined, recordFile: artifacts.recordFile,
        reports: { model_processing: JSON.stringify(artifacts.artifactReports) }, generationLimitReached: null,
        inputDimensions: sizes, totalImages: 0, totalAudio: 0, totalModels: models.length };
    }
    const reports: Record<string, string> = {};
    if (vocalReport) reports.vocal_edit = JSON.stringify(vocalReport);
    for (const name of ["analysis", "fit", "lyrics", "modifier", "range", "cleanup", "duration"]) {
      const value = history.outputs?.[`pi_${name}`]?.text?.[0];
      if (typeof value === "string" && value.trim()) reports[name] = value.slice(0, 12_000);
    }
    const generationInfo = history.outputs?.pi_generation_info?.text?.[0];
    const generatedSeconds = history.outputs?.pi_generated_seconds?.text?.[0];
    const limitText = history.outputs?.pi_generation_limit?.text?.[0];
    const effectiveStyle = history.outputs?.pi_style?.text?.[0];
    const effectiveLyrics = history.outputs?.pi_effective_lyrics?.text?.[0];
    const generationLimit = typeof limitText === "string" && /^(true|false)$/i.test(limitText.trim())
      ? limitText.trim().toLowerCase() === "true" : null;
    if (music && !input.plan_only) {
      reports.generation_limit = generationLimit === null ? "unknown (ComfyUI did not return the limit flag)" : generationLimit ? "REACHED: ending may be truncated" : "not reached";
      if (typeof generationInfo === "string" && generationInfo.trim()) reports.generation_info = generationInfo.slice(0, 12_000);
      if (typeof generatedSeconds === "string" && generatedSeconds.trim()) reports.generated_seconds = generatedSeconds.trim();
    }
    const generatedAbc = history.outputs?.pi_abc?.text?.[0];
    if (input.plan_only && (!generatedAbc || typeof generatedAbc !== "string")) throw new Error("YuE2 не вернул нотный план ABC");
    if (typeof generatedAbc === "string" && generatedAbc.length > 1024 * 1024) throw new Error("Нотный план ABC превышает 1 МБ");
    if (input.vocal_mode) {
      if (typeof generatedAbc !== "string" || !generatedAbc.trim()) throw new Error("YuE2 не вернул финальный ABC для проверки отсутствия вокала");
      const finalCheck = editYuE2VocalScore(generatedAbc, input.vocal_mode);
      if (finalCheck.report.vocalNotesBefore) throw new Error("Финальный ABC снова содержит вокальные ноты; инструментальный трек не принят");
      reports.final_vocal_check = JSON.stringify(finalCheck.report);
    }
    let abcFile: string | undefined;
    if (typeof generatedAbc === "string" && generatedAbc.trim()) {
      const folder = path.join(dataDir, "music-generation");
      await mkdir(folder, { recursive: true });
      abcFile = path.join(folder, `${id}.abc`);
      await writeFile(abcFile, generatedAbc, { encoding: "utf8", flag: "wx" });
    }
    const outputs = Object.entries(history.outputs ?? {}).flatMap(([nodeId, v]) => ((model3d ? v["3d"] : music ? v.audio : v.images) ?? []).map(output => ({ ...output, nodeId }))).filter((v) => v.type === "output");
    if (!outputs.length && !input.plan_only) throw new Error(`Workflow завершён без сохранённых ${model3d ? "3D-моделей" : music ? "треков" : "изображений"}. Задание: ${id}`);
    const result = [];
    const audio: { path: string; mimeType: string }[] = [];
    const models: { path: string; mimeType: string }[] = [];
    const folder = path.join(dataDir, model3d ? "3d-generation" : music ? "music-generation" : "image-generation");
    await mkdir(folder, { recursive: true });
    for (let i = 0; i < Math.min(outputs.length, 4); i++) {
      const output = outputs[i];
      const params = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder ?? "", type: "output" });
      const response = await request(settings.url, `/view?${params}`, {}, signal);
      const audioTypes: Record<string, string> = { ".flac": "audio/flac", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".opus": "audio/ogg", ".ogg": "audio/ogg" };
      const mimeType = model3d ? (/\.glb$/i.test(output.filename) ? "model/gltf-binary" : undefined) : music ? audioTypes[path.extname(output.filename).toLowerCase()] : response.headers.get("content-type")?.split(";")[0] ?? "image/png";
      if (!mimeType || (!music && !model3d && !["image/png", "image/jpeg", "image/webp"].includes(mimeType))) throw new Error("ComfyUI вернул неподдерживаемый формат результата (для 3D нужен GLB)");
      const limit = (model3d ? 256 : music ? 128 : 32) * 1024 * 1024;
      const bytes = await limitedBody(response, limit);
      if (model3d) validateLocalGlb(bytes);
      const file = path.join(folder, `${id}-${i + 1}-${path.basename(output.filename)}`);
      await writeFile(file, bytes);
      if (model3d) models.push({ path: file, mimeType });
      else if (music) audio.push({ path: file, mimeType });
      else result.push({ path: file, data: bytes.toString("base64"), mimeType, nodeId: output.nodeId });
    }
    let recordFile: string | undefined;
    if (music && !input.plan_only) {
      const effective = (type: string) => Object.values(graph).find(node => node.class_type === type)?.inputs;
      const scoreHash = (value: string | undefined) => value ? createHash("sha256").update(value, "utf8").digest("hex") : undefined;
      recordFile = path.join(folder, `${id}-generation.json`);
      await writeFile(recordFile, `${JSON.stringify({
        schema: 1, job: id, createdAt: new Date().toISOString(), mode, status: generationLimit === true ? "needs_review" : generationLimit === false ? "complete" : "unknown",
        generationLimitReached: generationLimit, generatedSeconds: typeof generatedSeconds === "string" ? generatedSeconds.trim() : null,
        request: { prompt: input.prompt, lyrics: musicInput.lyrics, durationCeilingSeconds: input.duration ?? null,
          seed: effective("PrimitiveInt")?.value, steps: effective("KSampler")?.steps,
          keepHarmony: input.keep_harmony ?? null, vocalMode: input.vocal_mode ?? null, musicOptions: input.music_options ?? {} },
        effective: { checkpoint: effective("YuE2NativePipelineLoader")?.checkpoint ?? null,
          styleText: typeof effectiveStyle === "string" ? effectiveStyle : null,
          lyricsText: typeof effectiveLyrics === "string" ? effectiveLyrics : null,
          style: effective("YuE2StyleBuilder"), lyrics: effective("YuE2LyricsStructurer"),
          generation: effective("YuE2NativeGenerateMusic"), submittedAbcSha256: scoreHash(abcText), finalAbcSha256: scoreHash(generatedAbc) },
        files: { sourceAbc: input.abc_file ?? null, finalAbc: abcFile ?? null, audio: audio.map(item => item.path) }, reports,
        verification: { symbolicVocalCheck: input.vocal_mode ? "passed" : "not_requested", audioListening: "not_performed" },
      }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    }
    return { promptId: id, images: result, audio, models, abcFile, recordFile, reports, generationLimitReached: generationLimit, inputDimensions: sizes, totalImages: music || model3d ? 0 : outputs.length, totalAudio: music ? outputs.length : 0, totalModels: model3d ? outputs.length : 0 };
  } catch (error) {
    // Remove only our queued job. ComfyUI's global interrupt would stop the user's work too.
    if (signal?.aborted) await request(settings.url, "/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [id] }) }, AbortSignal.timeout(3000)).catch(() => undefined);
    throw error;
  }
}
