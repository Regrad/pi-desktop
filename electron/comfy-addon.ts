import path from "node:path";
import { existsSync } from "node:fs";
import { readFile, readdir, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";

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

// Seed the editable Pi extension once. User edits/deletion must survive app updates.
export async function ensureComfyAddon(dataDir: string, appRoot: string): Promise<void> {
  const target = path.join(dataDir, "agent", "extensions", "pi-comfyui");
  const config = path.join(dataDir, "builtin-config");
  const marker = path.join(config, "pi-comfyui-installed.json");
  if (existsSync(marker)) return;
  await mkdir(config, { recursive: true });
  if (!existsSync(target)) {
    const staging = await mkdtemp(path.join(config, "comfy-addon-install-"));
    try {
      await copyAddon(path.join(appRoot, "resources", "pi-comfyui"), path.join(staging, "addon"));
      await mkdir(path.dirname(target), { recursive: true });
      await rename(path.join(staging, "addon"), target);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  await writeFile(marker, JSON.stringify({ version: 1 }) + "\n", "utf8");
}
