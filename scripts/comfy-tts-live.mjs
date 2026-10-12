import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stat, readFile } from "node:fs/promises";
import { discoverAndLoadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const data = path.join(appRoot, "release/Pi Desktop/data");
process.env.PI_DESKTOP_DATA_DIR = data;
process.env.PI_DESKTOP_APP_ROOT = appRoot;
const loaded = await discoverAndLoadExtensions([], data, path.join(data, "agent"));
assert.deepEqual(loaded.errors, []);
const tools = loaded.extensions.find(extension => extension.tools.has("comfyui_design_voice"))?.tools;
assert.ok(tools?.has("comfyui_clone_voice"));
console.log("Working Pi addon loaded; both OmniVoice TTS tools registered.");
if (process.argv.includes("--generate")) {
  const settings = JSON.parse(await readFile(path.join(data, "comfyui.json"), "utf8"));
  const nodes = await (await fetch(`${settings.url}/object_info`)).json();
  const properties = tools.get("comfyui_design_voice").definition.parameters.properties;
  for (const key of Object.keys({ ...nodes.OmniVoiceGenerate.input.required, ...nodes.OmniVoiceGenerate.input.optional })) {
    if (["model", "ref_audio", "voice_clone_prompt", "ref_text"].includes(key)) continue;
    assert.ok(properties[key], `Missing Pi generation control: ${key}`);
  }
  console.log("All installed OmniVoice generation controls exposed to Pi.");
  const signal = AbortSignal.timeout(15 * 60_000);
  const text = "Привет, путник. Добро пожаловать.";
  const design = await tools.get("comfyui_design_voice").definition.execute("tts-design-check", {
    text, gender: "male", age: "middle-aged", pitch: "low pitch", seed: 42,
    normalize_text: true, pad_duration: 0, fade_duration: 0, speed: 1.15,
  }, signal);
  const audio = design.details.media[0].path;
  assert.ok((await stat(audio)).size > 1000);
  console.log(JSON.stringify({ design: design.details }));
  const clone = await tools.get("comfyui_clone_voice").definition.execute("tts-clone-check", {
    text: "Присядь у огня и отдохни.", audio, ref_text: text, seed: 42,
  }, signal);
  assert.ok((await stat(clone.details.media[0].path)).size > 1000);
  console.log(JSON.stringify({ clone: clone.details }));
}
