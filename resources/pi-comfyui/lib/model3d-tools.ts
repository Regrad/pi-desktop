import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { runApiWorkflow } from "./workflow.js";
import { readImageInput } from "./image-input.js";
import { loadComfySettings, request } from "./comfy-client.js";
import { validateLocalGlb } from "../shared/glb.js";
import type { HistoryImage } from "../shared/image-attachments.js";

export async function modelSource(file: string) {
  if (!path.isAbsolute(file) || !/\.(glb|obj|fbx|stl|ply)$/i.test(file)) throw new Error("Нужен абсолютный путь к GLB, OBJ, FBX, STL или PLY, доступный ComfyUI");
  const info = await stat(file);
  if (!info.isFile() || info.size < 1 || info.size > 256 * 1024 * 1024) throw new Error("Исходная модель должна быть файлом до 256 МБ");
  if (/\.glb$/i.test(file)) validateLocalGlb(await readFile(file));
  return file;
}

export async function uploadModelImage(dataDir: string, reference: string, signal?: AbortSignal, resolveAttachment?: (reference: string) => HistoryImage) {
  const settings = await loadComfySettings(dataDir);
  if (!settings.enabled) throw new Error("ComfyUI отключён в настройках Pi Desktop");
  const image = await readImageInput(reference, resolveAttachment);
  const body = new FormData();
  body.append("image", new Blob([new Uint8Array(image.bytes)]), `pi-3d-${randomUUID()}${image.extension}`);
  const uploaded = await (await request(settings.url, "/upload/image", { method: "POST", body }, signal)).json() as { name: string; subfolder?: string };
  if (!uploaded.name || /[\\/\0]/.test(uploaded.name) || (uploaded.subfolder ?? "").split("/").some(part => part === "..")) throw new Error("Некорректный путь загруженного изображения");
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
}

export function modelJobPrefix() { return `3d/pi-desktop/${randomUUID()}`; }

export async function runModelTool(dataDir: string, graph: unknown, prefix: string, reportNodes: string[], signal?: AbortSignal, progress?: (text: string) => void, showViews = false) {
  const result = await runApiWorkflow(dataDir, graph, { kind: "model", modelArtifacts: { prefix, reportNodes } }, signal, progress);
  const renders = new Set(Object.values(result.artifactReports ?? {}).flatMap(report => report && typeof report === "object" && "renders" in report && Array.isArray(report.renders) ? report.renders : []));
  const renderFiles = showViews ? result.files.filter(file => renders.has(file.path)) : [];
  const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [{ type: "text", text: `3D operation completed. Saved files:\n${result.files.map(file => file.path).join("\n")}\nReport: ${result.recordFile}\nReports:\n${JSON.stringify(result.artifactReports).slice(0, 20000)}\nJob: ${result.promptId}. Only returned render image blocks are visual input; GLB geometry is not.` }];
  if (showViews) {
    for (const file of renderFiles) content.push({ type: "image", data: (await readFile(file.path)).toString("base64"), mimeType: "image/png" });
  }
  return { content, details: { promptId: result.promptId, files: [...renderFiles, ...result.files.filter(file => !renderFiles.includes(file))].map(file => file.path).concat(result.recordFile ? [result.recordFile] : []), media: result.files.filter(file => file.mimeType === "model/gltf-binary").map(file => ({ type: "model3d", path: file.path, mimeType: file.mimeType })), reports: result.artifactReports } };
}
