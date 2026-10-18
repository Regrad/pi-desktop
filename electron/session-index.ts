import { readdir, stat } from "node:fs/promises";
import path from "node:path";

/** Cheap invalidation of sidebar metadata: no JSONL content or SDK is loaded. */
export async function sessionDirectoryStamp(directory: string): Promise<string> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "[]"; throw error; }
  const files = [];
  for (const entry of entries.filter(entry => entry.isFile() && entry.name.endsWith(".jsonl")).sort((a, b) => a.name.localeCompare(b.name))) {
    try {
      const info = await stat(path.join(directory, entry.name));
      files.push([entry.name, info.size, info.mtimeMs, info.ctimeMs]);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return JSON.stringify(files);
}
