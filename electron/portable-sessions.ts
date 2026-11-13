import path from "node:path";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, realpath, stat, rename, lstat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { chatDirectory } from "../resources/pi-comfyui/lib/chat-storage.js";

type SessionReference = { id: string; sessionFile?: string };

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function portableSessionsDir(dataDir: string): string {
  return path.resolve(dataDir, "agent", "sessions");
}

function sessionTarget(dataDir: string, reference: string, id: string): string {
  const root = path.join(chatDirectory(dataDir, id), "sessions");
  const normalized = reference.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) throw new Error("Некорректный путь сессии Pi");
  const marker = normalized.toLowerCase().lastIndexOf("/sessions/");
  if (marker < 0 && !normalized.startsWith("agent/sessions/")) throw new Error("Некорректный путь сессии Pi");
  const target = path.resolve(root, path.posix.basename(normalized));
  if (!within(root, target) || path.extname(target).toLowerCase() !== ".jsonl")
    throw new Error("Некорректный путь сессии Pi");
  return target;
}

// Runtime uses absolute paths; only the on-disk index uses relative paths.
export function storedSessionReference(dataDir: string, file: string): string {
  const root = portableSessionsDir(dataDir);
  const resolved = path.resolve(file);
  const owned = path.relative(path.resolve(dataDir, "chats"), resolved).split(path.sep).join("/");
  if ((!within(root, resolved) && !/^[a-zA-Z0-9_-]{1,128}\/sessions\/[^/]+\.jsonl$/i.test(owned)) || path.extname(resolved).toLowerCase() !== ".jsonl")
    throw new Error("Сессия находится вне портативной папки Pi Desktop");
  return path.relative(path.resolve(dataDir), resolved).replaceAll("\\", "/");
}

async function regularFile(file: string): Promise<boolean> {
  try { return (await stat(file)).isFile(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export async function sessionFileHash(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function sessionFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(folder: string) {
    let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      if (entry.isDirectory()) await visit(path.join(folder, entry.name));
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.join(folder, entry.name));
    }
  }
  await visit(root);
  return files;
}

export async function migratePortableSessions<T extends SessionReference>(
  dataDir: string, conversations: T[], legacyRoot: string,
): Promise<{ conversations: T[]; copied: number; missing: string[] }> {
  const root = portableSessionsDir(dataDir);
  await mkdir(root, { recursive: true });
  let copied = 0;
  const missing: string[] = [];
  let localIndex: string[] | undefined, legacyIndex: string[] | undefined;
  const result: T[] = [];
  for (const conversation of conversations) {
    let target = conversation.sessionFile ? sessionTarget(dataDir, conversation.sessionFile, conversation.id) : undefined;
    if (target && await regularFile(target)) {
      // Reject junction/symlink escapes without changing a user's files.
      if (!within(await realpath(dataDir), await realpath(target))) throw new Error("Сессия выходит за пределы портативной папки");
      result.push({ ...conversation, sessionFile: target });
      continue;
    }
    let source: string | undefined;
    if (conversation.sessionFile && path.isAbsolute(conversation.sessionFile) && await regularFile(conversation.sessionFile))
      source = conversation.sessionFile;
    if (!source && conversation.sessionFile) {
      const normalized = conversation.sessionFile.replaceAll("\\", "/");
      const tail = normalized.slice(normalized.toLowerCase().lastIndexOf("/sessions/") + "/sessions/".length);
      for (const directory of [root, legacyRoot]) {
        const legacy = path.resolve(directory, tail);
        if (within(path.resolve(directory), legacy) && await regularFile(legacy)) { source = legacy; break; }
      }
    }
    if (!source) {
      // Recover a reference lost by an older build, using the exact session id,
      // but never import unrelated chats from the user's global Pi directory.
      const suffix = `_${conversation.id}.jsonl`;
      localIndex ??= await sessionFiles(root);
      const local = localIndex.find((file) => path.basename(file).endsWith(suffix));
      if (local) source = local;
      else {
        legacyIndex ??= await sessionFiles(legacyRoot);
        source = legacyIndex.find((file) => path.basename(file).endsWith(suffix));
      }
      if (!source) {
        const owned = path.join(chatDirectory(dataDir, conversation.id), "sessions");
        source = (await sessionFiles(owned)).find(file => path.basename(file).endsWith(suffix));
      }
    }
    if (!source) {
      if (conversation.sessionFile) missing.push(conversation.id);
      result.push(target ? { ...conversation, sessionFile: target } : { ...conversation });
      continue;
    }
    target ??= sessionTarget(dataDir, source, conversation.id);
    await mkdir(path.dirname(target), { recursive: true });
    if (!within(await realpath(dataDir), await realpath(path.dirname(target)))) throw new Error("Папка сессии находится вне data");
    // Existing portable history wins: never replace it with an older global copy.
    try {
      if (path.resolve(source) !== path.resolve(target)) {
        if ((await lstat(source)).isSymbolicLink()) throw new Error("Вместо сессии обнаружена ссылка");
        if (within(await realpath(dataDir), await realpath(source))) await rename(source, target);
        else {
          await copyFile(source, target, constants.COPYFILE_EXCL);
          if (await sessionFileHash(source) !== await sessionFileHash(target)) throw new Error("Копия сессии Pi не прошла проверку");
          copied++;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    result.push({ ...conversation, sessionFile: target });
  }
  return { conversations: result, copied, missing };
}
