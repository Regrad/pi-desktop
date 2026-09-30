import type { ComfyInput } from "../../lib/comfy-client.js";
import type { ComfySettings } from "../../shared/comfy.js";
import type { ImageGraph, ImageDimensions } from "../comfyui_generate_image/workflow.js";

export function validateSegmentation(input: ComfyInput, size?: ImageDimensions) {
  if (input.images?.length !== 1) throw new Error("Для маски нужно ровно одно изображение");
  if (!input.targets?.length && !input.positive_points?.length && !input.boxes?.length) throw new Error("Укажите объекты, положительные точки или рамки для выделения");
  if (input.targets && (input.targets.length > 8 || input.targets.some(t => typeof t !== "string" || !t.trim() || t.length > 160 || /[,:\n\r]/.test(t)))) throw new Error("Объекты: до 8 коротких названий без запятых, двоеточий и переводов строки");
  if (input.threshold !== undefined && (!Number.isFinite(input.threshold) || input.threshold < 0 || input.threshold > 1)) throw new Error("Порог выделения: 0–1");
  if (input.max_objects !== undefined && (!Number.isInteger(input.max_objects) || input.max_objects < 1 || input.max_objects > 100)) throw new Error("Количество объектов на название: 1–100");
  if (input.refine_iterations !== undefined && (!Number.isInteger(input.refine_iterations) || input.refine_iterations < 0 || input.refine_iterations > 5)) throw new Error("Уточнение маски: 0–5 проходов");
  for (const points of [input.positive_points, input.negative_points]) {
    if (points && (points.length > 64 || points.some(p => !Number.isInteger(p.x) || !Number.isInteger(p.y) || p.x < 0 || p.y < 0 || (size && (p.x >= size.width || p.y >= size.height))))) throw new Error("Точки должны лежать внутри изображения, не более 64 каждого типа");
  }
  if (input.boxes && (input.boxes.length > 16 || input.boxes.some(b => ![b.x, b.y, b.width, b.height].every(Number.isInteger) || b.x < 0 || b.y < 0 || b.width < 1 || b.height < 1 || (size && (b.x + b.width > size.width || b.y + b.height > size.height))))) throw new Error("Рамки должны лежать внутри изображения, не более 16");
  if ([input.width, input.height, input.seed, input.count, input.denoise, input.mask].some(v => v !== undefined)) throw new Error("Сегментация сохраняет размер оригинала и не использует генеративные параметры");
}

export function segmentationGraph(settings: ComfySettings, input: ComfyInput, image: string): ImageGraph {
  const graph: ImageGraph = {
    source: { class_type: "LoadImage", inputs: { image } },
    checkpoint: { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: settings.segmentationCheckpoint } },
    detect: { class_type: "SAM3_Detect", inputs: { model: ["checkpoint", 0], image: ["source", 0], threshold: input.threshold ?? 0.5, refine_iterations: input.refine_iterations ?? 2, individual_masks: false } },
    mask_rgb: { class_type: "MaskToImage", inputs: { mask: ["detect", 0] } },
    save_mask: { class_type: "SaveImage", inputs: { images: ["mask_rgb", 0], filename_prefix: "PiDesktop-mask" } },
    // RGB preview remains unambiguous even when a vision provider discards PNG alpha.
    preview: { class_type: "ImageCompositeMasked", inputs: { destination: ["mask_rgb", 0], source: ["source", 0], mask: ["detect", 0], x: 0, y: 0, resize_source: false } },
    save_preview: { class_type: "SaveImage", inputs: { images: ["preview", 0], filename_prefix: "PiDesktop-selection" } },
  };
  if (input.targets?.length) {
    // Native SAM3 tokenizer uses :N to cap detections separately for each concept.
    graph.text = { class_type: "CLIPTextEncode", inputs: { clip: ["checkpoint", 1], text: input.targets.map(t => `${t.trim()}:${input.max_objects ?? 1}`).join(", ") } };
    graph.detect.inputs.conditioning = ["text", 0];
  }
  if (input.positive_points?.length) graph.detect.inputs.positive_coords = JSON.stringify(input.positive_points);
  if (input.negative_points?.length) graph.detect.inputs.negative_coords = JSON.stringify(input.negative_points);
  if (input.boxes?.length) {
    // ComfyUI's API interprets any literal array as a node link. SAM accepts a
    // single box dictionary, so run each box separately and union the masks.
    const onlyBoxes = !input.targets?.length && !input.positive_points?.length && !input.negative_points?.length;
    let selected: (string | number)[] = ["detect", 0];
    if (onlyBoxes) graph.detect.inputs.bboxes = input.boxes[0];
    for (let i = onlyBoxes ? 1 : 0; i < input.boxes.length; i++) {
      const detector = `box_${i}`;
      const combined = `box_union_${i}`;
      graph[detector] = { class_type: "SAM3_Detect", inputs: {
        model: ["checkpoint", 0], image: ["source", 0],
        threshold: input.threshold ?? 0.5, refine_iterations: input.refine_iterations ?? 2,
        individual_masks: false, bboxes: input.boxes[i],
      } };
      graph[combined] = { class_type: "MaskComposite", inputs: { destination: selected, source: [detector, 0], x: 0, y: 0, operation: "or" } };
      selected = [combined, 0];
    }
    graph.mask_rgb.inputs.mask = selected;
    graph.preview.inputs.mask = selected;
  }
  return graph;
}
