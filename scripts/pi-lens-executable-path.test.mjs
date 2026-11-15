import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveAsarExecutable } from "../resources/pi-lens/executable-path.mjs";
import { patchPiLensExecutablePath } from "../resources/pi-lens/executable-path-patch.mjs";

test("ASAR executable mapping never fabricates paths or rewrites JavaScript", () => {
  assert.equal(resolveAsarExecutable("C:/app.asar/bin/a.exe", p => p === "C:/app.asar.unpacked/bin/a.exe"), "C:/app.asar.unpacked/bin/a.exe");
  assert.equal(resolveAsarExecutable("C:\\app.asar\\bin\\a.exe", () => true), "C:\\app.asar.unpacked\\bin\\a.exe");
  assert.equal(resolveAsarExecutable("C:/app.asar/bin/a.exe", () => false), "C:/app.asar/bin/a.exe");
  assert.equal(resolveAsarExecutable("C:/app.asar/bin/a.js", () => true), "C:/app.asar/bin/a.js");
  assert.equal(resolveAsarExecutable("a.exe", () => true), "a.exe");
  assert.equal(resolveAsarExecutable("C:/app.asar.unpacked/bin/a.exe", () => true), "C:/app.asar.unpacked/bin/a.exe");
});

test("installed physical ast-grep binary actually runs after path resolution", () => {
  const relative = path.join("node_modules", "@ast-grep", "cli-win32-x64-msvc", "ast-grep.exe");
  const installed = [
    path.resolve("release/Pi Desktop/app/resources/app", relative),
    path.resolve("release/Pi Desktop_Work/app/resources/app", relative),
    path.resolve(relative),
  ].filter(candidate => existsSync(candidate));
  assert.ok(installed.length, "ast-grep binary is not installed");
  for (const physical of installed) {
    // An archive layout reports the .asar path; the portable folder reports
    // the file itself, so the mapping has to leave it alone.
    const archived = physical.replace(`app${path.sep}node_modules${path.sep}`, `app.asar${path.sep}node_modules${path.sep}`);
    const reported = existsSync(archived.replace(".asar", ".asar.unpacked")) ? archived : physical;
    const executable = resolveAsarExecutable(reported);
    assert.ok(existsSync(executable), `${executable} is missing after path resolution`);
    const result = spawnSync(executable, ["--version"], { windowsHide: true, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, JSON.stringify({ error: result.error?.code, stderr: result.stderr }));
    assert.match(result.stdout, /ast-grep/);
  }
});

test("both installed launchers retain the fix without stall instrumentation", async () => {
  for (const name of ["dist/index.js", "dist/clients/lsp/launch.js"]) {
    const source = await readFile(path.join("node_modules/pi-lens", name), "utf8");
    assert.equal(patchPiLensExecutablePath(source, name), source);
    assert.match(source, /command = desktopPhysicalExecutable\(command\)/);
    assert.doesNotMatch(source, /desktopStall|desktop-analysis\/stall-probe\.mjs/);
  }
  assert.throws(() => patchPiLensExecutablePath("changed upstream"), /anchor changed/);
  const installer = await readFile("resources/pi-lens/grammar-cache-patch.mjs", "utf8");
  assert.match(installer, /await applyPiLensExecutablePath\(packageDir\)/);
  assert.doesNotMatch(installer, /Stall/);
});
