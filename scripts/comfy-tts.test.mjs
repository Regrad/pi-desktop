import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { fileURLToPath } from "node:url";

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(source))) return next(source.href, context);
  }
  return next(specifier, context);
} });
const { speechGraph, speechParameters, voiceInstruct, uploadSpeechReference, runSpeech } = await import("../resources/pi-comfyui/lib/omnivoice.ts");
const { saveComfySettings } = await import("../resources/pi-comfyui/lib/comfy-client.ts");
const { DEFAULT_COMFY_SETTINGS } = await import("../resources/pi-comfyui/shared/comfy.ts");

test("OmniVoice graphs preserve defaults and require honest reference text or explicit ASR", () => {
  const graph = speechGraph({ text: "Привет", seed: 42, gender: "male", pitch: "low pitch" });
  assert.equal(graph["3"].inputs.language, "russian");
  assert.equal(speechGraph({ text: "x", language: " Russian " })["3"].inputs.language, "russian");
  assert.equal(speechGraph({ text: "x", language: "auto" })["3"].inputs.language, "Auto");
  assert.equal(graph["1"].class_type, "OmniVoiceLoadModel");
  assert.equal(graph["1"].inputs.dtype, "bfloat16");
  assert.equal(graph["1"].inputs.download_missing_files, false);
  assert.equal(graph["3"].inputs.text, "Привет");
  assert.equal(graph["3"].inputs.instruct, "male, low pitch");
  assert.equal(graph["3"].inputs.duration, 0);
  assert.equal(graph["3"].inputs.num_step, 32);
  assert.deepEqual(graph["9"].inputs.audio, ["3", 0]);
  assert.throws(() => speechGraph({ text: "Test" }, { audio: "reference.wav", ref_text: "" }), /расшифровка/);
  assert.throws(() => speechGraph({ text: " " }), /пустым/);
  const clone = speechGraph({ text: "New line" }, { audio: "reference.wav", ref_text: "Hello" });
  assert.deepEqual(clone["6"].inputs.ref_audio, ["4", 0]);
  assert.equal(clone["6"].inputs.ref_text, "Hello");
  assert.equal(clone["5"], undefined);
  const asr = speechGraph({ text: "New line" }, { audio: "reference.wav", ref_text: "", auto_transcribe: true });
  assert.deepEqual(asr["6"].inputs.ref_text, ["5", 0]);
  assert.equal(asr["5"].inputs.device, "cpu");
});

test("all speaker categories and finite vocabulary, preset overrides and conflicts", () => {
  assert.equal(voiceInstruct({ text: "x", preset: "soft whisper male", gender: "female", style: "none", age: "elderly", pitch: "very high pitch" }), "female, elderly, very high pitch");
  assert.equal(voiceInstruct({ text: "x", instruct: "男，青年，低音调，耳语" }), "male, young adult, low pitch, whisper");
  assert.equal(voiceInstruct({ text: "x", english_accent: "russian accent" }), "russian accent");
  assert.equal(voiceInstruct({ text: "x", chinese_dialect: "sichuan dialect" }), "四川话");
  assert.throws(() => voiceInstruct({ text: "x", gender: "male", instruct: "female" }), /конфликт/);
  assert.throws(() => voiceInstruct({ text: "x", instruct: "angry, husky baritone" }), /неподдерживаемый/);
  assert.equal(voiceInstruct({ text: "x" }), "");
});

test("every generation setting reaches the graph including false and zero values", () => {
  const settings = { seed: 0, num_step: 12, guidance_scale: 0, speed: 1.4, duration: 0, t_shift: 0, denoise: false,
    preprocess_prompt: false, postprocess_output: false, layer_penalty_factor: 0, position_temperature: 0,
    class_temperature: 0.4, audio_chunk_duration: 8, audio_chunk_threshold: 20, normalize_text: true, pad_duration: 0, fade_duration: 0 };
  const graph = speechGraph({ text: "x", language: "Welsh", device: "cpu", dtype: "float32", ...settings });
  for (const [key, value] of Object.entries(settings)) {
    assert.ok(speechParameters[key], `Missing schema for ${key}`);
    assert.equal(graph["3"].inputs[key], value, key);
  }
  assert.equal(graph["3"].inputs.language, "welsh");
  assert.equal(graph["1"].inputs.device, "cpu");
  assert.equal(graph["1"].inputs.dtype, "float32");
  assert.equal(speechGraph({ text: "x", duration: 4, speed: 2 })["3"].inputs.duration, 4);
});

test("audio upload, final audio retrieval and Pi media result", async t => {
  const data = await mkdtemp(path.join(os.tmpdir(), "pi-tts-test-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const finalNode = "9";
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/upload/image") {
      let body = ""; for await (const chunk of req) body += chunk;
      assert.match(body, /name="image"/);
      assert.match(body, /pi-tts-/);
      return res.end(JSON.stringify({ name: "reference.wav", subfolder: "tts" }));
    }
    if (req.url === "/object_info") return res.end(JSON.stringify(Object.fromEntries(["OmniVoiceLoadModel", "OmniVoiceGenerate", "OmniVoiceCreateVoiceClonePrompt", "SaveAudio", "LoadAudio"].map(name => [name, {}]))));
    if (req.url === "/prompt") {
      let body = ""; for await (const chunk of req) body += chunk;
      assert.equal(JSON.parse(body).prompt["9"].class_type, "SaveAudio");
      return res.end(JSON.stringify({ prompt_id: "tts-test" }));
    }
    if (req.url === "/history/tts-test") return res.end(JSON.stringify({ "tts-test": { status: { status_str: "success" }, outputs: { [finalNode]: { audio: [{ filename: "speech.flac", type: "output" }] } } } }));
    if (req.url.startsWith("/view?")) return res.end("test-audio");
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await saveComfySettings(data, { ...DEFAULT_COMFY_SETTINGS, enabled: true, url: `http://127.0.0.1:${server.address().port}` });
  const sample = path.join(data, "sample.wav");
  await writeFile(sample, "test-audio");
  assert.equal(await uploadSpeechReference(data, sample), "tts/reference.wav");
  await assert.rejects(uploadSpeechReference(data, "relative.wav"), /абсолютный/);
  for (const voice of [undefined, { audio: "tts/reference.wav", ref_text: "Hello" }]) {
    const result = await runSpeech(data, speechGraph({ text: "Привет" }, voice));
    assert.equal(result.details.media[0].type, "audio");
    assert.equal(result.details.media[0].mimeType, "audio/flac");
    assert.equal(await readFile(result.details.media[0].path, "utf8"), "test-audio");
  }
});
