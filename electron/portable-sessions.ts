import path from "node:path";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";

type SessionReference = { id: string; sessionFile?: string };

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function portableSessionsDir(dataDir: string): string {
  return path.resolve(dataDir, "agent", "sessions");
}

function sessionTarget(dataDir: string, reference: string): string {
  const root = portableSessionsDir(dataDir);
  const absolute = path.resolve(dataDir, reference);
  if (within(root, absolute) && path.extname(absolute).toLowerCase() === ".jsonl") return absolute;
  const normalized = reference.replaceAll("\\", "/");
  const marker = normalized.toLowerCase().lastIndexOf("/sessions/");
  if (marker < 0) throw new Error("Некорректный путь сессии Pi");
  const tail = normalized.slice(marker + "/sessions/".length);
  const target = path.resolve(root, tail);
  if (!within(root, target) || path.extname(target).toLowerCase() !== ".jsonl")
    throw new Error("Некорректный путь сессии Pi");
  return target;
}

// Runtime uses absolute paths; only the on-disk index uses relative paths.
export function storedSessionReference(dataDir: string, file: string): string {
  const root = portableSessionsDir(dataDir);
  const resolved = path.resolve(file);
  if (!within(root, resolved) || path.extname(resolved).toLowerCase() !== ".jsonl")
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
    let target = conversation.sessionFile ? sessionTarget(dataDir, conversation.sessionFile) : undefined;
    if (target && await regularFile(target)) {
      // Reject junction/symlink escapes without changing a user's files.
      if (!within(await realpath(root), await realpath(target))) throw new Error("Сессия выходит за пределы портативной папки");
      result.push({ ...conversation, sessionFile: target });
      continue;
    }
    let source: string | undefined;
    if (conversation.sessionFile && path.isAbsolute(conversation.sessionFile) && await regularFile(conversation.sessionFile))
      source = conversation.sessionFile;
    if (!source && target) {
      const legacy = path.resolve(legacyRoot, path.relative(root, target));
      if (within(path.resolve(legacyRoot), legacy) && await regularFile(legacy)) source = legacy;
    }
    if (!source) {
      // Recover a reference lost by an older build, using the exact session id,
      // but never import unrelated chats from the user's global Pi directory.
      const suffix = `_${conversation.id}.jsonl`;
      localIndex ??= await sessionFiles(root);
      const local = localIndex.find((file) => path.basename(file).endsWith(suffix));
      if (local) { result.push({ ...conversation, sessionFile: local }); continue; }
      legacyIndex ??= await sessionFiles(legacyRoot);
      source = legacyIndex.find((file) => path.basename(file).endsWith(suffix));
    }
    if (!source) {
      if (conversation.sessionFile) missing.push(conversation.id);
      result.push(target ? { ...conversation, sessionFile: target } : { ...conversation });
      continue;
    }
    target ??= sessionTarget(dataDir, source);
    await mkdir(path.dirname(target), { recursive: true });
    // Existing portable history wins: never replace it with an older global copy.
    try {
      await copyFile(source, target, constants.COPYFILE_EXCL);
      if (await sessionFileHash(source) !== await sessionFileHash(target)) throw new Error("Копия сессии Pi не прошла проверку");
      copied++;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    result.push({ ...conversation, sessionFile: target });
  }
  return { conversations: result, copied, missing };
}
