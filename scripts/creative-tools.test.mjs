import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createPackage } from "@electron/asar";
import { creativeMcpServers, mergeCreativeMcpServers } from "../shared/creative-tools.ts";
import { readEditorSettings, resolveEditor } from "../resources/creative-tools/runtime.mjs";
import { runBlender, executeBlender } from "../resources/creative-tools/blender.mjs";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { skillCatalogContext } from "../shared/skills.ts";

const root = path.resolve(import.meta.dirname, "..");
const temporary = process.platform === "win32" ? "C:\\AI_Temp" : tmpdir();
async function fixture() {
  await mkdir(temporary, { recursive: true });
  return mkdtemp(path.join(temporary, "pi-creative-test-"));
}

test("all editor definitions stay lazy and relocation preserves custom servers and disabled states", () => {
  const definitions = creativeMcpServers("D:/Portable/app", "D:/Portable/app/Pi Desktop.exe");
  assert.deepEqual(Object.keys(definitions), ["blender", "aseprite", "froxel"]);
  for (const definition of Object.values(definitions)) {
    assert.equal(definition.lifecycle, "lazy");
    assert.equal(definition.directTools, false);
    assert.equal(definition.requestTimeoutMs, 300_000);
    assert.equal(definition.env.ELECTRON_RUN_AS_NODE, "1");
  }
  const custom = { command: "custom-froxel", args: ["exact"], disabled: true };
  const previous = { ...definitions, froxel: custom,
    aseprite: { ...definitions.aseprite, disabled: true, env: { ELECTRON_RUN_AS_NODE: "1", CUSTOM: "keep" } } };
  const migrated = mergeCreativeMcpServers(previous, "E:/New/app", "E:/New/app/Pi Desktop.exe");
  assert.deepEqual(migrated.froxel, custom);
  assert.equal(migrated.aseprite.disabled, true);
  assert.equal(migrated.aseprite.env.CUSTOM, "keep");
  assert.equal(migrated.blender.command, "E:/New/app/Pi Desktop.exe");
  assert.ok(migrated.blender.args[0].includes(path.join("E:/New/app", "resources")));
  assert.deepEqual(previous.froxel, custom);
});

test("editor resolution supports another PC and rejects invalid explicit paths rather than falling back", async () => {
  const dir = await fixture();
  const exe = path.join(dir, "Editor in another folder.exe");
  await writeFile(exe, "fixture");
  const env = { PATH: dir, LOCALAPPDATA: dir, ProgramFiles: dir, "ProgramFiles(x86)": dir };
  assert.equal(await resolveEditor("blender", { executable: exe }, env), exe);
  assert.equal(await resolveEditor("aseprite", {}, { ...env, PI_DESKTOP_ASEPRITE_PATH: exe }), exe);
  await assert.rejects(resolveEditor("froxel", { executable: path.join(dir, "missing.exe"), file: "local-settings.json" }, env), /Configured froxel executable does not exist/);
  await assert.rejects(resolveEditor("aseprite", {}, env), /aseprite is not installed/);
});

test("settings have per-editor defaults and fail clearly on malformed files", async () => {
  const dir = await fixture();
  assert.equal((await readEditorSettings(dir, "froxel")).mode, undefined);
  await writeFile(path.join(dir, "creative-tools.json"), '{"aseprite":{"mode":"window"}}');
  assert.equal((await readEditorSettings(dir, "aseprite")).mode, "window");
  await writeFile(path.join(dir, "creative-tools.json"), '{"blender":{"executable":42}}');
  await assert.rejects(readEditorSettings(dir, "blender"), /Invalid blender settings/);
  await writeFile(path.join(dir, "creative-tools.json"), "broken");
  await assert.rejects(readEditorSettings(dir, "aseprite"), /Cannot read/);
});

test("creative instructions remain lazy skill bodies, without code-only triggers or machine paths", () => {
  const result = loadSkillsFromDir({ dir: path.join(root, "resources", "skills"), source: "test" });
  for (const name of ["blender-modeling", "pixel-art", "voxel-art"]) {
    const skill = result.skills.find(item => item.name === name);
    assert.ok(skill, name);
    assert.match(skill.description, /Do not use for ordinary/);
  }
  const catalog = skillCatalogContext({ skills: result.skills, revision: "test", roots: {} });
  assert.doesNotMatch(catalog, /silhouette|preflight|C:\\\\Users\\\\Engardium/);
});

test("Blender timeout and cancellation stop the current process before returning", async () => {
  await assert.rejects(runBlender(process.execPath, ["-e", "setTimeout(()=>{},10000)"], undefined, 60), /timed out/);
  const controller = new AbortController();
  const running = runBlender(process.execPath, ["-e", "setTimeout(()=>{},10000)"], controller.signal, 10_000);
  setTimeout(() => controller.abort(new Error("test cancellation")), 50);
  await assert.rejects(running, /test cancellation/);
  await assert.rejects(executeBlender("unused", { blendFile: "relative.blend", code: "print(1)" }), /absolute/);
});

test("editor resources can be extracted from an actual ASAR by the embedded runtime", async () => {
  const dir = await fixture();
  const source = path.join(dir, "source");
  await mkdir(path.join(source, "headless"), { recursive: true });
  const bytes = Buffer.from("-- UTF-8 проверка\nprint('ready')\n");
  await writeFile(path.join(source, "headless", "runner.lua"), bytes);
  const archive = path.join(dir, "fixture.asar");
  await createPackage(source, archive);
  const script = path.join(dir, "extract.mjs");
  const destination = path.join(dir, "extracted");
  await writeFile(script, `import { materializeResources } from ${JSON.stringify(pathToFileURL(path.join(root, "resources/creative-tools/runtime.mjs")).href)};\nawait materializeResources(${JSON.stringify(archive)}, ${JSON.stringify(destination)});\n`);
  const electron = path.join(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
  const result = spawnSync(electron, [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", windowsHide: true, timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readFile(path.join(destination, "headless", "runner.lua")), bytes);
});
