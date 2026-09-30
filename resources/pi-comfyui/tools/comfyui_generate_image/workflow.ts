import type { ComfySettings, ComfyMode } from "../../shared/comfy.js";
import type { ComfyInput } from "../../lib/comfy-client.js";
export type ImageGraph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
export type ImageDimensions = { width: number; height: number };

export function imageGraph(settings: ComfySettings, mode: ComfyMode, input: ComfyInput, images: string[], sizes: ImageDimensions[] = [], maskName?: string): ImageGraph {
  const graph: ImageGraph = {};
  const add = (id: string, class_type: string, inputs: Record<string, unknown>) => { graph[id] = { class_type, inputs }; return [id, 0]; };
  const refs = images.map((image, i) => {
    add(`image_${i}`, "LoadImage", { image });
    return add(`rgba_${i}`, "JoinImageWithAlpha", { image: [`image_${i}`, 0], alpha: [`image_${i}`, 1] });
  });
  if (mode === "remove_background") {
    add("bg", "LoadBackgroundRemovalModel", { bg_removal_name: settings.backgroundModel });
    add("mask", "RemoveBackground", { bg_removal_model: ["bg", 0], image: ["image_0", 0] });
    add("invert", "InvertMask", { mask: ["mask", 0] });
    add("rgba", "JoinImageWithAlpha", { image: ["image_0", 0], alpha: ["invert", 0] });
    add("save", "SaveImage", { images: ["rgba", 0], filename_prefix: "PiDesktop" });
    return graph;
  }
  const localEdit = mode === "inpaint" || mode === "outpaint";
  const canvas = (input.canvas_image ?? 1) - 1;
  const original = sizes[localEdit ? 0 : canvas] ?? { width: 1024, height: 1024 };
  const padding = input.padding ?? { left: 0, top: 0, right: 0, bottom: 0 };
  const exact = mode === "outpaint" ? { width: original.width + padding.left + padding.right, height: original.height + padding.top + padding.bottom } : original;
  const width = input.width ?? (images.length ? Math.max(32, Math.round(exact.width / 32) * 32) : 1024);
  const height = input.height ?? (images.length ? Math.max(32, Math.round(exact.height / 32) * 32) : 1024);
  if (width > 4096 || height > 4096) throw new Error("Рабочий холст Qwen не должен превышать 4096 по стороне");
  let target = refs[0];
  let mask: (string | number)[] | undefined;
  if (mode === "outpaint") {
    target = add("pad", "ImagePadForOutpaint", { image: refs[0], ...padding, feathering: input.feathering ?? 0 });
    mask = ["pad", 1];
  } else if (mode === "inpaint") {
    if (!maskName) throw new Error("Для локального редактирования нужна маска");
    add("mask_image", "LoadImage", { image: maskName });
    const channel = input.mask_channel ?? "red";
    mask = channel === "alpha" ? add("mask_alpha", "InvertMask", { mask: ["mask_image", 1] })
      : add("mask_channel", "ImageToMask", { image: ["mask_image", 0], channel });
    if (input.invert_mask) mask = add("mask_invert", "InvertMask", { mask });
    const sizedMask = add("mask_canvas_size", "ImageScale", { image: add("mask_to_rgb", "MaskToImage", { mask }), upscale_method: "bilinear", width: original.width, height: original.height, crop: "disabled" });
    mask = add("mask_canvas_channel", "ImageToMask", { image: sizedMask, channel: "red" });
    if (input.mask_grow) mask = add("mask_grow", "GrowMask", { mask, expand: input.mask_grow, tapered_corners: true });
    if (input.mask_blur) {
      const image = add("mask_rgb", "MaskToImage", { mask });
      const blurred = add("mask_blur", "ImageBlur", { image, blur_radius: input.mask_blur, sigma: Math.min(input.mask_blur, 10) });
      mask = add("mask_soft", "ImageToMask", { image: blurred, channel: "red" });
    }
  }
  if (target && (localEdit || mode === "edit") && (width !== original.width || height !== original.height || mode === "outpaint")) {
    refs[0] = add("canvas_scaled", "ImageScale", { image: target, upscale_method: "lanczos", width, height, crop: "disabled" });
  } else if (target) refs[0] = target;
  if (mask) {
    const rgb = add("mask_reference", "MaskToImage", { mask });
    refs.push(add("mask_reference_scaled", "ImageScale", { image: rgb, upscale_method: "bilinear", width, height, crop: "disabled" }));
  }
  add("model", "UNETLoader", { unet_name: settings.diffusionModel, weight_dtype: "default" });
  add("clip", "CLIPLoader", { clip_name: settings.textEncoder, type: "qwen_image", device: "default" });
  add("vae", "VAELoader", { vae_name: settings.vae });
  let prompt = input.prompt;
  if (mode === "extract") prompt = `Extract the requested subject from the image as a transparent RGBA cutout. Preserve the subject's identity and fine details. ${prompt ?? ""}`;
  if (input.transparent_background || mode === "extract") prompt = `This is an RGBA image with transparency. ${prompt}. The image has an alpha channel and a transparent background.`;
  if (mask) prompt = `${prompt}. <image1> is the canvas to edit; <image${refs.length}> is the selection mask. Edit the white regions of the mask, preserving the black regions of the canvas.`;
  const conditioning: Record<string, unknown> = { clip: ["clip", 0], prompt, negative_prompt: input.negative_prompt ?? "", resolution: localEdit ? 0 : input.reference_resolution ?? (mode === "edit" ? 0 : 1024) };
  if (refs.length) {
    conditioning.vae = ["vae", 0];
    refs.forEach((ref, i) => { conditioning[`images.image_${i + 1}`] = ref; });
    add("cache", "QwenImage21Cache", { model: ["model", 0], device: "auto", dtype: "default" });
  }
  add("text", "TextEncodeQwenImage21", conditioning);
  let latent: (string | number)[] = add("latent", "EmptyLatentImage", { width, height, batch_size: input.count ?? 1 });
  if (mode === "edit" && !input.width && !input.height && !(input.reference_resolution ?? 0) && (input.count ?? 1) === 1) latent = ["text", 2];
  if (mask || (refs.length && (input.denoise ?? 1) < 1)) {
    latent = add("encoded_canvas", "VAEEncode", { pixels: refs[0], vae: ["vae", 0] });
    if (mask) {
      const sampleMask = add("sampling_mask", "ImageToMask", { image: refs[refs.length - 1], channel: "red" });
      latent = add("masked_latent", "SetLatentNoiseMask", { samples: latent, mask: sampleMask });
    }
    if ((input.count ?? 1) > 1) latent = add("repeat_canvas", "RepeatLatentBatch", { samples: latent, amount: input.count });
  }
  add("sample", "KSampler", { model: [refs.length ? "cache" : "model", 0], positive: ["text", 0], negative: ["text", 1], latent_image: latent,
    seed: input.seed ?? Math.floor(Math.random() * 2 ** 48), steps: input.steps ?? settings.steps, cfg: input.cfg ?? 1,
    sampler_name: "euler", scheduler: "simple", denoise: input.denoise ?? 1 });
  let output = add("decode", "VAEDecode", { samples: ["sample", 0], vae: ["vae", 0] });
  if (mask) {
    output = add("restore_size", "ImageScale", { image: output, upscale_method: "lanczos", width: exact.width, height: exact.height, crop: "disabled" });
    output = add("preserve_unmasked", "ImageCompositeMasked", { destination: target, source: output, x: 0, y: 0, resize_source: false, mask });
  }
  add("save", "SaveImage", { images: output, filename_prefix: "PiDesktop" });
  return graph;
}
