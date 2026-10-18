import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { limitedBody } from "./comfy-client.js";
import { validateLocalGlb } from "../shared/glb.js";
import { applyWorkflowPatches, comfyConnection, comfyFetch, comfyJson, ComfyHttpError, digest, graphNodeInfo, graphProblems, linked, workflowGraph, workflowRevision, type WorkflowCompiler, type WorkflowPatch } from "./workflow-catalog.js";

type Status = "preparing" | "submitting" | "unknown" | "queued" | "running" | "completed" | "failed" | "cancelled";
export interface WorkflowJob {
  id: string; requestKey: string; fingerprint: string; url: string; workflowId: string; revision: string;
  createdAt: string; updatedAt: string; status: Status; promptId?: string; error?: string; outputNodes?: string[];
  preparingPid?: number;
  owner?: string;
}
export interface WorkflowUpload { node: string; input: string; path: string }
export interface WorkflowRun {
  workflowId: string; revision: string; requestKey: string; values?: WorkflowPatch[]; files?: WorkflowUpload[]; outputNodes?: string[];
}
export const workflowJobSummary = (job: WorkflowJob) => ({ job_id: job.id, prompt_id: job.promptId, status: job.status, request_key: job.requestKey, error: job.error });
const validId = (value: string) => /^[a-f0-9]{64}$/.test(value);
const fileFor = (dataDir: string, id: string) => {
  if (!validId(id)) throw new Error("Некорректный идентификатор задания Pi Desktop");
  return path.join(dataDir, "comfy-jobs", `${id}.json`);
};
async function saveJob(dataDir: string, job: WorkflowJob) {
  const file = fileFor(dataDir, job.id), temporary = `${file}.${randomUUID()}.tmp`;
  job.updatedAt = new Date().toISOString();
  try { await writeFile(temporary, JSON.stringify(job) + "\n", { encoding: "utf8", flag: "wx" }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}
export async function readJob(dataDir: string, id: string): Promise<WorkflowJob> {
  const job = JSON.parse(await readFile(fileFor(dataDir, id), "utf8")) as WorkflowJob;
  if (job.id !== id) throw new Error("Повреждена запись задания");
  const settings = await comfyConnection(dataDir);
  if (job.url !== settings.url) throw new Error("Задание относится к другому серверу ComfyUI. Восстановите его адрес в настройках.");
  return job;
}

export async function listWorkflowJobs(dataDir: string, offset = 0, limit = 20) {
  const { url } = await comfyConnection(dataDir);
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Некорректная страница заданий");
  let names: string[];
  try { names = await readdir(path.join(dataDir, "comfy-jobs")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; names = []; }
  const records: WorkflowJob[] = [];
  const unreadable: string[] = [];
  for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    try {
      const job: WorkflowJob = JSON.parse(await readFile(path.join(dataDir, "comfy-jobs", name), "utf8"));
      if (!job || typeof job.createdAt !== "string" || job.id !== name.slice(0, -5)) throw new Error("Invalid job record");
      if (job.url === url && job.owner === (process.env.PI_DESKTOP_CONVERSATION_ID ?? "local")) records.push(job);
    } catch { unreadable.push(name); }
  }
  records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { items: records.slice(offset, offset + limit).map(({ id, requestKey, status, createdAt, error }) => ({ job_id: id, request_key: requestKey, storedStatus: status, createdAt, error })),
    total: records.length, nextOffset: offset + limit < records.length ? offset + limit : null, unreadable, guidance: "Stored statuses are a local snapshot. Use status/wait to check the server." };
}

// Reserve the request before any POST. A lost response is an unknown outcome,
// never permission to submit the expensive generation again automatically.
export async function submitWorkflow(dataDir: string, input: WorkflowRun, compile?: WorkflowCompiler, signal?: AbortSignal) {
  if (!input.requestKey?.trim() || input.requestKey.length > 200 || !validId(input.revision)) throw new Error("Нужны requestKey и revision из inspect");
  const { url } = await comfyConnection(dataDir);
  const fingerprint = digest(JSON.stringify({ url, workflowId: input.workflowId, revision: input.revision, values: input.values ?? [], files: input.files ?? [], outputNodes: input.outputNodes }));
  const id = digest(`${process.env.PI_DESKTOP_CONVERSATION_ID ?? "local"}\0${url}\0${input.requestKey}`);
  const job: WorkflowJob = { id, requestKey: input.requestKey, fingerprint, url, workflowId: input.workflowId, revision: input.revision,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "preparing", preparingPid: process.pid, owner: process.env.PI_DESKTOP_CONVERSATION_ID ?? "local", promptId: randomUUID(), outputNodes: input.outputNodes };
  await mkdir(path.dirname(fileFor(dataDir, id)), { recursive: true });
  try { await writeFile(fileFor(dataDir, id), JSON.stringify(job) + "\n", { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A competing writeFile(wx) exposes the new file before its bytes are all
    // written. Wait for that reservation; never treat it as permission to POST.
    let existing: WorkflowJob | undefined;
    for (let attempt = 0; ; attempt++) {
      try { existing = await readJob(dataDir, id); break; }
      catch (error) {
        if (attempt >= 30 || !(error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
        await delay(20, undefined, { signal });
      }
    }
    if (existing.fingerprint !== fingerprint) throw new Error("Этот requestKey уже использован с другими параметрами. Для нового задания нужен новый ключ.");
    return { ...existing, reused: true };
  }
  try {
    const loaded = await workflowGraph(dataDir, input.workflowId, compile, signal);
    const info = await graphNodeInfo(url, loaded.graph, signal);
    if (workflowRevision(loaded.revision, loaded.graph, info) !== input.revision) throw new Error("Workflow или описания узлов изменились после inspect. Изучите его заново перед запуском.");
    const problems = graphProblems(loaded.graph, info);
    if (problems.length) throw new Error(problems.join("\n"));
    const values = [...(input.values ?? [])];
    const uploads = input.files ?? [];
    const targets = new Set(values.map(patch => JSON.stringify([patch.node, patch.input])));
    // Validate every target and local file before uploading any inputs.
    for (const upload of uploads) {
      const key = JSON.stringify([upload.node, upload.input]);
      if (targets.has(key)) throw new Error(`Повтор параметра файла ${key}`);
      targets.add(key);
      const node = loaded.graph[upload.node];
      const spec = info[node?.class_type]?.input?.required?.[upload.input] ?? info[node?.class_type]?.input?.optional?.[upload.input];
      if (!spec || !path.isAbsolute(upload.path) || linked(node.inputs[upload.input], loaded.graph) || (!Array.isArray(spec[0]) && spec[0] !== "STRING")) throw new Error(`Неизвестный/соединённый вход файла ${key} или путь не абсолютный`);
      const file = await stat(upload.path);
      if (!file.isFile() || file.size < 1 || file.size > 256 * 1024 * 1024) throw new Error("Входной файл: 1 байт–256 МБ");
    }
    applyWorkflowPatches(loaded.graph, values, info);
    if (input.outputNodes?.some(id => !loaded.graph[id] || !info[loaded.graph[id].class_type]?.output_node)) throw new Error("outputNodes должен содержать идентификаторы выходных узлов из inspect");
    for (const upload of uploads) {
      signal?.throwIfAborted();
      const bytes = await readFile(upload.path);
      const body = new FormData();
      body.append("image", new Blob([new Uint8Array(bytes)]), `pi-${randomUUID()}${path.extname(upload.path)}`);
      const response = JSON.parse((await limitedBody(await comfyFetch(url, "/upload/image", { method: "POST", body }, signal), 64 * 1024)).toString("utf8"));
      if (typeof response.name !== "string" || /[\\/\0]/.test(response.name)) throw new Error("ComfyUI вернул некорректное имя загруженного файла");
      const name = response.subfolder ? `${response.subfolder}/${response.name}` : response.name;
      // File combo lists reflect the directory before the upload; only that
      // advertised enum is relaxed, not links or input identity/type validation.
      const node = loaded.graph[upload.node], original = info[node.class_type];
      const patchedInfo = structuredClone(original);
      for (const group of ["required", "optional"]) if (patchedInfo.input?.[group]?.[upload.input]) patchedInfo.input[group][upload.input] = ["STRING", patchedInfo.input[group][upload.input][1]];
      applyWorkflowPatches(loaded.graph, [{ node: upload.node, input: upload.input, value: name }], { ...info, [node.class_type]: patchedInfo });
      node.inputs[upload.input] = name;
    }
    const graph = applyWorkflowPatches(loaded.graph, values, info);
    signal?.throwIfAborted();
    job.status = "submitting";
    await saveJob(dataDir, job);
    const response = await comfyFetch(url, "/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: graph, prompt_id: job.promptId, client_id: job.id, extra_data: { pi_desktop_job: job.id } }) }, signal);
    const result = JSON.parse((await limitedBody(response, 128 * 1024)).toString("utf8"));
    if (typeof result.prompt_id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(result.prompt_id)) throw new Error("Не получено подтверждение постановки задания в очередь");
    job.promptId = result.prompt_id;
    job.status = "queued";
    await saveJob(dataDir, job);
    return job;
  } catch (error) {
    const uncertain = job.status === "submitting" && (!(error instanceof ComfyHttpError) || error.status >= 500);
    job.status = uncertain ? "unknown" : "failed";
    job.error = error instanceof Error ? error.message : String(error);
    await saveJob(dataDir, job);
    return job;
  }
}

type ComfyHistory = { status?: { completed?: boolean; status_str?: string; messages?: [string, Record<string, unknown>][] }; outputs?: Record<string, unknown> };
async function historyFor(job: WorkflowJob, signal?: AbortSignal): Promise<ComfyHistory | undefined> {
  return (await comfyJson(job.url, `/history/${encodeURIComponent(job.promptId!)}`, signal))[job.promptId!];
}
export async function workflowJobStatus(dataDir: string, id: string, signal?: AbortSignal) {
  const job = await readJob(dataDir, id);
  if (job.status === "preparing") {
    try { if (!job.preparingPid) throw new Error("Missing owner"); process.kill(job.preparingPid, 0); return job; }
    catch {
      job.status = "failed";
      job.error = "Подготовка прервана до отправки задания в ComfyUI.";
      await saveJob(dataDir, job);
      return job;
    }
  }
  if (["failed", "cancelled", "completed"].includes(job.status)) return job;
  const history = await historyFor(job, signal);
  if (history) {
    const interrupted = history.status?.messages?.some(([name]) => name === "execution_interrupted");
    job.status = interrupted ? "cancelled" : history.status?.status_str === "error" ? "failed"
      : history.status?.completed === true || history.status?.status_str === "success" ? "completed" : "unknown";
    if (job.status === "failed") job.error = JSON.stringify(history.status?.messages ?? []).slice(0, 4000);
    else delete job.error;
  } else {
    const queue = await comfyJson(job.url, "/queue", signal);
    const match = (items: unknown[]) => Array.isArray(items) ? items.find((item: any) => Array.isArray(item) && (item[1] === job.promptId || item[3]?.client_id === job.id || item[3]?.pi_desktop_job === job.id)) as any[] | undefined : undefined;
    const running = match(queue.queue_running), pending = match(queue.queue_pending), found = running ?? pending;
    if (found) { job.promptId = String(found[1]); job.status = running ? "running" : "queued"; delete job.error; }
    else if (job.status !== "preparing") job.status = "unknown";
  }
  await saveJob(dataDir, job);
  return job;
}
export async function waitWorkflowJob(dataDir: string, id: string, seconds = 30, signal?: AbortSignal, progress?: (status: string) => void) {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 300) throw new Error("Ожидание: 0–300 секунд за вызов");
  const until = Date.now() + seconds * 1000;
  while (true) {
    const job = await workflowJobStatus(dataDir, id, signal);
    if (["completed", "failed", "cancelled", "unknown"].includes(job.status) || Date.now() >= until) return job;
    progress?.(`ComfyUI: ${job.status}. Задание ${id}`);
    await delay(Math.min(2000, until - Date.now()), undefined, { signal });
  }
}
export async function cancelWorkflowJob(dataDir: string, id: string, signal?: AbortSignal) {
  const job = await workflowJobStatus(dataDir, id, signal);
  if (["completed", "failed", "cancelled"].includes(job.status)) return job;
  try {
    await comfyFetch(job.url, `/api/jobs/${encodeURIComponent(job.promptId!)}/cancel`, { method: "POST" }, signal);
  } catch (error) {
    if (!(error instanceof ComfyHttpError) || error.status !== 404) throw error;
    if (job.status !== "queued") throw new Error("Этот ComfyUI не поддерживает адресную отмену работающего задания. Общий interrupt затронет чужую работу; отмените в ComfyUI.");
    await comfyFetch(job.url, "/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ delete: [job.promptId] }) }, signal);
  }
  // An accepted cancellation is not proof of terminal state: execution can finish in the race.
  return workflowJobStatus(dataDir, id, signal);
}

const mediaTypes: Record<string, [string, string, string]> = {
  ".png": ["image/png", "image", "image-generation"], ".jpg": ["image/jpeg", "image", "image-generation"], ".jpeg": ["image/jpeg", "image", "image-generation"], ".webp": ["image/webp", "image", "image-generation"],
  ".flac": ["audio/flac", "audio", "music-generation"], ".wav": ["audio/wav", "audio", "music-generation"], ".mp3": ["audio/mpeg", "audio", "music-generation"], ".ogg": ["audio/ogg", "audio", "music-generation"], ".opus": ["audio/ogg", "audio", "music-generation"],
  ".glb": ["model/gltf-binary", "model3d", "3d-generation"], ".mp4": ["video/mp4", "video", "video-generation"], ".webm": ["video/webm", "video", "video-generation"],
};
type Artifact = { node: string; filename: string; subfolder: string; type: "output" | "temp" };
export function workflowArtifacts(outputs: Record<string, unknown>, outputNodes?: string[]): Artifact[] {
  const result: Artifact[] = [], seen = new Set<string>();
  const visit = (value: unknown, node: string, depth: number) => {
    if (depth > 20 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach(item => visit(item, node, depth + 1)); return; }
    const item = value as Record<string, unknown>;
    if (typeof item.filename === "string" && (item.type === "output" || item.type === "temp")) {
      const subfolder = typeof item.subfolder === "string" ? item.subfolder : "";
      if (!item.filename || /[\\/\0:]/.test(item.filename) || item.filename === "." || item.filename === ".." || subfolder.includes("\\") || subfolder.startsWith("/") || subfolder.includes(":") || subfolder.split("/").includes("..")) throw new Error("Небезопасный путь результата ComfyUI");
      const key = JSON.stringify([item.type, subfolder, item.filename]);
      if (!seen.has(key)) { seen.add(key); result.push({ node, filename: item.filename, subfolder, type: item.type }); }
      return;
    }
    Object.values(item).forEach(child => visit(child, node, depth + 1));
  };
  for (const [node, output] of Object.entries(outputs)) if (!outputNodes || outputNodes.includes(node)) visit(output, node, 0);
  return result;
}
export async function collectWorkflowJob(dataDir: string, id: string, options: { offset?: number; limit?: number } = {}, signal?: AbortSignal) {
  const job = await workflowJobStatus(dataDir, id, signal);
  if (job.status !== "completed") return { job, files: [], total: 0, nextOffset: null };
  const history = await historyFor(job, signal);
  if (!history) throw new Error("История задания удалена из ComfyUI; результаты не найдены");
  const outputs = history.outputs ?? {};
  const artifacts = workflowArtifacts(outputs, job.outputNodes);
  const offset = options.offset ?? 0, limit = options.limit ?? 4;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("Некорректная страница результатов");
  const files: { path: string; mimeType: string; type: string; node: string; data?: string }[] = [];
  for (const artifact of artifacts.slice(offset, offset + limit)) {
    const [mimeType, type, folder] = mediaTypes[path.extname(artifact.filename).toLowerCase()] ?? ["application/octet-stream", "file", "comfy-results"];
    const directory = path.join(dataDir, folder);
    await mkdir(directory, { recursive: true });
    const filename = path.join(directory, `${id}-${digest(JSON.stringify(artifact)).slice(0, 12)}${path.extname(artifact.filename).toLowerCase().replace(/[^.a-z0-9]/g, "")}`);
    const query = new URLSearchParams({ filename: artifact.filename, subfolder: artifact.subfolder, type: artifact.type });
    const bytes = await limitedBody(await comfyFetch(job.url, `/view?${query}`, {}, signal), 256 * 1024 * 1024);
    if (type === "model3d") validateLocalGlb(bytes);
    await writeFile(filename, bytes);
    files.push({ path: filename, mimeType, type, node: artifact.node, ...(type === "image" && bytes.length <= 16 * 1024 * 1024 ? { data: bytes.toString("base64") } : {}) });
  }
  const reportFile = path.join(dataDir, "comfy-jobs", `${id}.results.json`);
  await writeFile(reportFile, JSON.stringify(outputs, null, 2), "utf8");
  return { job, files, total: artifacts.length, nextOffset: offset + limit < artifacts.length ? offset + limit : null, reportFile,
    reports: Object.fromEntries(Object.entries(outputs).flatMap(([node, value]) => {
      if (!value || typeof value !== "object") return [];
      const text = Object.entries(value).filter(([key]) => ["text", "report", "string"].includes(key)).map(([, text]) => JSON.stringify(text).slice(0, 1600));
      return text.length ? [[node, text.join("\n")]] : [];
    })) };
}
