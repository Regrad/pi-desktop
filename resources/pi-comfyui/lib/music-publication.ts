import path from "node:path";
import { chatFileDirectory } from "./chat-storage.js";
import { realpath, stat } from "node:fs/promises";

const audioTypes: Record<string, string> = {
  ".flac": "audio/flac", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".opus": "audio/ogg",
};

// Publish references only: no audio bytes, directory scans or new copies in history.
export async function selectMusicForAnswer(dataDir: string, tracks: string[], signal?: AbortSignal) {
  if (!Array.isArray(tracks) || tracks.length > 64) throw new Error("Выберите не более 64 треков");
  const media: { type: "audio"; path: string; mimeType: string }[] = [];
  if (!tracks.length) return media;
  const folder = await realpath(chatFileDirectory(dataDir, "music-generation"));
  const seen = new Set<string>();
  for (const requested of tracks) {
    signal?.throwIfAborted();
    if (typeof requested !== "string" || !path.isAbsolute(requested))
      throw new Error("Нужен абсолютный путь к готовому треку в music-generation");
    const file = await realpath(requested);
    const mimeType = audioTypes[path.extname(file).toLowerCase()];
    if (path.dirname(file) !== folder || !mimeType || !(await stat(file)).isFile())
      throw new Error("Выбирать можно только готовые аудиофайлы из music-generation");
    const key = process.platform === "win32" ? file.toLowerCase() : file;
    if (seen.has(key)) continue;
    seen.add(key);
    media.push({ type: "audio", path: file, mimeType });
  }
  signal?.throwIfAborted();
  return media;
}
