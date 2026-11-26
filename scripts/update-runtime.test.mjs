import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { UpdateManager } from "../dist-electron/electron/update-manager.js";
import { addonPointer, resolveAddonPackage, testedAddons } from "../dist-electron/electron/addon-installation.js";

const name = "pi-tool-repair";
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-addon-update-"));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("pi-addon-update-"));
    await rm(root, { recursive: true, force: true });
  });
  const app = path.join(root, "app directory");
  const runtime = path.join(root, "runtime");
  const bundled = pkg => path.join(app, "node_modules", pkg);
  const putPackage = async (directory, version) => {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ version }));
  };
  const resolve = pkg => resolveAddonPackage(runtime, bundled(pkg), pkg);
  await putPackage(bundled(name), "0.3.0");
  await putPackage(bundled("pi-lens"), testedAddons["pi-lens"]);
  const store = { runtimePackagesDir: runtime, getEffectivePackagePath: resolve, async refreshManagedPackageConfiguration() {} };
  const manager = new UpdateManager(store, app, process.execPath);
  manager.runNpm = async ([command, , stage, ...args]) => {
    if (command === "--version") return "11.0.0";
    assert.equal(command, "install");
    assert.ok(args.includes("--ignore-scripts"));
    assert.equal(args.at(-1), `${name}@${testedAddons[name]}`);
    await putPackage(path.join(stage, "node_modules", name), testedAddons[name]);
  };
  return { manager, store, runtime, resolve, bundled };
}

test("upstream releases requiring compatibility work are visible but cannot install", async t => {
  const { manager } = await fixture(t);
  t.mock.method(globalThis, "fetch", async url => Response.json({ version: String(url).includes("pi-lens") ? "99.1.0" : "99.0.0" }));
  const status = await manager.getStatus();
  const lens = status.components.find(item => item.id === "pi-lens");
  assert.equal(lens.latestVersion, "99.1.0");
  assert.equal(lens.requiresCompatibleBuild, true);
  assert.equal(lens.updateAvailable, false);
  assert.equal(lens.updateable, false);
  const repair = status.components.find(item => item.id === name);
  assert.equal(repair.latestVersion, testedAddons[name]);
  assert.equal(repair.updateable, true);
  assert.deepEqual((await manager.updateComponent("pi-lens")).updated, []);
});

test("a rejected staged install and a failed activation both preserve the effective package", async t => {
  const { manager, store, resolve, bundled, runtime } = await fixture(t);
  manager.smokeTestRuntime = async candidate => {
    assert.equal(resolve(name), bundled(name));
    assert.match(candidate, /generation-/);
    throw new Error("candidate rejected");
  };
  await assert.rejects(manager.installCandidate(name, testedAddons[name]), /candidate rejected/);
  await assert.rejects(readFile(addonPointer(runtime, name)), { code: "ENOENT" });
  manager.smokeTestRuntime = async () => {};
  store.refreshManagedPackageConfiguration = async () => { throw new Error("config write failed"); };
  await assert.rejects(manager.installCandidate(name, testedAddons[name]), /config write failed/);
  assert.equal(resolve(name), bundled(name));
  store.refreshManagedPackageConfiguration = async () => {};
  await manager.installCandidate(name, testedAddons[name]);
  assert.notEqual(resolve(name), bundled(name));
});

test("RPC passes appRoot through to the add-on dependency resolver", () => {
  const rpc = readFileSync(new URL("../electron/pi-rpc-process.ts", import.meta.url), "utf8");
  assert.match(rpc, /PI_DESKTOP_APP_ROOT: this\.options\.appRoot/);
});

test("same-version MCP overrides must match the bundled integration fingerprint", async t => {
  const { bundled, runtime, resolve } = await fixture(t);
  const name = "pi-mcp-adapter", marker = "desktop-compatibility.json";
  const legacy = path.join(runtime, "node_modules", name);
  const generation = "generation-ABC123";
  const active = path.join(runtime, "desktop-addons", name, generation, "node_modules", name);
  for (const directory of [bundled(name), legacy, active]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ version: testedAddons[name] }));
  }
  const current = JSON.stringify({ format: 1, fingerprint: "current" });
  await writeFile(path.join(bundled(name), marker), current);
  assert.equal(resolve(name), bundled(name), "unpatched legacy copy must not hide the bundled fix");
  await writeFile(path.join(legacy, marker), current);
  assert.equal(resolve(name), legacy);
  await writeFile(addonPointer(runtime, name), JSON.stringify({ generation }));
  await writeFile(path.join(active, marker), current);
  assert.equal(resolve(name), active);
  await writeFile(path.join(bundled(name), marker), JSON.stringify({ format: 1, fingerprint: "next-build" }));
  assert.equal(resolve(name), bundled(name), "a newer bridge takes effect even with the same upstream version");
});

test("ComfyUI resolves bundled jiti with appRoot even outside node_modules", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const addonHost = new URL("../resources/pi-comfyui/lib/host.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const {hostRequire}=await import(${JSON.stringify(addonHost)});const jiti=hostRequire('jiti');if(typeof jiti.createJiti!=='function')process.exit(1);console.log('Bundled jiti resolved');`], {
    env: { ...process.env, PI_DESKTOP_APP_ROOT: root }, encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Bundled jiti resolved/);
});
