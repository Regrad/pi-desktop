const { spawnSync } = require("node:child_process");
const path = require("node:path");
const executable = path.resolve(process.argv[2] || "release/Pi Desktop/app/Pi Desktop.exe");
const code = String.raw`
const fs = require("node:fs/promises"), { existsSync } = require("node:fs"), path = require("node:path"), os = require("node:os"), { pathToFileURL } = require("node:url");
(async () => {
  const resources = path.join(path.dirname(process.execPath), "resources");
  const root = existsSync(path.join(resources, "app")) ? path.join(resources, "app") : path.join(resources, "app.asar");
  const data = process.env.PI_TEST_COMFY_DATA || await fs.mkdtemp(path.join(os.tmpdir(), "pi-packaged-comfy-test-"));
  try {
    process.env.PI_DESKTOP_APP_ROOT = root;
    process.env.PI_DESKTOP_DATA_DIR = data;
    const { ensureComfyAddon } = await import(pathToFileURL(path.join(root, "dist-electron/electron/comfy-addon.js")));
    await ensureComfyAddon(data, root);
    const { discoverAndLoadExtensions } = await import(pathToFileURL(path.join(root, "node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js")));
    const result = await discoverAndLoadExtensions([], data, path.join(data, "agent"));
    if (result.errors.length) throw new Error(JSON.stringify(result.errors));
    const tools = result.extensions[0].tools;
    if (tools.size !== 26) throw new Error("Wrong tool count: " + tools.size);
    for (const name of ["comfyui_workflows", "comfyui_run_workflow", "comfyui_job"]) if (tools.has(name)) throw new Error("Retired tool loaded: " + name);
    if (!tools.has("comfyui_generate_idol_3d") || !tools.has("comfyui_texture_3d")) throw new Error("3D tools missing");
    if (!tools.get("comfyui_texture_3d").definition.description.includes("UltraTex")) throw new Error("Stale texture tool");
    if (!tools.get("comfyui_generate_instrumental_music").definition.promptGuidelines.some(text => text.includes("not proven causes or fixes"))) throw new Error("Updated guidelines missing");
    console.log("PACKAGED ADDON OK: 26 specialized tools, no universal runner, bundled dependencies");
  } finally { if (!process.env.PI_TEST_COMFY_DATA) await fs.rm(data, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
`;
const result = spawnSync(executable, ["-e", code], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true,
  encoding: "utf8", timeout: 60000,
});
process.stdout.write(result.stdout || "");
process.stderr.write(result.stderr || "");
if (result.error) console.error(result.error);
process.exitCode = result.status ?? 1;
