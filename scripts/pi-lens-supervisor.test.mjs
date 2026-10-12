import test from "node:test";
import assert from "node:assert/strict";
import { createAnalysisHost } from "../resources/pi-lens/analysis-host.mjs";

const workerUrl = new URL("./fixtures/native-analysis-worker.mjs", import.meta.url);

test("native jobs are serialized and warm executor can be reused", async t => {
  const pids = [];
  const host = createAnalysisHost({ workerUrl, onStarted: (_, pid) => pids.push(pid) });
  t.after(() => host.cancel());
  const results = await Promise.all([host.analyze({ value: 1 }), host.analyze({ value: 2 })]);
  assert.deepEqual(results.map(result => result.value), [1, 2]);
  assert.equal(pids[0], pids[1]);
});

test("Stop kills a synchronously blocked native executor; later jobs use a fresh executor", async t => {
  let entered, pid;
  const started = new Promise(resolve => { entered = resolve; });
  const host = createAnalysisHost({ workerUrl, onStarted: (_, childPid) => { pid = childPid; entered(); } });
  t.after(() => host.cancel());
  const stopped = assert.rejects(host.analyze({ mode: "busy" }), { name: "AbortError" });
  await started;
  const before = Date.now();
  await host.cancel();
  await stopped;
  assert.ok(Date.now() - before < 1500, "cancel does not wait for native work to finish");
  assert.throws(() => process.kill(pid, 0), "cancel waits for the owned child to exit");
  assert.equal((await host.analyze({ value: 3 })).value, 3);
});

test("hard deadline works even when child cannot process its own timers", async t => {
  const host = createAnalysisHost({ workerUrl, timeoutMs: 600 });
  t.after(() => host.cancel());
  const before = Date.now();
  await assert.rejects(host.analyze({ mode: "busy" }), /timed out; analysis incomplete/);
  assert.ok(Date.now() - before < 2500);
});

test("native process crash is an explicit failure, not a clean empty report", async t => {
  const host = createAnalysisHost({ workerUrl });
  t.after(() => host.cancel());
  await assert.rejects(host.analyze({ mode: "crash" }), /executor exited.*analysis incomplete/);
  assert.equal((await host.analyze({ value: 4 })).value, 4);
});

test("AbortSignal cancels jobs in its own scope without late delivery", async t => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const host = createAnalysisHost({ workerUrl, onStarted: () => entered() });
  t.after(() => host.cancel());
  const abort = new AbortController();
  const active = assert.rejects(host.analyze({ mode: "busy" }, { signal: abort.signal }), { name: "AbortError" });
  const queued = assert.rejects(host.analyze({ value: 5 }, { signal: abort.signal }), { name: "AbortError" });
  await started;
  abort.abort();
  await Promise.all([active, queued]);
  await host.cancel();
  await assert.rejects(host.analyze({}, { signal: abort.signal }), { name: "AbortError" });
});

test("a queued timeout cannot kill an unrelated active analyzer", async t => {
  const host = createAnalysisHost({ workerUrl });
  t.after(() => host.cancel());
  const active = host.analyze({ mode: "busy", durationMs: 400, value: 1 });
  const queued = assert.rejects(host.analyze({ value: 2 }, { timeoutMs: 100 }), /timed out/);
  await queued;
  assert.equal((await active).value, 1);
  assert.equal((await host.analyze({ value: 3 })).value, 3);
});

test("a scoped active cancellation preserves unrelated queued work", async t => {
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const host = createAnalysisHost({ workerUrl, onStarted: () => started() });
  t.after(() => host.cancel());
  const controller = new AbortController();
  const active = assert.rejects(host.analyze({ mode: "busy" }, { signal: controller.signal }), { name: "AbortError" });
  const queued = host.analyze({ value: 5 });
  await entered; controller.abort();
  await active;
  assert.equal((await queued).value, 5);
});

test("runtime retirement waits for exit and restores a fresh executor", async t => {
  const pids = [];
  const host = createAnalysisHost({ workerUrl, onStarted: (_, pid) => pids.push(pid) });
  t.after(() => host.cancel());
  assert.equal((await host.analyze({ retire: true, value: 1 })).value, 1);
  assert.equal((await host.analyze({ value: 2 })).value, 2);
  assert.notEqual(pids[0], pids[1]);
  assert.throws(() => process.kill(pids[0], 0));
});

test("IPC preserves values and serialization failure rejects promptly", async t => {
  const host = createAnalysisHost({ workerUrl });
  t.after(() => host.cancel());
  assert.equal((await host.analyze({ value: Infinity })).value, Infinity);
  await assert.rejects(host.analyze({ value: () => {} }), /clone|serialize/i);
  assert.equal((await host.analyze({ value: 3 })).value, 3);
  await assert.rejects(host.analyze({}, { timeoutMs: NaN }), /Invalid analysis deadline/);
});

test("queued analysis uses an immutable input snapshot", async t => {
  const host = createAnalysisHost({ workerUrl });
  t.after(() => host.cancel());
  const first = host.analyze({ mode: "busy", durationMs: 100 });
  const input = { value: { name: "original" } };
  const queued = host.analyze(input);
  input.value.name = "changed";
  await first;
  assert.deepEqual((await queued).value, { name: "original" });
});
