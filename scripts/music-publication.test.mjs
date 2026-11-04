import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { collectAnswerMedia, answerCanPublishMedia } from "../src/comfy-images.ts";
import { selectMusicForAnswer } from "../resources/pi-comfyui/lib/music-publication.ts";

const track = name => ({ type: "audio", path: `C:/Pi/data/music-generation/${name}.flac`, mimeType: "audio/flac" });
const generated = (id, media) => ({ id, name: "media_generate_music", result: { content: [], details: { media, files: media.map(part => part.path) } } });
const publish = (id, media) => ({ id, name: "media_publish_music", result: { content: [], details: { audioSelection: true, media, files: media.map(part => part.path) } } });

test("two tracks explicitly selected out of ten, in selection order, not answer-text order", () => {
  const tracks = Array.from({ length: 10 }, (_, i) => track(`variant-${i + 1}`));
  const jobs = tracks.map((part, i) => generated(`job-${i}`, [part]));
  const result = collectAnswerMedia([...jobs, publish("selection", [tracks[7], tracks[1]])], true, tracks.map(part => part.path).join("\n"));
  assert.deepEqual(result.parts.map(part => part.path), [tracks[7].path, tracks[1].path]);
  assert.deepEqual([...result.toolIds].sort(), ["job-1", "job-7", "selection"]);
});
test("all three requested variants are published, independent of shortened filenames", () => {
  const tracks = [track("one"), track("two"), track("three")];
  assert.deepEqual(collectAnswerMedia([...tracks.map((part, i) => generated(String(i), [part])), publish("selection", tracks)], true, "Готовы все три: one… / two… / three…").parts, tracks);
});
test("last successful selection replaces earlier selection; empty selection is authoritative", () => {
  const one = track("one"), two = track("two");
  const tools = [generated("generate", [one, two]), publish("first", [one]), publish("second", [two])];
  assert.deepEqual(collectAnswerMedia(tools).parts, [two]);
  assert.deepEqual(collectAnswerMedia([...tools, publish("none", [])], true, one.path).parts, []);
  assert.deepEqual(collectAnswerMedia([publish("none", [])]).parts, []);
});
test("failed publication does not erase previous valid selection", () => {
  const selected = track("chosen");
  const failed = publish("failed", [track("wrong")]);
  failed.result.isError = true;
  assert.deepEqual(collectAnswerMedia([publish("valid", [selected]), failed]).parts, [selected]);
});
test("existing tracks can be published without generating; duplicate paths/results appear once", () => {
  const selected = track("from-history");
  const selection = publish("selection", [selected, { ...selected }]);
  assert.deepEqual(collectAnswerMedia([selection, selection]).parts, [selected]);
});
test("media stay in tools during work, aborted turns never publish; old chats keep fallback", () => {
  const selected = track("chosen");
  assert.deepEqual(collectAnswerMedia([publish("selection", [selected])], false).parts, []);
  assert.equal(answerCanPublishMedia({ streaming: false, working: false, currentTurn: true, stopReason: "aborted" }), false);
  assert.deepEqual(collectAnswerMedia([generated("old-one", [track("one")]), generated("old-two", [selected])]).parts, [selected]);
});
test("explicit audio selection leaves intermediate-image filtering unchanged", () => {
  const image = (id, filename) => ({ id, name: "media_generate_image", result: { content: [{ type: "image", data: id, mimeType: "image/png" }], details: { files: [`C:/Pi/data/image-generation/${filename}.png`] } } });
  const result = collectAnswerMedia([image("intermediate", "preview"), image("final", "final"), publish("selection", [track("music")])]);
  assert.deepEqual(result.parts.map(part => part.type), ["image", "audio"]);
  assert.equal(result.parts[0].data, "final");
});
test("ready local music validation is atomic, deduplicated and rejects foreign files", async t => {
  const data = await mkdtemp(path.join(os.tmpdir(), "pi-music-publication-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const folder = path.join(data, "music-generation");
  await mkdir(folder);
  const one = path.join(folder, "Песня.flac"), two = path.join(folder, "two.mp3");
  await writeFile(one, "fixture"); await writeFile(two, "fixture");
  assert.deepEqual((await selectMusicForAnswer(data, [two, one, two])).map(part => part.mimeType), ["audio/mpeg", "audio/flac"]);
  assert.deepEqual(await selectMusicForAnswer(data, []), []);
  const foreign = path.join(data, "foreign.flac"), invalid = path.join(folder, "report.json");
  await writeFile(foreign, "fixture"); await writeFile(invalid, "fixture");
  await assert.rejects(selectMusicForAnswer(data, [one, foreign]), /готовые аудиофайлы/);
  await assert.rejects(selectMusicForAnswer(data, [invalid]), /готовые аудиофайлы/);
  await assert.rejects(selectMusicForAnswer(data, ["relative.flac"]), /абсолютный путь/);
  await assert.rejects(selectMusicForAnswer(data, [path.join(folder, "missing.flac")]));
  await assert.rejects(selectMusicForAnswer(data, Array(65).fill(one)), /64/);
  await assert.rejects(selectMusicForAnswer(data, [one], AbortSignal.abort()), /abort/i);
});
test("symlinks cannot publish files outside music-generation", async t => {
  const data = await mkdtemp(path.join(os.tmpdir(), "pi-music-publication-link-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  await mkdir(path.join(data, "music-generation"));
  const foreign = path.join(data, "foreign.flac"), link = path.join(data, "music-generation", "link.flac");
  await writeFile(foreign, "fixture");
  try { await symlink(foreign, link); } catch (error) {
    if (["EPERM", "EACCES"].includes(error.code)) { t.skip("Symlink privilege is unavailable"); return; }
    throw error;
  }
  await assert.rejects(selectMusicForAnswer(data, [link]), /готовые аудиофайлы/);
});
