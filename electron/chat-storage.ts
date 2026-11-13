import path from "node:path";
import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { mkdir, readdir, readFile, rename, realpath, lstat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Attachment } from "../shared/types.js";
import { chatDirectory, mediaFolders } from "../resources/pi-comfyui/lib/chat-storage.js";
export { chatDirectory } from "../resources/pi-comfyui/lib/chat-storage.js";

const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

/** Rename only owned local files. Never follow a reparse point or overwrite a destination. */
export async function moveOwnedFile(dataDir: string, source: string, destination: string): Promise<void> {
  const root = await realpath(dataDir);
  if (!inside(path.resolve(dataDir), path.resolve(source)) || !inside(path.resolve(dataDir, "chats"), path.resolve(destination)))
    throw new Error("Перенос файла за пределы хранилища чатов запрещён");
  if ((await lstat(source)).isSymbolicLink() || !inside(root, await realpath(source))) throw new Error("Вместо собственного файла обнаружена ссылка");
  await mkdir(path.dirname(destination), { recursive: true });
  if (!inside(root, await realpath(path.dirname(destination)))) throw new Error("Папка назначения находится вне data");
  if (existsSync(destination)) throw new Error(`Файл назначения уже существует: ${destination}`);
  await rename(source, destination);
}

/** External files remain references. Only clipboard bytes and our pending uploads are owned. */
export async function storeChatAttachments(dataDir: string, id: string, attachments: Attachment[]): Promise<Attachment[]> {
  const folder = path.join(chatDirectory(dataDir, id), "chat-attachments");
  const result: Attachment[] = [];
  for (const attachment of attachments) {
    if (!path.isAbsolute(attachment.path) && attachment.data && attachment.mimeType?.startsWith("image/")) {
      const bytes = Buffer.from(attachment.data, "base64");
      const extension = attachment.mimeType === "image/jpeg" ? ".jpg" : attachment.mimeType === "image/webp" ? ".webp" : ".png";
      const file = path.join(folder, `attached-${createHash("sha256").update(bytes).digest("hex")}${extension}`);
      await mkdir(folder, { recursive: true });
      if (!inside(await realpath(dataDir), await realpath(folder))) throw new Error("Папка вложений находится вне data");
      try { await writeFile(file, bytes, { flag: "wx" }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!(await readFile(file)).equals(bytes)) throw new Error("Файл вложения повреждён");
      }
      result.push({ ...attachment, path: file });
    } else if (path.isAbsolute(attachment.path) && inside(path.resolve(dataDir, "incoming-attachments"), path.resolve(attachment.path))) {
      const destination = path.join(folder, path.basename(attachment.path));
      if (existsSync(attachment.path)) await moveOwnedFile(dataDir, attachment.path, destination);
      else if (!existsSync(destination)) throw new Error("Вложение не найдено");
      result.push({ ...attachment, path: destination });
    } else result.push(attachment);
  }
  return result;
}

/** One-time, resumable migration. Unknown/shared old results are retained, never guessed or deleted. */
export async function migrateChatFiles(dataDir: string, conversations: { id: string; sessionFile?: string }[]) {
  const marker = path.join(dataDir, "chat-storage-v1.json");
  if (existsSync(marker)) return;
  const ids = new Set(conversations.map(chat => chat.id));
  for (const id of ids) chatDirectory(dataDir, id);
  const owners = new Map<string, Set<string>>(), jobs = new Map<string, string>();
  const names = async (directory: string) => readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code !== "ENOENT") throw error; return [];
  });
  for (const entry of await names(path.join(dataDir, "comfy-jobs"))) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    const source = path.join(dataDir, "comfy-jobs", entry.name);
    let job; try { job = JSON.parse(await readFile(source, "utf8")); }
    catch (error) { if (!(error instanceof SyntaxError)) throw error; console.warn(`Сохранена повреждённая запись задания: ${entry.name}`); continue; }
    if (job.id !== entry.name.slice(0, -5) || !ids.has(job.owner)) continue;
    jobs.set(job.id, job.owner);
    await moveOwnedFile(dataDir, source, path.join(chatDirectory(dataDir, job.owner), "comfy-jobs", entry.name));
    const report = path.join(dataDir, "comfy-jobs", `${job.id}.results.json`);
    if (existsSync(report)) await moveOwnedFile(dataDir, report, path.join(chatDirectory(dataDir, job.owner), "comfy-jobs", `${job.id}.results.json`));
  }
  // Recover a move interrupted after its job record was relocated.
  for (const id of ids) for (const entry of await names(path.join(chatDirectory(dataDir, id), "comfy-jobs")))
    if (entry.isFile() && /^[a-f0-9]{64}\.json$/.test(entry.name)) jobs.set(entry.name.slice(0, -5), id);
  const legacy = new Map<string, string>();
  for (const folder of mediaFolders) for (const entry of await names(path.join(dataDir, folder)))
    if (entry.isFile()) legacy.set(`${folder}/${entry.name}`, path.join(dataDir, folder, entry.name));
  if (legacy.size) for (const chat of conversations) {
    if (!chat.sessionFile || !existsSync(chat.sessionFile)) continue;
    const collect = (value: unknown) => {
      if (typeof value === "string") {
        for (const folder of mediaFolders) {
          if (!path.isAbsolute(value) || path.dirname(path.resolve(value)) !== path.resolve(dataDir, folder)) continue;
          const key = `${folder}/${path.basename(value)}`;
          if (legacy.has(key)) { const set = owners.get(key) ?? new Set<string>(); set.add(chat.id); owners.set(key, set); }
        }
      } else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === "object") for (const [key, item] of Object.entries(value))
        if (!["data", "text", "before", "after"].includes(key)) collect(item);
    };
    const lines = createInterface({ input: createReadStream(chat.sessionFile, "utf8"), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let entry; try { entry = JSON.parse(line); } catch { continue; }
      if (entry.type === "message" && entry.message?.role === "toolResult") collect(entry.message.details);
    }
  }
  let moved = 0, unassigned = 0;
  for (const [key, source] of legacy) {
    const basename = path.basename(source), jobOwner = jobs.get(basename.slice(0, 64));
    const references = owners.get(key), owner = jobOwner ?? (references?.size === 1 ? [...references][0] : undefined);
    if (!owner) { unassigned++; continue; }
    await moveOwnedFile(dataDir, source, path.join(chatDirectory(dataDir, owner), ...key.split("/"))); moved++;
  }
  for (const id of ids) {
    const source = path.join(dataDir, "runs", `${id}.json`);
    if (existsSync(source)) await moveOwnedFile(dataDir, source, path.join(chatDirectory(dataDir, id), "run.json"));
  }
  await writeFile(marker, JSON.stringify({ version: 1, moved, unassigned }) + "\n", { flag: "wx" });
  if (unassigned) console.warn(`Сохранены старые результаты без однозначного владельца: ${unassigned}. Файлы не удалены.`);
}
