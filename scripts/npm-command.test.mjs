import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { npmCommand } from "../electron/npm-command.ts";

test("Windows npm keeps a portable path as one argument without a shell", () => {
  const root = "F:\\Pi Desktop\\data\\runtime";
  const cli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  const files = new Set(["C:\\Program Files\\nodejs\\npm.cmd", cli]);
  const args = ["install", "--prefix", root, "--save-exact", "pi-web-access@0.23.0"];
  const env = { Path: '"C:\\Program Files\\nodejs"', ORIGINAL: "preserved" };
  const command = npmCommand(args, "F:\\Pi Desktop\\Pi Desktop.exe", env, "win32", file => files.has(file));
  assert.equal(command.executable, "F:\\Pi Desktop\\Pi Desktop.exe");
  assert.deepEqual(command.args, [cli, ...args]);
  assert.equal(command.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(command.env.ORIGINAL, "preserved");
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
});

test("Windows resolves npm's inherited entry point and fails clearly when missing", () => {
  const cli = "C:\\custom npm\\bin\\npm-cli.js";
  assert.equal(npmCommand(["--version"], "electron.exe", { npm_execpath: cli }, "win32", file => file === cli).args[0], cli);
  assert.throws(() => npmCommand([], "electron.exe", {}, "win32", () => false), /npm-cli\.js/);
});

test("Unix npm invocation remains shell-free and unchanged", () => {
  const args = ["install", "--prefix", "/tmp/Pi Desktop/runtime"];
  const command = npmCommand(args, "electron", {}, "linux");
  assert.equal(command.executable, "npm");
  assert.deepEqual(command.args, args);
  assert.equal(command.env.ELECTRON_RUN_AS_NODE, undefined);
});

test("real npm reads the exact prefix containing spaces, Unicode and shell characters", { skip: process.platform !== "win32" }, () => {
  const prefix = path.join(tmpdir(), "Pi Desktop & тест %PATH%", "data", "runtime");
  const command = npmCommand(["config", "get", "prefix", "--prefix", prefix], process.execPath);
  const result = spawnSync(command.executable, command.args, { env: command.env, shell: false, windowsHide: true, encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), prefix);
});

test("updater uses the safe command for install, rollback and version checks", () => {
  const source = readFileSync(new URL("../electron/update-manager.ts", import.meta.url), "utf8");
  assert.match(source, /npmCommand\(args, this\.runtimeExecutable\)/);
  assert.match(source, /spawn\(command\.executable, command\.args,/);
  assert.match(source, /shell: false/);
  assert.doesNotMatch(source, /shell: process\.platform === "win32"/);
});
