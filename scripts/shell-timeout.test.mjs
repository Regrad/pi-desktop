import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { patchShellTimeout } from "../resources/pi-rpc-bridge/shell-timeout-patch.js";

const bashFile = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js", import.meta.url));
const original = await readFile(bashFile, "utf8");

test("shell timeout bridge is version-sensitive, idempotent and preserves UTF-8/newlines", () => {
  const patched = patchShellTimeout(original);
  assert.equal(patchShellTimeout(patched), patched);
  assert.equal(patchShellTimeout(original.replace(/\r?\n/g, "\r\n")), patched.replace(/\r?\n/g, "\r\n"));
  assert.throws(() => patchShellTimeout("unknown"), /no longer matches pinned Pi/);
  assert.match(patched, /timeout = 300/);
  assert.match(patched, /defaults to 300/);
  assert.match(patched, /Execution may be partial/);
});

// Load the actual patched executor, with a short default only inside this test.
// The temporary module is adjacent to bash.js so all native imports stay real.
async function executor(t, shortened = false) {
  const file = path.join(path.dirname(bashFile), `.desktop-timeout-test-${randomUUID()}.js`);
  const source = patchShellTimeout(original);
  await writeFile(file, shortened ? source.replaceAll("timeout = 300", "timeout = 1") : source, "utf8");
  t.after(() => unlink(file));
  return import(pathToFileURL(file).href);
}

test("default reaches native and custom shell tools; explicit long timeouts remain unchanged", async t => {
  const { createShellToolDefinition } = await executor(t);
  for (const name of ["bash", "powershell"]) {
    const calls = [];
    const tool = createShellToolDefinition(process.cwd(), { name, label: name, shellName: name, tempFilePrefix: "pi-timeout-test" }, {
      operations: { async exec(_command, _cwd, options) { calls.push(options.timeout); return { exitCode: 0 }; } },
    });
    for (const parameters of [{ command: "noop" }, { command: "noop", timeout: 1200 }, { command: "noop", timeout: 0.25 }])
      await tool.execute("test", parameters);
    assert.deepEqual(calls, [300, 1200, 0.25]);
  }
});

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

test("omitted timeout stops a real silent process and its child, not an unrelated process", { timeout: 15000 }, async t => {
  const { createLocalShellOperations } = await executor(t, true);
  const operations = createLocalShellOperations("test", () => ({ shell: process.execPath, args: ["-e"] }));
  let output = "";
  const command = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`;
  await assert.rejects(operations.exec(command, process.cwd(), { onData: b => { output += b.toString(); } }), /timeout:1$/);
  const ids = JSON.parse(output.trim());
  assert.equal(ids.length, 2);
  for (let i = 0; i < 30 && ids.some(alive); i++) await delay(50);
  assert.equal(ids.some(alive), false, "The timed-out command tree must be terminated");
  assert.equal(alive(process.pid), true);
});

test("native timeout preserves partial output; explicit larger timeout allows normal completion", { timeout: 15000 }, async t => {
  const { createLocalShellOperations, createShellToolDefinition } = await executor(t, true);
  const operations = createLocalShellOperations("test", () => ({ shell: process.execPath, args: ["-e"] }));
  const tool = createShellToolDefinition(process.cwd(), { name: "bash", label: "bash", shellName: "test", tempFilePrefix: "pi-timeout-test" }, { operations });
  await assert.rejects(tool.execute("test", { command: "console.log('PARTIAL_OUTPUT');setInterval(()=>{},1000)" }),
    /PARTIAL_OUTPUT[\s\S]*timed out after 1 seconds\. Execution may be partial\./);
  const result = await tool.execute("test", { command: "setTimeout(()=>console.log('COMPLETED'),1200)", timeout: 3 });
  assert.equal(result.structuredContent.exit_code, 0);
  assert.match(result.structuredContent.output, /COMPLETED/);
  for (const timeout of [0, -1, NaN, Infinity])
    await assert.rejects(operations.exec("", process.cwd(), { onData() {}, timeout }), /Invalid timeout/);
});

test("an explicit short timeout and Stop still terminate the real command", { timeout: 15000 }, async t => {
  const { createLocalShellOperations } = await executor(t);
  const operations = createLocalShellOperations("test", () => ({ shell: process.execPath, args: ["-e"] }));
  const command = "console.log(process.pid);setInterval(()=>{},1000)";
  let output = "";
  await assert.rejects(operations.exec(command, process.cwd(), { timeout: 0.5, onData: b => { output += b.toString(); } }), /timeout:0\.5$/);
  const timedPid = Number(output.trim());
  assert.ok(timedPid > 0);
  for (let i = 0; i < 30 && alive(timedPid); i++) await delay(50);
  assert.equal(alive(timedPid), false);
  const controller = new AbortController();
  let stoppedPid;
  await assert.rejects(operations.exec(command, process.cwd(), {
    signal: controller.signal,
    onData(b) { stoppedPid = Number(b.toString().trim()); controller.abort(); },
  }), /^Error: aborted$/);
  assert.ok(stoppedPid > 0);
  for (let i = 0; i < 30 && alive(stoppedPid); i++) await delay(50);
  assert.equal(alive(stoppedPid), false);
});
