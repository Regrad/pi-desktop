import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { patchShellTimeout } from "../resources/pi-rpc-bridge/shell-timeout-patch.js";
import { defaultShellTimeout } from "../resources/pi-rpc-bridge/shell-timeout-policy.js";

const bashFile = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js", import.meta.url));
const original = await readFile(bashFile, "utf8");

test("shell timeout bridge is version-sensitive, idempotent and preserves UTF-8/newlines", () => {
  const patched = patchShellTimeout(original);
  assert.equal(patchShellTimeout(patched), patched);
  assert.equal(patchShellTimeout(original.replace(/\r?\n/g, "\r\n")), patched.replace(/\r?\n/g, "\r\n"));
  assert.throws(() => patchShellTimeout("unknown"), /no longer matches pinned Pi/);
  assert.match(patched, /timeout = defaultShellTimeout\(command\)/);
  assert.match(patched, /60 seconds for simple inspections and 3600 seconds/);
  assert.match(patched, /Execution may be partial/);
  const pristine = original.replaceAll("timeout = 300", "timeout")
    .replace("Timeout in seconds (optional, defaults to 300)", "Timeout in seconds (optional, no default timeout)")
    .replace("Timeout defaults to 300 seconds; an explicit timeout overrides it.", "Optionally provide a timeout in seconds.")
    .replace("`Command timed out after ${timeoutSecs} seconds. Execution may be partial.`", "`Command timed out after ${timeoutSecs} seconds`");
  assert.equal(patchShellTimeout(pristine), patched);
});

test("only known inspections get 60 seconds; builds, wrappers and unknown scripts get an hour", () => {
  for (const command of ["pwd", "rg -n cache electron", "git status --short; git diff --stat", "cd /x/server && head -50 CMakeLists.txt", "Get-Content 'C:\\my project\\log.txt' | Select-Object -Last 20", "cmake --version", "node --version", "echo 'build server'"])
    assert.equal(defaultShellTimeout(command), 60, command);
  for (const command of ["cmake --build build --config Release", "ninja -C build", "make -j8", '"C:\\VS Tools\\MSBuild.exe" server.sln /m', "dotnet build", "npm run build", "npm ci", "cargo test", "cd /x/server && ./compile.sh", "bash -lc 'cmake --build build'", "& 'C:\\server\\build.ps1'", "python train.py", "node job.js", "Get-Content log -Wait", "tail -f server.log", "git status; cmake --build build", "echo $(make)", "Get-Process | ForEach-Object { $_.Name }", "ssh server make", "", "# comment\ncmake --build build"])
    assert.equal(defaultShellTimeout(command), 3600, command);
});

// Load the actual patched executor, with a short default only inside this test.
// The temporary module is adjacent to bash.js so all native imports stay real.
async function executor(t, shortened = false) {
  const file = path.join(path.dirname(bashFile), `.desktop-timeout-test-${randomUUID()}.js`);
  const source = patchShellTimeout(original);
  const deadlines = typeof shortened === "object" ? shortened : { quick: 1, work: 1 };
  await writeFile(file, shortened ? source.replace("const quickSeconds = 60;", `const quickSeconds = ${deadlines.quick};`).replace("const workSeconds = 3600;", `const workSeconds = ${deadlines.work};`) : source, "utf8");
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
    for (const parameters of [{ command: "git status" }, { command: "cmake --build build" }, { command: "./compile.sh" }, { command: "noop", timeout: 1200 }, { command: "noop", timeout: 0.25 }])
      await tool.execute("test", parameters);
    assert.deepEqual(calls, [60, 3600, 3600, 1200, 0.25]);
  }
});

test("default accounts for command prefixes and spawn hooks, not just the visible command", async t => {
  const { createShellToolDefinition } = await executor(t);
  for (const options of [{ commandPrefix: "cmake --build build" }, { spawnHook: context => ({ ...context, command: "npm run build" }) }]) {
    const calls = [];
    const tool = createShellToolDefinition(process.cwd(), { name: "bash", label: "bash", shellName: "bash", tempFilePrefix: "pi-timeout-test" }, {
      ...options, operations: { async exec(command, cwd, settings) { calls.push(settings.timeout); return { exitCode: 0 }; } },
    });
    await tool.execute("test", { command: "pwd" });
    await tool.execute("test", { command: "pwd", timeout: 1200 });
    assert.deepEqual(calls, [3600, 1200]);
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

test("a silent script outlasting the quick deadline completes under the default work deadline", { timeout: 15000 }, async t => {
  const { createLocalShellOperations, createShellToolDefinition } = await executor(t, { quick: 1, work: 3 });
  const operations = createLocalShellOperations("test", () => ({ shell: process.execPath, args: ["-e"] }));
  const tool = createShellToolDefinition(process.cwd(), { name: "bash", label: "bash", shellName: "test", tempFilePrefix: "pi-timeout-test" }, { operations });
  const result = await tool.execute("test", { command: "setTimeout(()=>console.log('LONG_JOB_COMPLETED'),1500)" });
  assert.equal(result.structuredContent.exit_code, 0);
  assert.match(result.structuredContent.output, /LONG_JOB_COMPLETED/);
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
