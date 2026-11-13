import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { FAST_RELEASE_MANIFEST, changedReleaseInputs, classifyReleaseChanges, collectReleaseInputs, createFastReleaseManifest, assertReleaseInputsUnchanged, writeFastReleaseManifest } from "./release-update-core.mjs";

test("portable license and README image are tracked and shipped by both update paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-release-public-files-"));
  try {
    await mkdir(path.join(root, "docs", "assets"), { recursive: true });
    const files = ["LICENSE", "docs/assets/pi-desktop.png"];
    for (const file of files) await writeFile(path.join(root, file), "original");
    const before = await collectReleaseInputs(root);
    for (const file of files) await writeFile(path.join(root, file), "updated");
    const changed = changedReleaseInputs(before, await collectReleaseInputs(root));
    assert.deepEqual(changed, files);
    const update = classifyReleaseChanges(changed);
    assert.deepEqual(update.rootFiles, files);
    assert.equal(update.renderer, false);
    assert.equal(update.fullRequired, false);
    const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    for (const file of files) assert.ok(pkg.build.extraFiles.some(item => item.from === file && item.to === file), file);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("changes to the bridge packaging graph trigger a modular bridge update", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-release-bridge-graph-"));
  try {
    await mkdir(path.join(root, "scripts"));
    await writeFile(path.join(root, "scripts", "update-portable-fast.mjs"), "staging graph");
    await writeFile(path.join(root, "scripts", "release-update-core.mjs"), "manifest logic");
    const captured = await collectReleaseInputs(root);
    for (const name of ["scripts/update-portable-fast.mjs", "scripts/release-update-core.mjs"]) {
      assert.equal(typeof captured[name], "string");
      const classification = classifyReleaseChanges([name]);
      assert.equal(classification.bridge, true); assert.equal(classification.renderer, false);
    }
    const script = await readFile(new URL("./update-portable-fast.mjs", import.meta.url), "utf8");
    assert.ok(script.includes('"dist/extensions/codemode/execute.js"'));
    assert.ok(script.includes('"dist/core/extensions/desktop-planning-permissions.js"'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("source manifest excludes generated client-agent output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-release-inputs-"));
  try {
    await mkdir(path.join(root, "client-agent", "bin"), { recursive: true });
    await mkdir(path.join(root, "resources", "client-agent"), { recursive: true });
    await writeFile(path.join(root, "client-agent", "Program.cs"), "source");
    await writeFile(path.join(root, "client-agent", "bin", "generated.dll"), "generated");
    await writeFile(path.join(root, "resources", "client-agent", "Pi Desktop Agent.exe"), "generated");
    const files = await collectReleaseInputs(root);
    assert.equal(typeof files["client-agent/Program.cs"], "string");
    assert.equal(files["client-agent/bin/generated.dll"], undefined);
    assert.equal(files["resources/client-agent/Pi Desktop Agent.exe"], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release manifest can be replaced without leaving temporary files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-release-manifest-"));
  const release = path.join(root, "release");
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: {}, devDependencies: { electron: "1" }, build: {} }));
    await writeFastReleaseManifest(root, release, await createFastReleaseManifest(root));
    await writeFile(path.join(root, "README.md"), "changed");
    await writeFastReleaseManifest(root, release, await createFastReleaseManifest(root));
    const manifest = JSON.parse(await readFile(path.join(release, FAST_RELEASE_MANIFEST), "utf8"));
    assert.equal(typeof manifest.files["README.md"], "string");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest keeps the captured input version; edits during a build stay pending", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-release-snapshot-"));
  try {
    await writeFile(path.join(root, "package.json"), "{}");
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "a.ts"), "version A");
    const captured = await createFastReleaseManifest(root);
    await assertReleaseInputsUnchanged(root, captured);
    await writeFile(path.join(root, "src", "a.ts"), "version B");
    await assert.rejects(assertReleaseInputsUnchanged(root, captured), /Sources changed during the build.*src\/a.ts/);
    await writeFastReleaseManifest(root, path.join(root, "release"), captured);
    const saved = JSON.parse(await readFile(path.join(root, "release", FAST_RELEASE_MANIFEST), "utf8"));
    assert.deepEqual(changedReleaseInputs(saved.files, await collectReleaseInputs(root)), ["src/a.ts"]);
    await assert.rejects(writeFastReleaseManifest(root, path.join(root, "release")), /captured build-input snapshot/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("detects added changed and deleted inputs", () => {
  assert.deepEqual(changedReleaseInputs({ "src/a.ts": "old", "src/deleted.ts": "x" }, { "src/a.ts": "new", "src/added.ts": "y" }), [
    "src/a.ts",
    "src/added.ts",
    "src/deleted.ts",
  ]);
});

test("renderer-only changes do not rebuild unrelated modules", () => {
  const result = classifyReleaseChanges(["src/App.tsx"]);
  assert.equal(result.renderer, true);
  assert.equal(result.electron, false);
  assert.equal(result.bridge, false);
  assert.equal(result.clientAgent, false);
});

test("shared code rebuilds both TypeScript consumers", () => {
  const result = classifyReleaseChanges(["shared/contracts.ts"]);
  assert.equal(result.renderer, true);
  assert.equal(result.electron, true);
});

test("ComfyUI source updates packaged and active addon copies", () => {
  const file = "resources/pi-comfyui/lib/comfy-client.ts";
  const result = classifyReleaseChanges([file]);
  assert.equal(result.electron, true);
  assert.deepEqual(result.resources, [file]);
  assert.deepEqual(result.activeAddon, [file]);
});

test("dependency lock changes require a full package", () => {
  assert.equal(classifyReleaseChanges(["package-lock.json"]).fullRequired, true);
});

test("release input paths cannot escape their source or destination", () => {
  for (const filename of ["resources/../../data", "../release", "resources\\..\\data", "C:/outside", "resources//file", "/outside"]) {
    assert.throws(() => classifyReleaseChanges([filename]), /Invalid release input path/);
  }
});

test("compatibility sources refresh only the bridge", () => {
  const result = classifyReleaseChanges(["resources/pi-rpc-bridge/context-patch.js"]);
  assert.equal(result.bridge, true);
  assert.equal(result.renderer, false);
  assert.equal(result.electron, false);
});
