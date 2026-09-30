// One-time mechanical conversion of the user's existing local GUI workflows.
// Produces bundled API graphs; no ComfyUI execution or model download.
import { readFile, writeFile } from "node:fs/promises";
const root = process.argv[2];
if (!root) throw new Error("Usage: node scripts/import-3d-workflows.mjs <ComfyUI workflows folder>");
const info = await (await fetch("http://127.0.0.1:8188/object_info")).json();
const profiles = {};
for (const [mode, name] of [["model3d", "3d_pixal3d_trellis2_image_to_model.json"], ["model3d_multiview", "3d_pixal3d_multi_views.json"]]) {
  const gui = JSON.parse(await readFile(`${root}/${name}`, "utf8"));
  const graph = {};
  for (const node of gui.nodes) {
    if (!info[node.type]) continue;
    if (node.mode !== 0) throw new Error(`Unsupported mode: ${node.id}`);
    const inputs = {};
    let widgetIndex = 0;
    for (const p of node.inputs ?? []) {
      let value;
      if (p.widget) {
        value = node.widgets_values?.[widgetIndex++];
        if (["seed", "value"].includes(p.name) && ["fixed", "increment", "decrement", "randomize"].includes(node.widgets_values?.[widgetIndex])) widgetIndex++;
        const type = info[node.type].input.required?.[p.name]?.[0] ?? info[node.type].input.optional?.[p.name]?.[0];
        if (["INT", "FLOAT"].includes(type) && typeof value === "string" && value.trim() && Number.isFinite(Number(value))) value = Number(value);
      }
      if (p.link != null) {
        const link = gui.links.find(l => l[0] === p.link);
        inputs[p.name] = [String(link[1]), link[2]];
      } else if (p.widget && p.name !== "upload") inputs[p.name] = value;
    }
    if (node.type === "KSampler") inputs.seed = "{{seed}}";
    if (node.type === "LoadImage") inputs.image = "{{image_1}}";
    if (node.type === "Save3DAdvanced") { inputs.filename_prefix = "3d/PiDesktop"; inputs.viewport_state = {}; }
    graph[String(node.id)] = { class_type: node.type, inputs };
  }
  // Preview nodes in these GUI graphs pass their image onward. Bypass UI-only work.
  for (const node of Object.values(graph)) for (const [key, value] of Object.entries(node.inputs)) {
    let link = value;
    while (Array.isArray(link) && ["PreviewImage", "MaskPreview"].includes(graph[link[0]]?.class_type)) {
      link = graph[link[0]].inputs.images ?? graph[link[0]].inputs.mask;
    }
    node.inputs[key] = link;
  }
  if (mode === "model3d_multiview") {
    // Replace fixed crops from the original example sheet with separate views.
    [338, 341, 342, 345].forEach((id, i) => { graph[id] = { class_type: "LoadImage", inputs: { image: `{{image_${i + 1}}}` } }; });
    for (const node of Object.values(graph)) for (const [key, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && graph[value[0]]?.class_type === "SaveImageAdvanced") node.inputs[key] = graph[value[0]].inputs.images;
    }
  }
  // Keep only the saved model and its dependencies; no previews or intermediate saves.
  const used = new Set();
  function visit(id) {
    if (used.has(id)) return;
    const node = graph[id];
    if (!node) throw new Error(`Missing dependency: ${id}`);
    used.add(id);
    for (const value of Object.values(node.inputs)) if (Array.isArray(value) && typeof value[0] === "string" && Number.isInteger(value[1])) visit(value[0]);
  }
  for (const [id, n] of Object.entries(graph)) if (n.class_type === "Save3DAdvanced") visit(id);
  profiles[mode] = Object.fromEntries(Object.entries(graph).filter(([id]) => used.has(id)));
}
await writeFile(new URL("../electron/comfy-3d-graphs.ts", import.meta.url), `// Converted from the user's local Pixal3D/Trellis2 workflows. Preserve their sampling and mesh settings.\nexport const MODEL_GRAPHS = ${JSON.stringify(profiles, null, 2)};\n`, "utf8");
console.log(Object.fromEntries(Object.entries(profiles).map(([k, v]) => [k, Object.keys(v).length])));
