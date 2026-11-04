import { randomUUID } from "node:crypto";
import type { ComfyInput } from "./comfy-client.js";
type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

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
