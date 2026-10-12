import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

// Run only isolated test commands inside the staged Electron/ASAR runtime.
async function smoke() {
  const assert = require("node:assert/strict");
  const path = require("node:path");
  const { pathToFileURL } = require("node:url");
  const root = path.join(path.dirname(process.execPath), "resources", "app.asar");
  const { createShellToolDefinition, createLocalShellOperations } = await import(pathToFileURL(path.join(root,
    "node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js")).href);
  const calls = [];
  const config = { name: "bash", label: "bash", shellName: "test", tempFilePrefix: "pi-packaged-timeout" };
  const tool = createShellToolDefinition(process.cwd(), config, {
    operations: { async exec(_command, _cwd, options) { calls.push(options.timeout); return { exitCode: 0 }; } },
  });
  await tool.execute("test", { command: "noop" });
  await tool.execute("test", { command: "noop", timeout: 1200 });
  assert.deepEqual(calls, [300, 1200]);
  const operations = createLocalShellOperations("test", () => ({ shell: process.execPath, args: ["-e"] }));
  let output = "";
  await assert.rejects(operations.exec("console.log(process.pid);setInterval(()=>{},1000)", process.cwd(), {
    timeout: 0.5, onData: b => { output += b.toString(); },
  }), /timeout:0\.5$/);
  const pid = Number(output.trim());
  assert.ok(pid > 0);
  for (let i = 0; i < 30; i++) {
    try { process.kill(pid, 0); }
    catch (error) {
      if (error.code === "ESRCH") {
        console.log("Packaged native shell smoke passed: 300-second default, explicit override and process termination.");
        return;
      }
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Timed-out test child still alive");
}

assert.ok(process.argv[2], "Pass the staged Pi Desktop.exe path");
const result = spawnSync(path.resolve(process.argv[2]), ["-e", `(${smoke.toString()})().catch(error => { console.error(error); process.exitCode = 1; });`], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8", windowsHide: true, timeout: 15000,
});
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
assert.equal(result.status, 0, "Packaged shell smoke failed");
