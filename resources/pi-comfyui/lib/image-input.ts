import path from "node:path";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { hostRequire } from "./host.js";
const { imageSize } = hostRequire("image-size") as typeof import("image-size");
import type { HistoryImage } from "../shared/image-attachments.js";

export async function readImageInput(reference: string, resolveAttachment?: (reference: string) => HistoryImage) {
  let bytes: Buffer;
  if (reference.startsWith("attachment:")) {
    if (!resolveAttachment) throw new Error("Вложение доступно только в контексте чата");
    const image = resolveAttachment(reference);
    if (!image.mimeType.startsWith("image/") || image.data.length > 45 * 1024 * 1024) throw new Error("Некорректное изображение или размер больше 32 МБ");
    bytes = Buffer.from(image.data, "base64");
  } else {
    if (!path.isAbsolute(reference) || !/\.(png|jpe?g|webp)$/i.test(reference)) throw new Error("Нужен абсолютный путь к PNG, JPEG, WebP или attachment: ссылка");
    const info = await stat(reference);
    if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error("Исходное изображение должно быть до 32 МБ");
    bytes = await readFile(reference);
  }
  if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw new Error("Некорректный размер изображения");
  const size = imageSize(bytes);
  const formats: Record<string, { mimeType: string; extension: string }> = {
    png: { mimeType: "image/png", extension: ".png" }, jpg: { mimeType: "image/jpeg", extension: ".jpg" }, webp: { mimeType: "image/webp", extension: ".webp" },
  };
  const format = formats[size.type ?? ""];
  if (!format) throw new Error("Поддерживаются только PNG, JPEG и WebP");
  const rotated = size.orientation === 6 || size.orientation === 8;
  const width = rotated ? size.height : size.width, height = rotated ? size.width : size.height;
  if (!width || !height || width > 8192 || height > 8192 || width * height > 32 * 1024 * 1024) throw new Error("Изображение слишком большое: максимум 8192 по стороне и 32 мегапикселя");
  return { bytes, width, height, ...format };
}

export async function publishImage(dataDir: string, reference: string, resolveAttachment?: (reference: string) => HistoryImage) {
  const image = await readImageInput(reference, resolveAttachment);
  const folder = path.join(dataDir, "image-generation");
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, `shown-${randomUUID()}${image.extension}`);
  await writeFile(file, image.bytes, { flag: "wx" });
  return { path: file, mimeType: image.mimeType, data: image.bytes.toString("base64") };
}

export async function imagePathForTool(dataDir: string, reference: string, resolveAttachment?: (reference: string) => HistoryImage) {
  const image = await readImageInput(reference, resolveAttachment);
  if (process.env.PI_DESKTOP_REMOTE === "1") {
    // Explicit materialization only: cropping/scripts run on the CLIENT, not the host.
    const response = await fetch(process.env.PI_DESKTOP_REMOTE_URL!, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.PI_DESKTOP_REMOTE_TOKEN}` },
      body: JSON.stringify({ operation: "saveAttachment", args: { data: image.bytes.toString("base64"), extension: image.extension } }),
    });
    const result = await response.json() as { result?: { path: string }; error?: string };
    if (!response.ok || !result.result) throw new Error(result.error || "Не удалось передать выбранное изображение на клиентский ПК");
    return { path: result.result.path, width: image.width, height: image.height, mimeType: image.mimeType };
  }
  if (!reference.startsWith("attachment:")) return { path: reference, width: image.width, height: image.height, mimeType: image.mimeType };
  const folder = path.join(dataDir, "chat-attachments");
  await mkdir(folder, { recursive: true });
  const digest = createHash("sha256").update(image.bytes).digest("hex");
  const file = path.join(folder, `attached-${digest}${image.extension}`);
  try {
    await writeFile(file, image.bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!(await readFile(file)).equals(image.bytes)) throw new Error("Сохранённое изображение отличается от вложения чата");
  }
  return { path: file, width: image.width, height: image.height, mimeType: image.mimeType };
}
