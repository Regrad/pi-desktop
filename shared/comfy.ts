export type ComfyMode = "generate" | "edit" | "compose" | "inpaint" | "outpaint" | "extract" | "segment" | "remove_background" | "music" | "music_cover" | "model3d" | "model3d_multiview";

export interface ComfySettings {
  enabled: boolean;
  url: string;
  workflowFolders?: string[];
  diffusionModel: string;
  textEncoder: string;
  vae: string;
  backgroundModel: string;
  segmentationCheckpoint: string;
  steps: number;
  musicCheckpoint: string;
  musicSteps: number;
  workflows: Record<ComfyMode, string>;
}

export interface ComfyWorkflowSummary {
  items: { id: string; name: string; source: "server" | "local"; location: string }[];
  total: number;
  nextOffset: number | null;
  warnings: string[];
}
export interface ComfyWorkflowInspection {
  workflow: ComfyWorkflowSummary["items"][number]; revision: string; format: string;
  nodes: { id: string; type: string; title?: string; description?: string; output: boolean }[];
  parameters: { items: { node: string; input: string; type: unknown; current?: unknown; constraints: Record<string, unknown>; choices?: unknown[]; choicesTotal?: number }[]; total: number; nextOffset: number | null };
  problems: string[];
}

export const DEFAULT_COMFY_SETTINGS: ComfySettings = {
  enabled: false,
  url: "http://127.0.0.1:8188",
  diffusionModel: "qwen_image_2.1_int8_convrot.safetensors",
  textEncoder: "qwen3vl_8b_int8_convrot.safetensors",
  vae: "qwen_image_2.1_vae_bf16.safetensors",
  backgroundModel: "birefnet.safetensors",
  segmentationCheckpoint: "sam3.1_multiplex_fp16.safetensors",
  steps: 25,
  musicCheckpoint: "yue2_3b_bf16.safetensors",
  musicSteps: 32,
  workflows: { generate: "", edit: "", compose: "", inpaint: "", outpaint: "", extract: "", segment: "", remove_background: "", music: "", music_cover: "", model3d: "", model3d_multiview: "" },
};

export function localComfyUrl(value: string): string {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const parts = host.split(".").map(Number);
  const ipv4 = parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255);
  const local = host === "localhost" || host === "[::1]" || (ipv4 && (
    parts[0] === 127 || parts[0] === 10 || (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
  ));
  if (!local || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("Укажите localhost или частный IP-адрес сервера ComfyUI в вашей сети.");
  return url.toString().replace(/\/+$/, "");
}
