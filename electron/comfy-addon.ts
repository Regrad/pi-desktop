import path from "node:path";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, readdir, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { atomicStateWrite } from "./atomic-state.js";

async function addonFiles(directory: string, prefix = ""): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name, file = path.join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, await addonFiles(file, `${relative}/`));
    else if (entry.isFile()) files[relative] = createHash("sha256").update(await readFile(file)).digest("hex");
    else throw new Error(`Unsupported ComfyUI add-on entry: ${file}`);
  }
  return files;
}

// Electron's ASAR filesystem supports reads, but not fs.cp's directory traversal.
async function copyAddon(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const input = path.join(source, entry.name);
    const output = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyAddon(input, output);
    else if (entry.isFile()) await writeFile(output, await readFile(input));
    else throw new Error(`Unsupported ComfyUI add-on entry: ${input}`);
  }
}

// Refresh stock code from app/ on startup, so copying only app/ delivers updates.
// User edits and deletions stay in data; no chat files or settings are replaced.
export async function ensureComfyAddon(dataDir: string, appRoot: string): Promise<void> {
  // The retired preparation cache contains only generated cards, never chat files.
  const retiredCache = path.resolve(dataDir, "comfy-library");
  if (path.dirname(retiredCache) !== path.resolve(dataDir)) throw new Error("Invalid ComfyUI cache path");
  if (existsSync(retiredCache)) await rm(retiredCache, { recursive: true, force: true });
  const target = path.join(dataDir, "agent", "extensions", "pi-comfyui");
  for (const name of ["comfyui_workflows", "comfyui_run_workflow", "comfyui_job"]) {
    const retiredTool = path.resolve(target, "tools", name);
    if (path.dirname(retiredTool) !== path.resolve(target, "tools")) throw new Error("Invalid retired ComfyUI tool path");
    if (existsSync(retiredTool)) await rm(retiredTool, { recursive: true, force: true });
  }
  const config = path.join(dataDir, "builtin-config");
  const marker = path.join(config, "pi-comfyui-installed.json");
  const previous = existsSync(marker) ? JSON.parse(await readFile(marker, "utf8")) as { files?: Record<string, string> } : undefined;
  if (previous && !existsSync(target)) return;
  await mkdir(config, { recursive: true });
  const template = path.join(appRoot, "resources", "pi-comfyui"), desired = await addonFiles(template);
  if (!existsSync(target)) {
    const staging = await mkdtemp(path.join(config, "comfy-addon-install-"));
    try {
      await copyAddon(template, path.join(staging, "addon"));
      await mkdir(path.dirname(target), { recursive: true });
      await rename(path.join(staging, "addon"), target);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  } else {
    let baseline = previous?.files;
    if (!baseline) {
      try {
        const manifest = JSON.parse(await readFile(path.join(dataDir, "..", ".pi-desktop-fast-update.json"), "utf8"));
        baseline = Object.fromEntries(Object.entries(manifest.files as Record<string, string>)
          .filter(([name]) => name.startsWith("resources/pi-comfyui/")).map(([name, hash]) => [name.slice("resources/pi-comfyui/".length), hash]));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    const current = await addonFiles(target);
    if (baseline) for (const name of new Set([...Object.keys(desired), ...Object.keys(baseline)])) {
      if (path.isAbsolute(name) || /[\\:]/.test(name) || name.split("/").some(part => !part || part === "." || part === ".."))
        throw new Error("Некорректный путь в версии расширения ComfyUI");
      const destination = path.join(target, ...name.split("/"));
      if (current[name] === desired[name] || (baseline[name] && current[name] !== baseline[name]) || (!baseline[name] && current[name])) continue;
      if (desired[name]) { await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, await readFile(path.join(template, ...name.split("/")))); }
      else if (current[name]) await rm(destination);
    }
  }
  await atomicStateWrite(marker, JSON.stringify({ version: 2, files: desired }) + "\n");
}
