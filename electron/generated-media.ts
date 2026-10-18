import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";

export async function generatedFile(dataDir: string, kind: string, filename: string): Promise<string> {
  if (!["image", "music", "model3d", "video", "artifact"].includes(kind) || !filename || filename === "." || filename === ".." || /[\\/\0:]/.test(filename))
    throw new Error("Некорректный файл генерации");
  const folder = await realpath(path.join(dataDir, kind === "artifact" ? "comfy-results" : kind === "video" ? "video-generation" : kind === "model3d" ? "3d-generation" : kind === "music" ? "music-generation" : "image-generation"));
  const file = await realpath(path.join(folder, filename));
  if (path.dirname(file) !== folder || !(await stat(file)).isFile()) throw new Error("Файл генерации не найден");
  return file;
}

// Stream from the portable data directory, with seeking; never load a full track into chat history.
export async function generatedMediaResponse(dataDir: string, request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    if (url.search || url.hash || !["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 400 });
    const file = await generatedFile(dataDir, url.hostname, decodeURIComponent(url.pathname.slice(1)));
    const types: Record<string, string> = url.hostname === "model3d" ? { ".glb": "model/gltf-binary" } : url.hostname === "image" ? { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" } : { ".flac": "audio/flac", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".opus": "audio/ogg", ".ogg": "audio/ogg" };
    const mime = url.hostname === "artifact" ? "application/octet-stream" : url.hostname === "video" ? ({ ".mp4": "video/mp4", ".webm": "video/webm" } as Record<string, string>)[path.extname(file).toLowerCase()] : types[path.extname(file).toLowerCase()];
    if (!mime) return new Response(null, { status: 415 });
    const { size } = await stat(file);
    let start = 0, end = size - 1;
    const range = request.headers.get("range");
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
      end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (start > end || start >= size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    const headers: Record<string, string> = { "Content-Type": mime, "Content-Length": String(Math.max(0, end - start + 1)), "Accept-Ranges": "bytes" };
    if (url.hostname === "artifact") headers["Content-Disposition"] = "attachment";
    const origin = request.headers.get("origin");
    if (origin === "null" || origin === "http://127.0.0.1:5173") headers["Access-Control-Allow-Origin"] = origin;
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
    return new Response(request.method === "HEAD" || size === 0 ? null : Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers });
  } catch {
    return new Response(null, { status: 404 });
  }
}
