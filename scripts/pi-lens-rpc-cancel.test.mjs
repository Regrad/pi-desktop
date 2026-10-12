import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createAnalysisHost } from "../resources/pi-lens/analysis-host.mjs";

test("actual RPC abort branch stops the agent before cancelling the busy native executor", async t => {
  const source = readFileSync(new URL("../resources/pi-rpc-bridge/rpc-mode.js", import.meta.url), "utf8");
  assert.equal(readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/modes/rpc/rpc-mode.js", import.meta.url), "utf8"), source, "the development RPC runtime includes the same Stop integration");
  const start = source.indexOf('case "abort": {') + 'case "abort": {'.length;
  const end = source.indexOf('case "new_session":', start);
  assert.ok(start > 0 && end > start);
  const body = source.slice(start, end).replace(/\}\s*$/, "");
  const run = new Function("session", "success", "id", `return (async () => {${body}})();`);
  const cancelKey = Symbol.for("pi.desktop.cancel.native.analysis");
  const epochKey = Symbol.for("pi.desktop.native.analysis.epoch");
  const previousCancel = globalThis[cancelKey];
  const previousEpoch = globalThis[epochKey];
  let entered, agentStopped = false;
  const started = new Promise(resolve => { entered = resolve; });
  const host = createAnalysisHost({ workerUrl: new URL("./fixtures/native-analysis-worker.mjs", import.meta.url), onStarted: () => entered() });
  t.after(async () => {
    await host.cancel();
    globalThis[cancelKey] = previousCancel;
    globalThis[epochKey] = previousEpoch;
  });
  globalThis[cancelKey] = () => { assert.ok(agentStopped); return host.cancel(); };
  const aborted = assert.rejects(host.analyze({ mode: "busy" }), { name: "AbortError" });
  await started;
  const before = Date.now();
  const response = await run({ abort() { agentStopped = true; return Promise.resolve(); } }, (id, type) => ({ id, type }), "stop-1");
  await aborted;
  assert.deepEqual(response, { id: "stop-1", type: "abort" });
  assert.ok(Date.now() - before < 1500);
  assert.equal(globalThis[epochKey], (previousEpoch ?? 0) + 1);
});
