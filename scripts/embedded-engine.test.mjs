import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyUpstream, inventory } from "./pi-upstream-state.mjs";
import { classifyReleaseChanges } from "./release-update-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const app = process.env.PI_TEST_APP_ROOT || root;
const { DataStore } = await import(pathToFileURL(path.join(app, "dist-electron/electron/data-store.js")));
const { UpdateManager } = await import(pathToFileURL(path.join(app, "dist-electron/electron/update-manager.js")));
const upstream = JSON.parse(await readFile(path.join(root, "vendor/pi.upstream.json"), "utf8"));

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-embedded-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function put(root, relative, text) {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

test("built upstream source remains pristine and all eight packages resolve to the same revision", async () => {
  assert.equal((await verifyUpstream(root)).version, "1.5.2");
  for (const name of upstream.packages) {
    const sourcePackage = JSON.parse(await readFile(path.join(root, "vendor/pi/packages", name, "package.json"), "utf8"));
    const installed = path.join(app, "node_modules", sourcePackage.name);
    assert.equal(JSON.parse(await readFile(path.join(installed, "package.json"), "utf8")).version, upstream.version);
    const actual = await realpath(installed);
    assert.ok(actual.startsWith(path.resolve(app) + path.sep), `Package escapes application: ${actual}`);
  }
  if (process.env.PI_TEST_APP_ROOT) {
    assert.match(await readFile(path.join(app, "resources/pi-engine/LICENSE"), "utf8"), /MIT License/);
    const bundled = JSON.parse(await readFile(path.join(app, "resources/pi-engine/upstream.json"), "utf8"));
    assert.equal(bundled.commit, upstream.commit);
  }
});

test("sync refuses modified, added and missing original files while accepting generated output", async t => {
  const dir = await fixture(t);
  await put(dir, "vendor/pi/src/module.ts", "export const original = true;\n");
  await put(dir, "vendor/pi-assets/data.json", "{}\n");
  await put(dir, "vendor/pi.upstream.json", JSON.stringify({ version: "1.5.2", files: await inventory(path.join(dir, "vendor/pi")) }));
  await put(dir, "vendor/pi-assets.json", JSON.stringify({ version: "1.5.2", files: await inventory(path.join(dir, "vendor/pi-assets")) }));
  await verifyUpstream(dir);
  await put(dir, "vendor/pi/packages/ai/dist/test.js", "generated");
  await verifyUpstream(dir);
  await put(dir, "vendor/pi/src/module.ts", "locally edited");
  await assert.rejects(verifyUpstream(dir), /modified/);
  await put(dir, "vendor/pi/src/module.ts", "export const original = true;\n");
  await put(dir, "vendor/pi/src/local.ts", "custom work");
  await assert.rejects(verifyUpstream(dir), /Unrecorded upstream/);
  await rm(path.join(dir, "vendor/pi/src/local.ts"));
  await rm(path.join(dir, "vendor/pi/src/module.ts"));
  await assert.rejects(verifyUpstream(dir), /ENOENT/);
});

test("old data/runtime Pi cannot override embedded packages; third-party overrides still work", async t => {
  const dir = await fixture(t);
  const store = new DataStore(dir, app, process.execPath);
  for (const pkg of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "pi-lens"]) {
    await put(dir, `runtime/node_modules/${pkg}/package.json`, JSON.stringify({ version: "99.0.0" }));
    assert.equal(store.getEffectivePackagePath(pkg), path.join(pkg === "pi-lens" ? path.join(dir, "runtime") : app, "node_modules", pkg));
  }
  assert.equal(store.getEngineEntryPath(), path.join(app, "resources/pi-engine/worker.mjs"));
  const manager = new UpdateManager(store, app, process.execPath);
  assert.throws(() => manager.updateComponent("pi-core"), /вместе с приложением/);
});

test("engine source and build changes force complete packaging instead of partial bridge copying", () => {
  for (const file of ["vendor/pi/packages/agent/src/agent.ts", "vendor/pi.upstream.json", "vendor/pi-assets.json", "scripts/build-pi-engine.mjs"]) {
    assert.equal(classifyReleaseChanges([file]).fullRequired, true, file);
  }
});
