import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createAnalysisHost } from "../resources/pi-lens/analysis-host.mjs";

test("independent watchdog kills a blocked executor even without a working parent timer", async t => {
  const workerUrl = new URL("./fixtures/analysis-watchdog-worker.mjs", import.meta.url);
  const host = createAnalysisHost({ workerUrl, timeoutMs: 8000 });
  t.after(() => host.cancel());
  const start = Date.now();
  await assert.rejects(host.analyze({ expire: true }), /executor exited/);
  assert.ok(Date.now() - start < 4000);
});

test("executor cannot outlive its owner while its native loop is blocked", async t => {
  const hostUrl = new URL("../resources/pi-lens/analysis-host.mjs", import.meta.url).href;
  const workerUrl = new URL("./fixtures/analysis-watchdog-worker.mjs", import.meta.url).href;
  const code = `import { createAnalysisHost } from ${JSON.stringify(hostUrl)}; const h=createAnalysisHost({workerUrl:new URL(${JSON.stringify(workerUrl)}),timeoutMs:30000,onStarted:(_,pid)=>process.stdout.write(String(pid)+'\\n')}); h.analyze({}).catch(()=>{});`;
  const owner = spawn(process.execPath, ["--input-type=module", "-e", code], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let executorPid;
  t.after(() => { owner.kill("SIGKILL"); if (executorPid) { try { process.kill(executorPid, "SIGKILL"); } catch {} } });
  const pid = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Test executor did not start")), 4000);
    owner.once("error", reject);
    owner.stdout.once("data", data => { clearTimeout(timeout); resolve(Number(String(data).trim())); });
  });
  assert.ok(Number.isInteger(pid) && pid > 0); executorPid = pid;
  process.kill(pid, 0);
  const exited = once(owner, "exit"); owner.kill("SIGKILL"); await exited;
  const deadline = Date.now() + 3500;
  let alive = true;
  while (Date.now() < deadline && alive) {
    await new Promise(resolve => setTimeout(resolve, 100));
    try { process.kill(pid, 0); } catch (error) { if (error.code === "ESRCH") alive = false; else throw error; }
  }
  assert.equal(alive, false, "owned test executor exited without its blocked loop processing disconnect");
  executorPid = undefined;
});
