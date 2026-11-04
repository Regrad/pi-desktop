import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { hostRequire } from "./lib/host.js";
import { createToolContext } from "./lib/context.js";
import { loadComfySettings } from "./lib/comfy-client.js";

// Do not reactivate obsolete universal modules preserved as user-edited files on update.
const retired = new Set(["comfyui_workflows", "comfyui_run_workflow", "comfyui_job"]);

export default async function comfyAddon(pi: ExtensionAPI) {
  const dataDir = process.env.PI_DESKTOP_DATA_DIR;
  if (!dataDir) return;
  const { createJiti } = hostRequire("jiti") as typeof import("jiti");
  const load = createJiti(import.meta.url, {
    moduleCache: false,
    alias: { typebox: hostRequire.resolve("typebox"), "image-size": hostRequire.resolve("image-size") },
  });
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "tools");
  const context = createToolContext(dataDir);
  const definitions: { name: string; publish: () => void }[] = [];
  // Validate every module before publishing any tools: no partial registrations on load failure.
  const api = Object.create(pi) as ExtensionAPI;
  // Capture each definition with its own schema/details types instead of erasing generics.
  api.registerTool = (definition) => {
    definitions.push({ name: definition.name, publish: () => pi.registerTool(definition) });
  };
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || retired.has(entry.name)) continue;
    const name = entry.name;
    const files = await readdir(path.join(root, name));
    const filename = ["index.ts", "index.js", "index.mjs"].find(file => files.includes(file));
    if (!filename) continue;
    const register = await load.import(path.join(root, name, filename), { default: true });
    if (typeof register !== "function") throw new Error(`ComfyUI: ${name} must export a registration function`);
    await register(api, context);
  }
  const names = new Set<string>();
  for (const definition of definitions) {
    if (names.has(definition.name)) throw new Error(`ComfyUI: duplicate tool ${definition.name}`);
    names.add(definition.name);
  }
  for (const definition of definitions) definition.publish();
  pi.on("before_agent_start", async event => {
    if (!(await loadComfySettings(dataDir)).enabled) return;
    return { systemPrompt: `${event.systemPrompt}\n\nLocal ComfyUI tools are available through codemode. Discover the specialized tool for the requested image, music, speech or 3D operation and read its parameters before calling it. Each tool supplies its workflow; no workflow discovery or preparation is needed. Keep defaults unless the task requires changes. Saved results are displayed in chat.` };
  });
}
