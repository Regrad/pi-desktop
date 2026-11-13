import path from "node:path";
import { chatFileDirectory } from "./chat-storage.js";
import { mkdir, writeFile } from "node:fs/promises";
import { validateLocalGlb } from "../shared/glb.js";

const formats: Record<string, string> = { ".glb": "model/gltf-binary", ".obj": "text/plain", ".mtl": "text/plain", ".fbx": "application/octet-stream", ".stl": "application/octet-stream", ".ply": "application/octet-stream", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

export function modelReportFiles(report: unknown): string[] {
  if (!report || typeof report !== "object" || Array.isArray(report)) return [];
  const r = report as Record<string, unknown>;
  return [...new Set([
    ...[r.result, r.quad_obj].filter((value): value is string => typeof value === "string" && !!value),
    ...[r.files, r.renders, r.lod_paths].flatMap(value => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []),
    ...(r.texture_maps && typeof r.texture_maps === "object" ? Object.values(r.texture_maps).filter((item): item is string => typeof item === "string") : []),
    ...(Array.isArray(r.lod_reports) ? r.lod_reports.flatMap(modelReportFiles) : []),
  ])];
}

export function modelArtifactLocation(file: string, prefix: string) {
  if (!/^3d\/pi-desktop\/[a-zA-Z0-9_-]+$/.test(prefix)) throw new Error("Некорректная папка результатов 3D");
  const normalized = file.replaceAll("\\", "/");
  const marker = `/${prefix}/`;
  const index = normalized.indexOf(marker);
  const relative = index >= 0 ? normalized.slice(index + 1) : normalized.startsWith(`${prefix}/`) ? normalized : "";
  if (!relative || relative.split("/").some(part => !part || part === "." || part === ".." || /[:\0]/.test(part)))
    throw new Error("ComfyUI вернул файл за пределами папки этого задания");
  const extension = path.posix.extname(relative).toLowerCase();
  if (!formats[extension]) throw new Error(`Неподдерживаемый 3D-файл: ${extension}`);
  return { filename: path.posix.basename(relative), subfolder: path.posix.dirname(relative), mimeType: formats[extension] };
}

export async function saveModelArtifacts(dataDir: string, id: string, prefix: string, outputs: Record<string, { text?: string[] }>, reportNodes: string[], download: (filename: string, subfolder: string, limit: number) => Promise<Buffer>) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Некорректный идентификатор задания 3D");
  const reports: Record<string, unknown> = {};
  for (const node of reportNodes) {
    for (const text of outputs[node]?.text ?? []) {
      if (typeof text !== "string" || text.length > 1024 * 1024) throw new Error("Некорректный отчёт обработки 3D");
      if (!text.trim().startsWith("{")) continue;
      let report: unknown;
      try { report = JSON.parse(text); } catch { throw new Error("Некорректный JSON отчёта 3D"); }
      if (modelReportFiles(report).length) reports[node] = report;
    }
  }
  const references = [...new Set(Object.values(reports).flatMap(modelReportFiles))];
  if (!references.length) throw new Error("ComfyUI не вернул отчёт с готовыми 3D-файлами");
  // Validate every returned path before making any download request.
  const locations = references.map(file => modelArtifactLocation(file, prefix));
  const reportedLocations = new Set(locations.map(location => `${location.subfolder}/${location.filename}`));
  const folder = chatFileDirectory(dataDir, "3d-generation");
  await mkdir(folder, { recursive: true });
  const files: { path: string; mimeType: string; nodeId: string; data?: string }[] = [];
  const localPaths = new Map<string, string>();
  const savedLocations = new Map<string, string>();
  const renders = new Set(Object.values(reports).flatMap(report => report && typeof report === "object" && "renders" in report && Array.isArray(report.renders) ? report.renders : []));
  const warnings: string[] = [];
  const companions = new Map<string, Buffer>();
  for (const [index, location] of locations.entries()) {
    const key = `${location.subfolder}/${location.filename}`;
    const saved = savedLocations.get(key);
    if (saved) { localPaths.set(references[index], saved); continue; }
    const bytes = await download(location.filename, location.subfolder, location.mimeType === "image/png" ? 32 * 1024 * 1024 : 256 * 1024 * 1024);
    if (location.mimeType === "model/gltf-binary") validateLocalGlb(bytes);
    // GLBs stay at the viewer's root; keep OBJ/MTL/texture bundles in their original relative layout.
    const relative = path.posix.join(location.subfolder, location.filename).slice(prefix.length + 1);
    const file = renders.has(references[index]) ? path.join(chatFileDirectory(dataDir, "image-generation"), `${id}-${index + 1}-${location.filename}`)
      : location.mimeType === "model/gltf-binary" ? path.join(folder, `${id}-${index + 1}-${location.filename}`)
      : path.join(folder, `${id}-assets`, ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes, { flag: "wx" });
    localPaths.set(references[index], file);
    savedLocations.set(key, file);
    files.push({ path: file, mimeType: location.mimeType, nodeId: reportNodes.find(node => modelReportFiles(reports[node]).includes(references[index])) ?? "" });
    if (/\.obj$/i.test(location.filename)) {
      for (const line of bytes.toString("utf8").split(/\r?\n/)) {
        const mtl = /^mtllib\s+(.+)$/i.exec(line.trim());
        if (!mtl) continue;
        const name = mtl[1].trim();
        if (!name || /[\\/:\0]/.test(name) || !/\.mtl$/i.test(name)) { warnings.push("OBJ material reference cannot be safely copied; use the GLB for complete appearance."); continue; }
        const ref = `${location.subfolder}/${name}`;
        if (reportedLocations.has(ref) || companions.has(ref)) continue;
        const mtlLocation = modelArtifactLocation(ref, prefix);
        try { companions.set(ref, await download(mtlLocation.filename, mtlLocation.subfolder, 4 * 1024 * 1024)); }
        catch { warnings.push(`OBJ material ${name} was not returned; geometry is saved, use GLB for appearance.`); }
      }
    }
  }
  for (const [reference, bytes] of companions) {
    const location = modelArtifactLocation(reference, prefix);
    const file = path.join(folder, `${id}-assets`, ...reference.slice(prefix.length + 1).split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes, { flag: "wx" });
    files.push({ path: file, mimeType: location.mimeType, nodeId: "" });
    // Blender OBJ exports may point to texture files outside the job. Never follow those paths.
    if (/^\s*(?:map_|bump|disp|refl)\S*\s+/im.test(bytes.toString("utf8"))) warnings.push("OBJ material has external texture references; they were not copied. The returned GLB embeds its textures and is the complete textured result.");
  }
  const relocate = (value: unknown): unknown => typeof value === "string" ? localPaths.get(value) ?? value
    : Array.isArray(value) ? value.map(relocate)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relocate(item)])) : value;
  const localReports = relocate(reports) as Record<string, unknown>;
  if (warnings.length) localReports.download_warnings = warnings;
  const recordFile = path.join(folder, `${id}-report.json`);
  await writeFile(recordFile, JSON.stringify(localReports, null, 2) + "\n", { flag: "wx" });
  return { files, totalFiles: files.length, artifactReports: localReports, recordFile };
}
