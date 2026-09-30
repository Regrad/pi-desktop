// Convert the user's two local YuE2 editor workflows into bundled API graphs.
// This is a mechanical conversion only: it does not queue either workflow.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const folder = process.argv[2];
if (!folder) throw new Error("Usage: node scripts/import-yue2-workflows.mjs <ComfyUI workflows folder>");
const info = await (await fetch("http://127.0.0.1:8188/object_info")).json();
const profiles = {};
for (const [mode, filename] of [
  ["music", "YuE2 — расширенная генерация.json"],
  ["music_cover", "YuE2 — расширенный кавер.json"],
]) {
  const gui = JSON.parse(await readFile(path.join(folder, filename), "utf8"));
  const graph = {};
  for (const node of gui.nodes) {
    if (node.mode !== 0) throw new Error(`Disabled or bypassed node ${node.id}`);
    if (!info[node.type]) throw new Error(`Missing node type ${node.type}`);
    const inputs = {};
    let widgetIndex = 0;
    for (const port of node.inputs ?? []) {
      let value;
      if (port.widget) {
        value = node.widgets_values?.[widgetIndex++];
        if (["seed", "value"].includes(port.name) && ["fixed", "increment", "decrement", "randomize"].includes(node.widgets_values?.[widgetIndex])) widgetIndex++;
        const type = info[node.type].input.required?.[port.name]?.[0] ?? info[node.type].input.optional?.[port.name]?.[0];
        if (["INT", "FLOAT"].includes(type) && typeof value === "string" && value.trim() && Number.isFinite(Number(value))) value = Number(value);
      }
      if (!(port.name in (info[node.type].input.required ?? {})) && !(port.name in (info[node.type].input.optional ?? {}))) continue;
      if (port.link != null) {
        const link = gui.links.find(entry => entry[0] === port.link);
        if (!link) throw new Error(`Missing link ${port.link}`);
        inputs[port.name] = [String(link[1]), link[2]];
      } else if (port.widget && port.name !== "upload") inputs[port.name] = value;
    }
    graph[String(node.id)] = { class_type: node.type, inputs };
  }
  const saves = Object.entries(graph).filter(([, node]) => node.class_type === "SaveAudioAdvanced");
  if (saves.length !== 1) throw new Error(`Expected one audio save node in ${filename}`);
  const used = new Set();
  function visit(id) {
    if (used.has(id)) return;
    const node = graph[id];
    if (!node) throw new Error(`Missing dependency ${id}`);
    used.add(id);
    for (const value of Object.values(node.inputs)) if (Array.isArray(value) && typeof value[0] === "string" && Number.isInteger(value[1])) visit(value[0]);
  }
  visit(saves[0][0]);
  profiles[mode] = Object.fromEntries(Object.entries(graph).filter(([id]) => used.has(id)));
}
await writeFile(new URL("../electron/comfy-music-graphs.ts", import.meta.url),
  `// Converted from the user's local advanced YuE2 generation and cover workflows.\nexport const MUSIC_GRAPHS = ${JSON.stringify(profiles, null, 2)};\n`, "utf8");
console.log(Object.fromEntries(Object.entries(profiles).map(([mode, graph]) => [mode, Object.keys(graph).length])));
