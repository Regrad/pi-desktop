import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chatFileDirectory } from "./chat-storage.js";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { loadComfySettings, request, limitedBody, validateGraph } from "./comfy-client.js";
import { validateLocalGlb } from "../shared/glb.js";
import { saveModelArtifacts } from "./model3d-artifacts.js";

// Accepts a finished API graph: new models/tools need no changes to ComfyMode or app code.
export async function runApiWorkflow(dataDir: string, graph: unknown, options: {
  kind: "image" | "audio" | "model";
  outputNodes?: string[];
  timeoutMinutes?: number;
  modelArtifacts?: { prefix: string; reportNodes: string[] };
}, signal?: AbortSignal, progress?: (text: string) => void) {
  const settings = await loadComfySettings(dataDir);
  if (!settings.enabled) throw new Error("ComfyUI отключён в настройках Pi Desktop");
  const prompt = validateGraph(graph);
  const minutes = options.timeoutMinutes ?? 60;
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 240) throw new Error("Timeout: 0–240 minutes");
  if (!["image", "audio", "model"].includes(options.kind)) throw new Error("Unsupported output kind");
  const nodes = await (await request(settings.url, "/object_info", {}, signal)).json() as Record<string, { api_node?: boolean }>;
  for (const node of Object.values(prompt)) {
    if (!nodes[node.class_type]) throw new Error(`В ComfyUI отсутствует узел ${node.class_type}`);
    if (nodes[node.class_type].api_node) throw new Error(`Облачный узел ${node.class_type} не разрешён`);
  }
  const queued = await (await request(settings.url, "/prompt", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, client_id: randomUUID() }),
  }, signal)).json() as { prompt_id?: string };
  const id = queued.prompt_id;
  if (!id || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error(`Workflow отклонён: ${JSON.stringify(queued).slice(0, 3000)}`);
  type Output = { filename: string; subfolder?: string; type?: string };
  type History = { status?: { status_str?: string; messages?: unknown[] }; outputs?: Record<string, { images?: Output[]; audio?: Output[]; "3d"?: Output[]; text?: string[] }> };
  try {
    const started = Date.now();
    let history: History | undefined;
    while (Date.now() - started < minutes * 60_000) {
      const all = await (await request(settings.url, `/history/${id}`, {}, signal)).json() as Record<string, History>;
      history = all[id];
      if (history) break;
      progress?.(`ComfyUI: ожидание результата. Задание ${id}`);
      await delay(2000, undefined, { signal });
    }
    if (!history) throw new Error(`Время ожидания истекло. Задание: ${id}`);
    if (history.status?.status_str === "error") throw new Error(`Ошибка ComfyUI: ${JSON.stringify(history.status.messages).slice(0, 3000)}`);
    if (options.modelArtifacts) {
      if (options.kind !== "model") throw new Error("Отчёты 3D доступны только для моделей");
      const artifacts = await saveModelArtifacts(dataDir, id, options.modelArtifacts.prefix, history.outputs ?? {}, options.modelArtifacts.reportNodes,
        async (filename, subfolder, limit) => limitedBody(await request(settings.url, `/view?${new URLSearchParams({ filename, subfolder, type: "output" })}`, {}, signal), limit));
      return { promptId: id, reports: history.outputs, ...artifacts };
    }
    const field = options.kind === "image" ? "images" : options.kind === "audio" ? "audio" : "3d";
    const outputs = Object.entries(history.outputs ?? {}).filter(([node]) => !options.outputNodes || options.outputNodes.includes(node))
      .flatMap(([nodeId, value]) => (value[field] ?? []).map(output => ({ ...output, nodeId }))).filter(output => output.type === "output");
    if (!outputs.length) throw new Error(`Workflow завершён без сохранённого результата. Задание: ${id}`);
    const folder = chatFileDirectory(dataDir, options.kind === "image" ? "image-generation" : options.kind === "audio" ? "music-generation" : "3d-generation");
    await mkdir(folder, { recursive: true });
    const files: { path: string; mimeType: string; nodeId: string; data?: string }[] = [];
    const mime: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".flac": "audio/flac", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".glb": "model/gltf-binary" };
    for (const [index, output] of outputs.slice(0, 4).entries()) {
      const mimeType = mime[path.extname(output.filename).toLowerCase()];
      if (!mimeType || !mimeType.startsWith(`${options.kind === "model" ? "model" : options.kind}/`)) throw new Error("Неподдерживаемый формат результата");
      const query = new URLSearchParams({ filename: output.filename, subfolder: output.subfolder ?? "", type: "output" });
      const bytes = await limitedBody(await request(settings.url, `/view?${query}`, {}, signal), (options.kind === "model" ? 256 : options.kind === "audio" ? 128 : 32) * 1024 * 1024);
      if (options.kind === "model") validateLocalGlb(bytes);
      const file = path.join(folder, `${id}-${index + 1}-${path.basename(output.filename)}`);
      await writeFile(file, bytes);
      files.push({ path: file, mimeType, nodeId: output.nodeId, ...(options.kind === "image" ? { data: bytes.toString("base64") } : {}) });
    }
    return { promptId: id, files, totalFiles: outputs.length, reports: history.outputs, recordFile: undefined, artifactReports: undefined };
  } catch (error) {
    if (signal?.aborted) await request(settings.url, "/queue", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [id] }),
    }, AbortSignal.timeout(3000)).catch(() => undefined);
    throw error;
  }
}
