import { randomUUID } from "node:crypto";
type Link = [string, number];
type Graph = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
export interface TextureOptions {
  seed?: number; steps?: number; cfg?: number; texture_resolution?: number;
  albedo_resolution?: number; mr_resolution?: number; render_size?: number;
  uv_mode?: "comfy_gpu" | "xatlas" | "keep_existing";
  reference_alignment?: "fit_front_silhouette" | "center";
  memory_factor?: number; attention?: "ultratex_sparse" | "comfy_default";
  sparse_topk?: number; token_chunk?: number; drop_background_tokens?: boolean;
  view_weight_power?: number; best_view_mix?: number; edge_feather_px?: number;
}

// Installed UltraTex FLUX.2 Klein PBR workflow; no generated cards or inferred bindings.
export function textureGraph(source: string | Link | { meshPath: Link }, image: string, options: TextureOptions = {}): Graph {
  const seed = options.seed ?? Math.floor(Math.random() * 2 ** 48);
  const sampler = (model: string, resolution: number) => ({ class_type: "UltraTexSampler", inputs: {
    model: [model, 0], vae: ["pi_tex_decoder", 0], positive: ["pi_tex_prompt", 0], prep: ["pi_tex_prep", 0],
    resolution, steps: options.steps ?? 25, seed, guidance: options.cfg ?? 4,
    drop_background_tokens: options.drop_background_tokens ?? true, memory_factor: options.memory_factor ?? 0,
    attention: options.attention ?? "ultratex_sparse", sparse_topk: options.sparse_topk ?? 0.2, token_chunk: options.token_chunk ?? 8192,
  } });
  return {
    pi_tex_image: { class_type: "LoadImage", inputs: { image } },
    pi_tex_background: { class_type: "LoadBackgroundRemovalModel", inputs: { bg_removal_name: "birefnet.safetensors" } },
    pi_tex_mask: { class_type: "RemoveBackground", inputs: { image: ["pi_tex_image", 0], bg_removal_model: ["pi_tex_background", 0] } },
    pi_tex_prep: { class_type: "UltraTexPrep", inputs: {
      reference_image: ["pi_tex_image", 0], reference_mask: ["pi_tex_mask", 0], mask_meaning: "foreground",
      mesh_path: typeof source === "string" ? source : Array.isArray(source) ? "" : source.meshPath,
      ...(Array.isArray(source) ? { trimesh: source } : {}),
      render_size: options.render_size ?? 4096, atlas_size: options.texture_resolution ?? 4096,
      uv_mode: options.uv_mode ?? "keep_existing", reference_alignment: options.reference_alignment ?? "fit_front_silhouette",
    } },
    pi_tex_model: { class_type: "UNETLoader", inputs: { unet_name: "flux-2-klein-base-9b-fp8.safetensors", weight_dtype: "default" } },
    pi_tex_vae: { class_type: "VAELoader", inputs: { vae_name: "flux2-vae.safetensors" } },
    pi_tex_decoder: { class_type: "UltraTexForegroundDecoder", inputs: { vae: ["pi_tex_vae", 0], decoder_name: "ultratex_flux2_decoder.pt" } },
    pi_tex_clip: { class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_8b_fp8mixed.safetensors", type: "flux2", device: "default" } },
    pi_tex_prompt: { class_type: "CLIPTextEncode", inputs: { clip: ["pi_tex_clip", 0], text: "" } },
    pi_tex_albedo_lora: { class_type: "UltraTexLoraLoader", inputs: { model: ["pi_tex_model", 0], lora_name: "ultratex_flux2.safetensors", strength: 1 } },
    pi_tex_albedo: sampler("pi_tex_albedo_lora", options.albedo_resolution ?? 2048),
    pi_tex_mr_lora: { class_type: "UltraTexLoraLoader", inputs: { model: ["pi_tex_model", 0], lora_name: "ultratex_flux2_mr.safetensors", strength: 1 } },
    pi_tex_mr: sampler("pi_tex_mr_lora", options.mr_resolution ?? 1024),
    pi_tex_bake: { class_type: "UltraTexBake", inputs: {
      prep: ["pi_tex_prep", 0], albedo_views: ["pi_tex_albedo", 0], metallic_roughness_views: ["pi_tex_mr", 0],
      texture_size: options.texture_resolution ?? 4096, filename_prefix: `3d/pi-desktop/${randomUUID()}/textured`,
      view_weight_power: options.view_weight_power ?? 4, best_view_mix: options.best_view_mix ?? 0.5, edge_feather_px: options.edge_feather_px ?? 6,
    } },
  };
}
