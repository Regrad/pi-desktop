import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DataStore } from "../dist-electron/electron/data-store.js";

test("retired activation addon is removed from catalog, packages and explicit extensions", async t => {
  const source=readFileSync(new URL('../electron/data-store.ts',import.meta.url),'utf8');
  const constants=source.slice(source.indexOf('const MANAGED_PACKAGE_NAMES'),source.indexOf('const DEFAULT_BUILTIN_MODULES'));
  const directory = await mkdtemp(path.join(tmpdir(), "pi-retired-addon-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    assert.ok(path.basename(directory).startsWith("pi-retired-addon-"));
    await rm(directory, { recursive: true, force: true });
  });
  const store = new DataStore(directory, process.cwd(), process.execPath);
  store.builtinModules = {};
  store.getEffectivePackagePath = () => { throw Error("disabled packages must not load"); };
  await mkdir(store.agentDir, { recursive: true });
  const settingsPath = path.join(store.agentDir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({
    packages: ["F:/Pi Desktop/resources/app.asar/resources/pi-lens-all-tools", "F:/Pi Desktop/local-packages/pi-lens-all-tools",
      "npm:pi-web-access@0.48.0", "F:/Pi Desktop/data/runtime/node_modules/pi-web-access", "F:/Pi Desktop/local-packages/pi-single-slot-guard", "C:/my-addon"],
    extensions: ["resources/pi-lens-all-tools/index.js", "F:/Pi Desktop/resources/app.asar/resources/pi-lens-all-tools/index.js",
      "F:/Pi Desktop/data/runtime/node_modules/pi-web-access/index.ts", "resources/pi-single-slot-guard/index.js", "C:/my-addon/index.js"],
  }));
  await store.refreshManagedPackageConfiguration();
  const saved = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.deepEqual(saved.packages, ["C:/my-addon"]);
  assert.deepEqual(saved.extensions, ["C:/my-addon/index.js"]);
  const catalog=constants.slice(constants.indexOf('const BUILTIN_MODULES'));
  assert.ok(!catalog.includes('pi-lens-all-tools'));
  assert.ok(!catalog.includes('pi-web-access'));
  assert.ok(!catalog.includes('pi-single-slot-guard'));
  assert.ok(!existsSync(new URL('../resources/pi-lens-all-tools/index.js',import.meta.url)));
});
