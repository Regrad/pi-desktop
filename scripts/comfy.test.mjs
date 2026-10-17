import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import http from "node:http";

// Test TypeScript sources directly with Node's built-in type stripping, without a build.
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(source))) return next(source.href, context);
  }
  return next(specifier, context);
} });
const { localComfyUrl, DEFAULT_COMFY_SETTINGS } = await import("../shared/comfy.ts");
const { collectComfyImages, collectComfyMedia, collectAnswerMedia, answerCanPublishMedia } = await import("../src/comfy-images.ts");
const { generatedFile, generatedMediaResponse } = await import("../electron/generated-media.ts");
const { mergeAttachments } = await import("../src/drop-attachments.ts");
const { imageAttachmentPrompt, visibleImageAttachmentText, listHistoryImages, resolveHistoryImage } = await import("../shared/image-attachments.ts");
const { loadComfySettings, saveComfySettings, checkComfyConnection, listComfyMusicAdapters, runComfy, runInstrumentalComfy, editComfyMusicVocals, builtinGraph, fillWorkflow, validateGraph } = await import("../electron/comfy-client.ts");
const { imagePathForTool } = await import("../electron/image-input.ts");

test("only loopback and private LAN addresses are accepted", () => {
  for (const url of ["http://127.0.0.1:8188", "http://192.168.3.194:8188", "http://10.2.3.4", "http://172.16.0.2", "http://[::1]:8188"]) assert.equal(localComfyUrl(url), url);
  for (const url of ["https://example.com", "http://8.8.8.8", "http://172.32.0.1", "http://user:pass@localhost", "file:///tmp/image", "http://localhost?x=1"]) assert.throws(() => localComfyUrl(url));
});
test("ComfyUI adapter list exposes available local YuE2 adapters", async (t) => {
  const server = http.createServer((_req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ YuE2NativeUniversalAdapterLoader: { input: { required: { adapter: [["none", "voice-lora.safetensors"]] } } } })); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.deepEqual(await listComfyMusicAdapters(`http://127.0.0.1:${server.address().port}`), ["none", "voice-lora.safetensors"]);
});
test("API placeholders retain numeric types and GUI JSON is rejected", () => {
  const graph = { "1": { class_type: "LoadImage", inputs: { image: "{{image_1}}", width: "{{width}}", seed: "{{seed}}", prompt: "Draw {{prompt}}" } } };
  const filled = fillWorkflow(graph, { prompt: "box", width: 512, seed: 0 }, ["input.png"], 25);
  assert.deepEqual(filled["1"].inputs, { image: "input.png", width: 512, seed: 0, prompt: "Draw box" });
  assert.throws(() => validateGraph({ nodes: [] }), /API/);
  assert.throws(() => fillWorkflow(graph, {}, [], 25), /image_1/);
  assert.equal(graph["1"].inputs.width, "{{width}}");
});
test("builtin edit binds references and cutout converts foreground mask to alpha", () => {
  const edit = builtinGraph(DEFAULT_COMFY_SETTINGS, "edit", { prompt: "Change pose" }, ["target.png", "pose.png"]);
  assert.deepEqual(edit.text.inputs["images.image_2"], ["rgba_1", 0]);
  assert.deepEqual(edit.rgba_1.inputs.alpha, ["image_1", 1]);
  assert.deepEqual(edit.sample.inputs.latent_image, ["text", 2]);
  assert.equal(edit.text.inputs.resolution, 0);
  const cutout = builtinGraph(DEFAULT_COMFY_SETTINGS, "remove_background", {}, ["target.png"]);
  assert.equal(cutout.invert.class_type, "InvertMask");
  assert.deepEqual(cutout.rgba.inputs.alpha, ["invert", 0]);
});
test("generated images survive persisted history and are not duplicated by tool calls", () => {
  const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
  const result = { content: [{ type: "text", text: "Saved file" }, image] };
  const tool = { id: "call-1", name: "comfyui_generate_image", result };
  assert.deepEqual(collectComfyImages([tool]), [image]);
  assert.deepEqual(collectComfyImages([{ ...tool, result: undefined }, tool]), [image]);
  assert.deepEqual(collectComfyImages([tool, { ...tool, result: structuredClone(result) }]), [image]);
  assert.deepEqual(collectComfyImages([{ ...tool, id: "edit-1", name: "comfyui_edit_image" }, { ...tool, id: "bg-1", name: "comfyui_remove_background" }]), [image, image]);
  assert.deepEqual(collectComfyImages([{ ...tool, name: "computer-use_screenshot" }]), []);
  assert.deepEqual(collectComfyImages([{ ...tool, result: { ...result, isError: true } }]), []);
  assert.deepEqual(collectComfyImages([{ ...tool, result: { content: [null, { type: "image" }] } }]), []);
});
test("media stays in tools until the final answer completes, preserving older answers", () => {
  const image = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
  const tool = { id: "image-1", name: "comfyui_generate_image", result: { content: [image], details: { files: ["C:/image.png"] } } };
  for (const state of [
    { streaming: true, working: true, currentTurn: true },
    { streaming: false, working: true, currentTurn: true },
    { streaming: true, working: false, currentTurn: true },
    { streaming: false, working: false, currentTurn: true, stopReason: "aborted" },
    { streaming: false, working: false, currentTurn: true, stopReason: "error" },
    { streaming: false, working: false, currentTurn: true, stopReason: "toolUse" },
  ]) {
    const media = collectAnswerMedia([tool], answerCanPublishMedia(state));
    assert.deepEqual(media.parts, []); assert.equal(media.toolIds.size, 0);
  }
  for (const state of [
    { streaming: false, working: false, currentTurn: true, stopReason: "stop" },
    { streaming: false, working: true, currentTurn: false, stopReason: "stop" },
    { streaming: false, working: false, currentTurn: true },
  ]) {
    const media = collectAnswerMedia([tool, tool], answerCanPublishMedia(state));
    assert.equal(media.parts.length, 1); assert.deepEqual([...media.toolIds], [tool.id]);
  }
  const terminalRead = { ...tool, name: "read", args: { path: "C:/image.png" } };
  assert.equal(collectAnswerMedia([terminalRead], false).parts.length, 0);
  assert.equal(collectAnswerMedia([terminalRead], true).parts.length, 0);
  assert.equal(collectAnswerMedia([terminalRead], true, "Here is C:/image.png").parts.length, 1);
});

test("final answer publishes only the named result, leaving earlier images inside tools", () => {
  const make = (id, name, filename, displayInAnswer) => ({
    id, name, result: { content: [{ type: "image", data: id, mimeType: "image/png" }], details: { files: [`C:\\AI\\image-generation\\${filename}`], ...(displayInAnswer === undefined ? {} : { displayInAnswer }) } },
  });
  const preview = make("preview", "desktop_show_image", "mask-preview.png", true);
  const first = make("first", "comfyui_inpaint_image", "result-1.png");
  const last = make("last", "comfyui_inpaint_image", "result-2.png");
  const selected = collectAnswerMedia([preview, first, last], true, "Готово. Файл: C:\\AI\\image-generation\\result-2.png");
  assert.deepEqual(selected.parts.map(part => part.path), ["C:\\AI\\image-generation\\result-2.png"]);
  assert.deepEqual([...selected.toolIds], ["last"]);
  assert.deepEqual(collectAnswerMedia([preview, first, last], true).parts.map(part => part.path), ["C:\\AI\\image-generation\\result-2.png"]);
  assert.deepEqual(collectAnswerMedia([preview, first, last], true, "Файл: result-1.png").parts.map(part => part.path), ["C:\\AI\\image-generation\\result-1.png"]);
  assert.deepEqual(collectAnswerMedia([preview], true).parts.map(part => part.path), ["C:\\AI\\image-generation\\mask-preview.png"]);
  assert.deepEqual(collectAnswerMedia([preview, first, last], false, "Файл: result-2.png").parts, []);
  assert.deepEqual(collectAnswerMedia([preview, first, last], true, "Файлы: result-1.png и result-2.png").parts.map(part => part.path),
    ["C:\\AI\\image-generation\\result-1.png", "C:\\AI\\image-generation\\result-2.png"]);
});

test("latest image job keeps all its variants; explicit selection keeps unchosen variants in tool", () => {
  const make = (id, files) => ({ id, name: "comfyui_generate_image", result: {
    content: files.map((file, i) => ({ type: "image", data: `${id}-${i}`, mimeType: "image/png" })), details: { files },
  } });
  const old = make("old", ["C:/old.png"]);
  const latest = make("latest", ["C:/one.png", "C:/two.png"]);
  assert.deepEqual(collectAnswerMedia([old, latest], true).parts.map(part => part.path), ["C:/one.png", "C:/two.png"]);
  const chosen = collectAnswerMedia([old, latest], true, "Выбираю C:/one.png");
  assert.deepEqual(chosen.parts.map(part => part.path), ["C:/one.png"]);
  assert.equal(chosen.toolIds.has("latest"), false);
});

test("an ambiguous filename does not publish every same-named image", () => {
  const make = (id, path) => ({ id, name: "comfyui_edit_image", result: {
    content: [{ type: "image", data: id, mimeType: "image/png" }], details: { files: [path] },
  } });
  const earlier = make("earlier", "C:/first/image.png");
  const latest = make("latest", "C:/second/image.png");
  assert.deepEqual(collectAnswerMedia([earlier, latest], true, "image.png").parts.map(part => part.path), ["C:/second/image.png"]);
  assert.deepEqual(collectAnswerMedia([earlier, latest], true, "C:/first/image.png").parts.map(part => part.path), ["C:/first/image.png"]);
});

test("image, music and 3D each retain one final job without losing mixed results", () => {
  const image = { id: "image", name: "comfyui_generate_image", result: { content: [{ type: "image", data: "a", mimeType: "image/png" }], details: { files: ["C:/image.png"] } } };
  const audio = { id: "audio", name: "comfyui_generate_music", result: { content: [{ type: "text", text: "done" }], details: { media: [{ type: "audio", path: "C:/song.flac", mimeType: "audio/flac" }] } } };
  const model = { id: "model", name: "comfyui_generate_3d", result: { content: [{ type: "text", text: "done" }], details: { media: [{ type: "model3d", path: "C:/mesh.glb", mimeType: "model/gltf-binary" }] } } };
  const selected = collectAnswerMedia([image, audio, model], true, "Готово: C:/image.png");
  assert.deepEqual(selected.parts.map(part => part.path), ["C:/image.png", "C:/song.flac", "C:/mesh.glb"]);
  assert.deepEqual([...selected.toolIds], ["image", "audio", "model"]);
});

test("explicitly hidden masks and failed media never publish", () => {
  const mask = { id: "mask", name: "comfyui_create_mask", result: { content: [{ type: "image", data: "a", mimeType: "image/png" }], details: { files: ["C:/mask.png"], displayInAnswer: false } } };
  const failed = { id: "failed", name: "comfyui_generate_image", result: { isError: true, content: [{ type: "image", data: "b", mimeType: "image/png" }], details: { files: ["C:/failed.png"] } } };
  assert.deepEqual(collectAnswerMedia([mask, failed], true, "C:/mask.png C:/failed.png").parts, []);
});

test("real edited chat selects the final image over mask preview and earlier inpaints", { skip: !process.env.PI_TEST_MEDIA_HISTORY }, async () => {
  const data = path.resolve("release/Pi Desktop/data");
  const state = JSON.parse(await readFile(path.join(data, "desktop-state.json"), "utf8"));
  const chat = state.conversations.find(item => item.id === "df116627-a6e9-4fc1-b23a-7b7cedf8b09f");
  const entries = (await readFile(path.join(data, chat.sessionFile), "utf8")).trim().split("\n").map(JSON.parse);
  const messages = entries.filter(entry => entry.timestamp >= "2026-09-29T12:54:21" && entry.timestamp < "2026-09-29T12:59:27" && entry.message).map(entry => entry.message);
  const calls = new Map();
  let answer = "";
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.content || []) {
        if (part.type === "toolCall") calls.set(part.id, { id: part.id, name: part.name, args: part.arguments });
        if (part.type === "text") answer += part.text;
      }
    }
    if (message.role === "toolResult" && calls.has(message.toolCallId)) calls.get(message.toolCallId).result = message;
  }
  const selected = collectAnswerMedia([...calls.values()], true, answer);
  assert.equal(selected.parts.length, 1);
  assert.match(String(selected.parts[0].path), /PiDesktop_00016_\.png$/);
  assert.equal(selected.toolIds.size, 1);
});

test("attachment metadata exposes originals without showing service text in chat", () => {
  const metadata = imageAttachmentPrompt([
    { id: "1", name: "original.png", path: "C:\\Photos\\original.png", data: "aA==", mimeType: "image/png" },
    { id: "2", name: "pasted.png", path: "clipboard:pasted.png", data: "aA==", mimeType: "image/png" },
  ]);
  const text = "Edit the image" + metadata;
  assert.equal(visibleImageAttachmentText(text), "Edit the image");
  assert.match(metadata, /Photos/);
  assert.match(metadata, /desktop_get_image_path/);
  assert.ok(!metadata.includes("clipboard:pasted.png"));
  const entries = [{ id: "entry123", type: "message", message: { role: "user", content: [
    { type: "text", text }, { type: "image", data: "aA==", mimeType: "image/png" }, { type: "image", data: "bA==", mimeType: "image/png" },
  ] } }];
  const listed = listHistoryImages(entries);
  assert.equal(listed[0].path, "C:\\Photos\\original.png");
  assert.equal(listed[1].path, undefined);
  assert.equal(listed[1].name, "pasted.png");
  assert.equal(resolveHistoryImage(entries, listed[1].reference).data, "bA==");
  assert.throws(() => resolveHistoryImage(entries, "attachment:another-chat:1"), /истории/);
  assert.throws(() => resolveHistoryImage(entries, "attachment:entry123:0"), /истории/);
  const legacy = [{ id: "old", type: "message", message: { role: "user", content: [{ type: "image", data: "aA==", mimeType: "image/png" }] } }];
  assert.equal(resolveHistoryImage(legacy, listHistoryImages(legacy)[0].reference).data, "aA==");
  assert.equal(visibleImageAttachmentText("My own text [Pi Desktop image attachments]"), "My own text [Pi Desktop image attachments]");
});
test("pasted image is materialized only on demand in portable chat-attachments and reused", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-chat-attachment-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF3sAAAAASUVORK5CYII=", "base64");
  const resolve = (reference) => {
    assert.equal(reference, "attachment:entry123:1");
    return { data: png.toString("base64"), mimeType: "image/png" };
  };
  assert.equal(existsSync(path.join(dir, "chat-attachments")), false);
  const first = await imagePathForTool(dir, "attachment:entry123:1", resolve);
  assert.equal(path.dirname(first.path), path.join(dir, "chat-attachments"));
  assert.equal(first.width, 1);
  assert.equal(first.height, 1);
  assert.deepEqual(await readFile(first.path), png);
  const second = await imagePathForTool(dir, "attachment:entry123:1", resolve);
  assert.equal(second.path, first.path);
  assert.equal((await readdir(path.join(dir, "chat-attachments"))).length, 1);
  const existing = await imagePathForTool(dir, first.path);
  assert.equal(existing.path, first.path);
  assert.equal((await readdir(path.join(dir, "chat-attachments"))).length, 1);
  await assert.rejects(imagePathForTool(dir, "attachment:other-chat:1", resolve), /strictly equal/);
});
test("path tool resolves the selected chat image without publishing it", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-chat-image-path-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF3sAAAAASUVORK5CYII=", "base64");
  const entries = [{ id: "entry123", type: "message", message: { role: "user", content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] } }];
  const original = process.env.PI_DESKTOP_DATA_DIR;
  try {
    process.env.PI_DESKTOP_DATA_DIR = dir;
    const registered = [];
    await (await import("../electron/comfy-extension.ts")).default({ registerTool: tool => registered.push(tool) });
    const tool = registered.find(item => item.name === "desktop_get_image_path");
    const result = await tool.execute("test", { image: "attachment:entry123:1" }, undefined, undefined, { sessionManager: { getBranch: () => entries } });
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    assert.equal(result.details.displayInAnswer, false);
    assert.deepEqual(await readFile(result.details.files[0]), png);
    assert.match(result.details.files[0], /chat-attachments/);
  } finally {
    if (original === undefined) delete process.env.PI_DESKTOP_DATA_DIR;
    else process.env.PI_DESKTOP_DATA_DIR = original;
  }
});
test("dropped attachments keep original paths and avoid duplicate files", () => {
  const original = { id: "1", name: "photo.png", path: "C:\\Photos\\photo.png", data: "aA==", mimeType: "image/png" };
  const another = { ...original, id: "2", name: "another.png", path: "C:\\Photos\\another.png" };
  const current = [original];
  assert.deepEqual(mergeAttachments(current, [{ ...original, id: "3", path: "c:\\photos\\PHOTO.png" }, another, another]), [original, another]);
  assert.deepEqual(current, [original]);
  const pasted = { ...original, path: "clipboard:image.png" };
  assert.equal(mergeAttachments([], [pasted, { ...pasted, id: "4", data: "bA==" }]).length, 2);
});
test("extension exposes advanced YuE2 generation and cover through Pi's public registration API", async () => {
  const { default: extension } = await import("../electron/comfy-extension.ts");
  const original = process.env.PI_DESKTOP_DATA_DIR;
  try {
    process.env.PI_DESKTOP_DATA_DIR = os.tmpdir();
    const registered = [];
    await extension({ registerTool: (tool) => registered.push(tool) });
    assert.deepEqual(registered.map(tool => tool.name).sort(), ["desktop_show_image", "comfyui_list_attachments", "desktop_get_image_path", "comfyui_status", "comfyui_generate_instrumental_music", "comfyui_generate_music", "comfyui_cover_music", "comfyui_plan_music", "comfyui_edit_vocals", "comfyui_generate_3d", "comfyui_create_mask", "comfyui_generate_image", "comfyui_edit_image", "comfyui_compose_image", "comfyui_inpaint_image", "comfyui_outpaint_image", "comfyui_extract_subject", "comfyui_remove_background", "comfyui_asset_3d", "comfyui_clone_voice", "comfyui_design_voice", "comfyui_lod_3d", "comfyui_process_3d", "comfyui_publish_music", "comfyui_texture_3d"].sort());
    for (const tool of registered) {
      assert.equal(typeof tool.execute, "function");
      assert.equal(tool.parameters.type, "object");
    }
    const model3d = registered.find(tool => tool.name === "comfyui_generate_3d");
    assert.ok(model3d.promptGuidelines.some(text => text.includes("Before the first generation")));
    assert.ok(model3d.promptGuidelines.some(text => text.includes("component_mode=largest")));
    assert.ok(model3d.promptGuidelines.some(text => text.includes("additional rendered views") && text.includes("validation need")));
    assert.match(model3d.parameters.properties.model3d_options.properties.watertight.description, /Default true/);
    assert.match(model3d.parameters.properties.model3d_options.properties.component_mode.description, /largest/);
    const music = registered.find(tool => tool.name === "comfyui_generate_music");
    for (const label of ["[Verse]", "[Chorus]", "[Bridge]", "[Outro]"]) {
      assert.ok(music.description.includes(label));
      assert.ok(music.parameters.properties.lyrics.description.includes(label));
    }
    assert.ok(music.promptGuidelines.some(text => text.includes("Use and preserve English labels")));
    assert.ok(music.description.includes("automatic ABC budget"));
    assert.ok(music.promptGuidelines.some(text => text.includes("ABC duration budget")));
    assert.ok(music.parameters.properties.duration.description.includes("workflow calculates"));
    const cover = registered.find(tool => tool.name === "comfyui_cover_music");
    assert.ok(!cover.parameters.required.includes("lyrics"));
    assert.ok(cover.parameters.properties.vocal_mode);
    assert.ok(music.parameters.properties.vocal_mode);
    assert.ok(cover.parameters.properties.audio);
    assert.ok(cover.parameters.properties.music_options.properties.target_voice);
    assert.ok(registered.find(tool => tool.name === "comfyui_plan_music").parameters.properties.abc_file);
    assert.ok(registered.find(tool => tool.name === "comfyui_edit_vocals").parameters.properties.mode);
    const instrumental = registered.find(tool => tool.name === "comfyui_generate_instrumental_music");
    assert.ok(instrumental.parameters.required.includes("mode"));
    assert.ok(instrumental.description.includes("[Instrumental]"));
    assert.ok(instrumental.description.includes("accompaniment_only"));
    for (const name of ["comfyui_generate_instrumental_music", "comfyui_generate_music", "comfyui_cover_music", "comfyui_plan_music", "comfyui_edit_vocals"]) {
      const tool = registered.find(tool => tool.name === name);
      assert.ok(tool.promptGuidelines.some(text => text.includes("saved abc_file") && text.includes("mode=instrumental_lead")), name);
      assert.ok(tool.promptGuidelines.some(text => text.includes("score, not the generated sound")), name);
      assert.ok(tool.promptGuidelines.some(text => text.includes("not proven causes or fixes")), name);
      assert.ok(tool.promptGuidelines.some(text => text.includes("render a valid plan")), name);
    }
    const editVocals = registered.find(tool => tool.name === "comfyui_edit_vocals");
    assert.ok(editVocals.description.includes("comfyui_generate_instrumental_music with the same mode"));
    assert.ok(registered.find(tool => tool.name === "desktop_get_image_path").description.includes("chat-attachments"));
  } finally {
    if (original === undefined) delete process.env.PI_DESKTOP_DATA_DIR;
    else process.env.PI_DESKTOP_DATA_DIR = original;
  }
});

test("YuE2 keeps the workflow duration budget unless a maximum is explicitly supplied", () => {
  const standard = builtinGraph(DEFAULT_COMFY_SETTINGS, "music", { prompt: "rock song" }, []);
  const get = (graph, type) => Object.values(graph).find(node => node.class_type === type).inputs;
  assert.deepEqual(get(standard, "YuE2NativeGenerateMusic").max_duration, ["1054", 1]);
  assert.equal(get(standard, "YuE2StyleBuilder").extra, "rock song");
  assert.equal(get(standard, "YuE2NativePipelineLoader").checkpoint, DEFAULT_COMFY_SETTINGS.musicCheckpoint);
  const explicit = builtinGraph(DEFAULT_COMFY_SETTINGS, "music", { prompt: "rock song", duration: 120 }, []);
  assert.equal(get(explicit, "YuE2NativeGenerateMusic").max_duration, 120);
  const cover = builtinGraph(DEFAULT_COMFY_SETTINGS, "music_cover", { prompt: "jazz", audio: "source.flac", music_options: { target_voice: "male_tenor", tempo_mode: "override", bpm: 100 } }, []);
  assert.equal(get(cover, "LoadAudio").audio, "source.flac");
  assert.equal(get(cover, "YuE2VocalRangeRetarget").target_voice, "male_tenor");
  assert.equal(get(cover, "YuE2ABCModifier").bpm, 100);
  assert.deepEqual(get(cover, "YuE2NativeGenerateMusic").max_duration, ["1060", 1]);
  const harmony = builtinGraph(DEFAULT_COMFY_SETTINGS, "music_cover", { prompt: "jazz", audio: "source.flac", keep_harmony: true }, []);
  assert.equal(get(harmony, "YuE2NativeAudioToABC").mode, "full");
  assert.equal(get(harmony, "YuE2NativeGenerateMusic").mode, "full");
  const newHarmony = builtinGraph(DEFAULT_COMFY_SETTINGS, "music_cover", { prompt: "jazz", audio: "source.flac", keep_harmony: false }, []);
  assert.equal(get(newHarmony, "YuE2NativeAudioToABC").mode, "melody");
  assert.equal(get(newHarmony, "YuE2ABCModifier").remove_chords, true);
  assert.equal(get(newHarmony, "YuE2NativeGenerateMusic").mode, "melody");
  assert.deepEqual(newHarmony.pi_generation_limit.inputs.source, ["1025", 4]);
  const custom = { music: { class_type: "YuE2GenerateMusic", inputs: { max_duration: "{{duration}}" } } };
  assert.equal(fillWorkflow(custom, {}, [], 32).music.inputs.max_duration, 360);
  assert.equal(fillWorkflow(custom, { duration: 180 }, [], 32).music.inputs.max_duration, 180);
  // Explicitly configured custom workflows keep their own limit when no placeholder is used.
  const fixed = { music: { class_type: "YuE2GenerateMusic", inputs: { max_duration: 600 } } };
  assert.equal(fillWorkflow(fixed, {}, [], 32).music.inputs.max_duration, 600);
});

test("YuE2 audio survives history without adding audio base64 to the model", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-music-test-"));
  const bytes = Buffer.from("fLaC-test-audio");
  let graph;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/object_info") return res.end(JSON.stringify(Object.fromEntries(Object.values(builtinGraph(DEFAULT_COMFY_SETTINGS, "music", { prompt: "piano", lyrics: "[Instrumental]" }, [])).map(node => [node.class_type, {}]))));
    if (req.url === "/prompt") { graph = JSON.parse(Buffer.concat(chunks)).prompt; return res.end('{"prompt_id":"music-test"}'); }
    if (req.url === "/history/music-test") return res.end(JSON.stringify({ "music-test": { outputs: { save: { audio: [{ filename: "track.flac", subfolder: "audio", type: "output" }] } } } }));
    if (req.url.startsWith("/view?")) { assert.match(req.url, /subfolder=audio/); res.setHeader("Content-Type", "application/octet-stream"); return res.end(bytes); }
    res.writeHead(404); res.end("{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const legacy = { ...structuredClone(DEFAULT_COMFY_SETTINGS), enabled: true, url: `http://127.0.0.1:${server.address().port}` };
  delete legacy.musicCheckpoint; delete legacy.musicSteps; delete legacy.workflows.music;
  await writeFile(path.join(dir, "comfyui.json"), JSON.stringify(legacy));
  assert.equal((await loadComfySettings(dir)).musicCheckpoint, DEFAULT_COMFY_SETTINGS.musicCheckpoint);
  const result = await runComfy(dir, "music", { prompt: "piano", lyrics: "[Instrumental]", duration: 10, seed: 0 });
  const get = (type) => Object.values(graph).find(node => node.class_type === type).inputs;
  assert.equal(get("YuE2NativePipelineLoader").checkpoint, "yue2_3b_bf16.safetensors");
  assert.deepEqual(get("EmptyYuE2LatentAudio").seconds, ["1025", 3]);
  assert.equal(get("YuE2NativeGenerateMusic").max_duration, 10);
  assert.equal(get("PrimitiveInt").value, 0);
  assert.equal(get("KSampler").steps, 32);
  assert.deepEqual(result.images, []);
  assert.deepEqual(await readFile(result.audio[0].path), bytes);
  assert.equal("data" in result.audio[0], false);
  const media = { type: "audio", ...result.audio[0] };
  const tool = { id: "music-1", name: "comfyui_generate_music", result: { content: [{ type: "text", text: "Saved" }], details: { media: [media] } } };
  assert.deepEqual(collectComfyMedia([tool, structuredClone(tool)]), [media]);
  const image = { type: "image", data: "abc", mimeType: "image/png" };
  assert.equal(collectComfyMedia([{ id: "image", name: "comfyui_generate_image", result: { content: [image], details: { files: ["C:/data/image-generation/a.png"] } } }])[0].path, "C:/data/image-generation/a.png");
  await assert.rejects(runComfy(dir, "music", { prompt: "test", lyrics: "[Instrumental]", duration: 901 }), /Длительность/);
});

test("YuE2 cover uploads only the selected local audio and binds it to LoadAudio", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-cover-test-"));
  const source = path.join(dir, "source.flac");
  await writeFile(source, Buffer.from("fLaC-source"));
  let graph, uploads = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/upload/image") { uploads++; return res.end('{"name":"uploaded.flac"}'); }
    if (req.url === "/object_info") return res.end(JSON.stringify(Object.fromEntries(Object.values(builtinGraph(DEFAULT_COMFY_SETTINGS, "music_cover", { prompt: "jazz", lyrics: "[Instrumental]", audio: "uploaded.flac" }, [])).map(node => [node.class_type, {}]))));
    if (req.url === "/prompt") { graph = JSON.parse(Buffer.concat(chunks)).prompt; return res.end('{"prompt_id":"cover-test"}'); }
    if (req.url === "/history/cover-test") return res.end(JSON.stringify({ "cover-test": { outputs: { "10": { audio: [{ filename: "cover.flac", type: "output" }] } } } }));
    if (req.url.startsWith("/view?")) return res.end(Buffer.from("fLaC-cover"));
    res.writeHead(404); res.end("{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await writeFile(path.join(dir, "comfyui.json"), JSON.stringify({ ...DEFAULT_COMFY_SETTINGS, enabled: true, url: `http://127.0.0.1:${server.address().port}` }));
  const result = await runComfy(dir, "music_cover", { prompt: "jazz", lyrics: "[Instrumental]", audio: source, seed: 0 });
  assert.equal(uploads, 1);
  assert.equal(graph["45"].inputs.audio, "uploaded.flac");
  assert.equal(graph["67"].inputs.value, 0);
  assert.deepEqual(graph["1025"].inputs.max_duration, ["1060", 1]);
  assert.equal((await readFile(result.audio[0].path)).toString(), "fLaC-cover");
  await assert.rejects(runComfy(dir, "music_cover", { prompt: "jazz", lyrics: "[Instrumental]", audio: "relative.flac" }), /абсолютный путь/);
});

test("YuE2 can plan ABC without audio, return reports, and render a revised local score", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-abc-test-"));
  const score = "X:1\nT:Test\nM:4/4\nK:C\nCDEF|\n";
  let graph, calls = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/object_info") return res.end(JSON.stringify(Object.fromEntries(Object.values(builtinGraph(DEFAULT_COMFY_SETTINGS, "music", { prompt: "rock", lyrics: "[Verse]\nWords" }, [])).map(node => [node.class_type, {}]))));
    if (req.url === "/prompt") { graph = JSON.parse(Buffer.concat(chunks)).prompt; calls++; return res.end(JSON.stringify({ prompt_id: `abc-${calls}` })); }
    if (req.url === "/history/abc-1") return res.end(JSON.stringify({ "abc-1": { outputs: { pi_abc: { text: [score] }, pi_analysis: { text: ["key=C duration=8s"] }, pi_modifier: { text: ["tempo unchanged"] } } } }));
    if (req.url === "/history/abc-2") return res.end(JSON.stringify({ "abc-2": { outputs: { pi_abc: { text: [score] }, pi_analysis: { text: ["key=C duration=8s"] }, "10": { audio: [{ filename: "render.flac", type: "output" }] } } } }));
    if (req.url === "/history/abc-3") return res.end(JSON.stringify({ "abc-3": { outputs: { pi_abc: { text: [score] }, "10": { audio: [{ filename: "cover.flac", type: "output" }] } } } }));
    if (req.url.startsWith("/view?")) return res.end(Buffer.from("fLaC-render"));
    res.writeHead(404); res.end("{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await writeFile(path.join(dir, "comfyui.json"), JSON.stringify({ ...DEFAULT_COMFY_SETTINGS, enabled: true, url: `http://127.0.0.1:${server.address().port}` }));
  const planned = await runComfy(dir, "music", { prompt: "rock", lyrics: "[Verse]\nWords", plan_only: true, seed: 9 });
  assert.equal(graph["10"], undefined);
  assert.equal(graph.pi_abc.class_type, "PreviewAny");
  assert.equal((await readFile(planned.abcFile, "utf8")), score);
  assert.equal(planned.reports.analysis, "key=C duration=8s");
  assert.deepEqual(planned.audio, []);
  const rendered = await runComfy(dir, "music", { prompt: "rock", lyrics: "[Verse]\nWords", abc_file: planned.abcFile, music_options: { tempo_mode: "override", bpm: 96 } });
  assert.equal(Object.values(graph).some(node => node.class_type === "YuE2NativeGenerateABC"), false);
  assert.equal(Object.values(graph).find(node => node.class_type === "YuE2ABCModifier").inputs.abc, score);
  assert.equal(Object.values(graph).find(node => node.class_type === "YuE2ABCModifier").inputs.bpm, 96);
  assert.equal((await readFile(rendered.audio[0].path)).toString(), "fLaC-render");
  const cover = await runComfy(dir, "music_cover", { prompt: "jazz", lyrics: "[Instrumental]", abc_file: planned.abcFile });
  assert.equal(Object.values(graph).some(node => node.class_type === "LoadAudio"), false);
  assert.equal(Object.values(graph).find(node => node.class_type === "YuE2NativeGenerateMusic").inputs.mode, "melody");
  assert.equal(cover.audio.length, 1);
});

test("YuE2 vocal editing preserves original ABC and renders only the converted instrumental score", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-yue2-vocals-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = 'X:1\nT:\nM:2/4\nL:1/16\nQ:1/4=120\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\nV: Ins clef=treble name="Ins Melody" snm="Inst."\nK:C\n% verse\nV: Vocal\nG2A2B2c2|\nV: Ins\nC2D2E2F2|\n';
  const abcFile = path.join(dir, "source.abc");
  await writeFile(abcFile, source);
  const edited = await editComfyMusicVocals(dir, abcFile, "accompaniment_only");
  assert.equal(await readFile(abcFile, "utf8"), source);
  assert.match(await readFile(edited.abcFile, "utf8"), /V: Vocal\nz2z2z2z2\|/);
  assert.equal(edited.report.instrumentalNotesBefore, edited.report.instrumentalNotesAfter);
  let queued, calls = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/object_info") return res.end(JSON.stringify(Object.fromEntries(Object.values(builtinGraph(DEFAULT_COMFY_SETTINGS, "music", { prompt: "jazz", lyrics: "[Instrumental]", abc_text: source }, [])).map(node => [node.class_type, {}]))));
    if (req.url === "/prompt") { queued = JSON.parse(Buffer.concat(chunks)).prompt; calls++; return res.end('{"prompt_id":"vocals-test"}'); }
    if (req.url === "/history/vocals-test") return res.end(JSON.stringify({ "vocals-test": { outputs: { pi_abc: { text: [Object.values(queued).find(node => node.class_type === "YuE2ABCModifier").inputs.abc] }, "10": { audio: [{ filename: "instrumental.flac", type: "output" }] } } } }));
    if (req.url.startsWith("/view?")) return res.end(Buffer.from("fLaC-instrumental"));
    res.writeHead(404); res.end("{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  await writeFile(path.join(dir, "comfyui.json"), JSON.stringify({ ...DEFAULT_COMFY_SETTINGS, enabled: true, url: `http://127.0.0.1:${server.address().port}` }));
  await assert.rejects(runComfy(dir, "music", { prompt: "jazz", vocal_mode: "instrumental_lead" }), /Сначала получите ABC/);
  assert.equal(calls, 0);
  const result = await runComfy(dir, "music", { prompt: "jazz", abc_file: abcFile, vocal_mode: "instrumental_lead" });
  const score = Object.values(queued).find(node => node.class_type === "YuE2ABCModifier").inputs.abc;
  assert.match(score, /V: Vocal\nz2z2z2z2\|/);
  assert.match(score, /V: Ins\n=G2=A2=B2=c2\|/);
  assert.equal(Object.values(queued).find(node => node.class_type === "YuE2LyricsStructurer").inputs.lyrics_text, "[Instrumental]");
  assert.match(Object.values(queued).find(node => node.class_type === "YuE2StyleBuilder").inputs.extra, /no singing/);
  assert.equal(Object.values(queued).find(node => node.class_type === "YuE2StyleBuilder").inputs.vocal, "");
  assert.equal(result.reports.vocal_edit.includes('"verified":true'), true);
  assert.equal(await readFile(abcFile, "utf8"), source);
  assert.equal(await readFile(result.abcFile, "utf8"), score);
  assert.equal(result.audio.length, 1);
});

test("one-call instrumental flow plans with [Instrumental], moves Vocal to Ins, and renders without repeating score options", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-yue2-instrumental-"));
  const source = 'X:1\nT:\nM:2/4\nL:1/16\nQ:1/4=120\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\nV: Ins clef=treble name="Ins Melody" snm="Inst."\nK:C\n% verse\nV: Vocal\nG2A2B2c2|\nV: Ins\nC2D2E2F2|\n';
  const graphs = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/object_info") return res.end(JSON.stringify(Object.fromEntries(Object.values(builtinGraph(DEFAULT_COMFY_SETTINGS, "music", { prompt: "metal", lyrics: "[Instrumental]" }, [])).map(node => [node.class_type, {}]))));
    if (req.url === "/prompt") {
      graphs.push(JSON.parse(Buffer.concat(chunks)).prompt);
      return res.end(JSON.stringify({ prompt_id: `instrumental-${graphs.length}` }));
    }
    if (req.url === "/history/instrumental-1") return res.end(JSON.stringify({ "instrumental-1": { outputs: { pi_abc: { text: [source] } } } }));
    const render = /^\/history\/(instrumental-(\d+))$/.exec(req.url ?? "");
    if (render) {
      const converted = Object.values(graphs[Number(render[2]) - 1]).find(node => node.class_type === "YuE2ABCModifier").inputs.abc;
      return res.end(JSON.stringify({ [render[1]]: { outputs: { pi_abc: { text: [converted] }, pi_generation_limit: { text: ["True"] }, pi_generation_info: { text: ["limit_reached=True"] }, pi_generated_seconds: { text: ["8.0"] }, "10": { audio: [{ filename: "instrumental.flac", type: "output" }] } } } }));
    }
    if (req.url.startsWith("/view?")) return res.end(Buffer.from("fLaC-instrumental"));
    res.writeHead(404); res.end("{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await writeFile(path.join(dir, "comfyui.json"), JSON.stringify({ ...DEFAULT_COMFY_SETTINGS, enabled: true, url: `http://127.0.0.1:${server.address().port}` }));
  const result = await runInstrumentalComfy(dir, { prompt: "epic heavy metal", vocal_mode: "instrumental_lead", music_options: { tempo_mode: "override", bpm: 96, abc_max_tokens: 4000, music_temperature: 0.8 } });
  assert.equal(graphs.length, 2);
  assert.equal(graphs[0]["10"], undefined);
  assert.equal(Object.values(graphs[0]).find(node => node.class_type === "YuE2LyricsStructurer").inputs.lyrics_text, "[Instrumental]");
  assert.equal(Object.values(graphs[0]).find(node => node.class_type === "YuE2ABCModifier").inputs.bpm, 96);
  assert.equal(Object.values(graphs[1]).find(node => node.class_type === "YuE2ABCModifier").inputs.tempo_mode, "keep");
  assert.equal(Object.values(graphs[1]).find(node => node.class_type === "YuE2NativeGenerateMusic").inputs.temperature, 0.8);
  assert.match(Object.values(graphs[1]).find(node => node.class_type === "YuE2ABCModifier").inputs.abc, /V: Ins\n=G2=A2=B2=c2\|/);
  assert.equal(result.reports.final_vocal_check.includes('"vocalNotesBefore":0'), true);
  assert.equal(result.plannedHere, true);
  assert.equal(result.audio.length, 1);
  assert.equal(result.generationLimitReached, true);
  assert.equal(result.reports.generation_limit, "REACHED: ending may be truncated");
  const record = JSON.parse(await readFile(result.recordFile, "utf8"));
  assert.equal(record.status, "needs_review");
  assert.equal(record.request.prompt, "epic heavy metal");
  assert.equal(record.request.musicOptions.music_temperature, 0.8);
  assert.equal(record.files.finalAbc, result.abcFile);
  assert.equal(await readFile(result.sourceAbcFile, "utf8"), source);
  const minus = await runInstrumentalComfy(dir, { prompt: "epic heavy metal", vocal_mode: "accompaniment_only", abc_file: result.sourceAbcFile });
  assert.equal(graphs.length, 3);
  assert.equal(minus.plannedHere, false);
  assert.match(await readFile(minus.abcFile, "utf8"), /V: Vocal\nz2z2z2z2\|/);
  assert.match(await readFile(minus.abcFile, "utf8"), /V: Ins\nC2D2E2F2\|/);
  const already = await runInstrumentalComfy(dir, { prompt: "epic heavy metal", vocal_mode: "instrumental_lead", abc_file: minus.abcFile });
  assert.equal(graphs.length, 4);
  assert.equal(already.reports.vocal_edit.includes('"alreadyInstrumental":true'), true);
});

test("one-call minus from source audio transcribes ABC before rendering and does not claim stem separation", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-yue2-audio-minus-"));
  const audio = path.join(dir, "source.flac");
  await writeFile(audio, Buffer.from("fLaC-source"));
  const source = 'X:1\nT:\nM:2/4\nL:1/16\nQ:1/4=120\nV: Vocal clef=treble name="Vocal Melody" snm="Vocal"\nV: Ins clef=treble name="Ins Melody" snm="Inst."\nK:C\n% verse\nV: Vocal\nG2A2B2c2|\nV: Ins\nC2D2E2F2|\n';
  const graphs = [];
  let uploads = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/upload/image") { uploads++; return res.end('{"name":"uploaded.flac"}'); }
    if (req.url === "/object_info") return res.end(JSON.stringify(Object.fromEntries(Object.values(builtinGraph(DEFAULT_COMFY_SETTINGS, "music_cover", { prompt: "metal", lyrics: "[Instrumental]", audio: "uploaded.flac" }, [])).map(node => [node.class_type, {}]))));
    if (req.url === "/prompt") {
      graphs.push(JSON.parse(Buffer.concat(chunks)).prompt);
      return res.end(JSON.stringify({ prompt_id: `minus-${graphs.length}` }));
    }
    if (req.url === "/history/minus-1") return res.end(JSON.stringify({ "minus-1": { outputs: { pi_abc: { text: [source] } } } }));
    if (req.url === "/history/minus-2") {
      const converted = Object.values(graphs[1]).find(node => node.class_type === "YuE2ABCModifier").inputs.abc;
      return res.end(JSON.stringify({ "minus-2": { outputs: { pi_abc: { text: [converted] }, "10": { audio: [{ filename: "minus.flac", type: "output" }] } } } }));
    }
    if (req.url.startsWith("/view?")) return res.end(Buffer.from("fLaC-minus"));
    res.writeHead(404); res.end("{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  await writeFile(path.join(dir, "comfyui.json"), JSON.stringify({ ...DEFAULT_COMFY_SETTINGS, enabled: true, url: `http://127.0.0.1:${server.address().port}` }));
  const result = await runInstrumentalComfy(dir, { prompt: "metal backing", vocal_mode: "accompaniment_only", audio });
  assert.equal(uploads, 1);
  assert.equal(graphs.length, 2);
  assert.equal(Object.values(graphs[0]).find(node => node.class_type === "LoadAudio").inputs.audio, "uploaded.flac");
  assert.equal(Object.values(graphs[1]).some(node => node.class_type === "LoadAudio"), false);
  assert.equal(Object.values(graphs[1]).find(node => node.class_type === "YuE2NativeGenerateMusic").inputs.mode, "melody");
  assert.match(await readFile(result.abcFile, "utf8"), /V: Ins\nC2D2E2F2\|/);
  assert.match(await readFile(result.abcFile, "utf8"), /V: Vocal\nz2z2z2z2\|/);
  assert.equal(result.audio.length, 1);
});

test("portable generated media streams support seeking and reject path escapes", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-media-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "music-generation"));
  await writeFile(path.join(dir, "music-generation", "тест.flac"), Buffer.from("0123456789"));
  const url = "pi-generated://music/" + encodeURIComponent("тест.flac");
  const response = await generatedMediaResponse(dir, new Request(url, { headers: { Range: "bytes=2-5" } }));
  assert.equal(response.status, 206); assert.equal(response.headers.get("content-range"), "bytes 2-5/10");
  assert.equal(await response.text(), "2345");
  assert.equal(await (await generatedMediaResponse(dir, new Request(url, { headers: { Range: "bytes=-3" } }))).text(), "789");
  assert.equal((await generatedMediaResponse(dir, new Request(url, { headers: { Range: "bytes=100-" } }))).status, 416);
  assert.equal((await generatedMediaResponse(dir, new Request("pi-generated://music/%2e%2e%2fsecret.flac"))).status, 404);
  await assert.rejects(generatedFile(dir, "other", "тест.flac"));
  await assert.rejects(generatedFile(dir, "music", "../secret.flac"));
});

test("local API upload, queue, history and saved image round trip", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-comfy-test-"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF3sAAAAASUVORK5CYII=", "base64");
  const calls = [];
  let cloud = false, pending = false, graph;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks); calls.push(req.url);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/system_stats") return res.end(JSON.stringify({ system: { comfyui_version: "test" }, devices: [{ name: "Local GPU" }] }));
    if (req.url === "/upload/image") {
      assert.match(req.headers["content-type"], /multipart\/form-data/);
      assert.ok(body.includes(png));
      return res.end(JSON.stringify({ name: "uploaded.png", subfolder: "inputs" }));
    }
    if (req.url === "/object_info") return res.end(JSON.stringify(Object.fromEntries(Object.values(builtinGraph(DEFAULT_COMFY_SETTINGS, "edit", { prompt: "test" }, ["a.png"], [{width:1,height:1}])).map(n => [n.class_type, { api_node: cloud }]))));
    if (req.url === "/prompt") { graph = JSON.parse(body).prompt; return res.end('{"prompt_id":"test-job"}'); }
    if (req.url === "/history/test-job") return res.end(JSON.stringify(pending ? {} : { "test-job": { status: { status_str: "success" }, outputs: { save: { images: [{ filename: "result.png", subfolder: "", type: "output" }] } } } }));
    if (req.url.startsWith("/view?")) { res.setHeader("Content-Type", "image/png"); return res.end(png); }
    if (req.url === "/queue") { assert.deepEqual(JSON.parse(body), { delete: ["test-job"] }); return res.end("{}"); }
    res.writeHead(404); res.end("{}");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const settings = { ...structuredClone(DEFAULT_COMFY_SETTINGS), url: `http://127.0.0.1:${server.address().port}` };
  assert.equal((await loadComfySettings(dir)).enabled, false);
  await saveComfySettings(dir, settings);
  await assert.rejects(runComfy(dir, "generate", { prompt: "box" }), /отключён/);
  assert.equal(calls.length, 0);
  settings.enabled = true; await saveComfySettings(dir, settings);
  assert.match(await checkComfyConnection(settings.url), /Local GPU/);
  const input = path.join(dir, "input.png"); await writeFile(input, png);
  const result = await runComfy(dir, "edit", { prompt: "box", images: [input], seed: 0 });
  assert.equal(graph.image_0.inputs.image, "inputs/uploaded.png");
  assert.equal(graph.sample.inputs.seed, 0);
  assert.deepEqual(await readFile(result.images[0].path), png);
  assert.equal(result.images[0].data, png.toString("base64"));
  assert.equal(result.images[0].mimeType, "image/png");
  assert.equal(path.dirname(result.images[0].path), path.join(dir, "image-generation"));
  const memoryResult = await runComfy(dir, "edit", { prompt: "edit pasted image", images: ["attachment:old:1"] }, undefined, undefined,
    () => ({ data: png.toString("base64"), mimeType: "image/png" }));
  assert.equal(memoryResult.images[0].data, png.toString("base64"));
  assert.deepEqual((await readdir(dir)).sort(), ["comfyui.json", "image-generation", "input.png"]);
  assert.deepEqual(await readFile(input), png);
  cloud = true;
  const queueCount = calls.filter(v => v === "/prompt").length;
  await assert.rejects(runComfy(dir, "generate", { prompt: "box" }), /Облачный узел/);
  assert.equal(calls.filter(v => v === "/prompt").length, queueCount);
  cloud = false; pending = true;
  const controller = new AbortController();
  await assert.rejects(runComfy(dir, "generate", { prompt: "box" }, controller.signal, () => controller.abort()), /abort/i);
  assert.ok(calls.includes("/queue"));
  assert.ok(!calls.includes("/interrupt"));
});
