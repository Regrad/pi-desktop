import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { atomicStateWrite, StatePersistenceError } from "../electron/atomic-state.ts";

const denied = () => Object.assign(new Error("locked"), { code: "EPERM" });
test("temporary Windows denial retries replacement without truncating the old state", async () => {
  const calls = [], delays = [], warnings = [];
  let attempts = 0;
  await atomicStateWrite("state.json", "new-state", {
    async writeFile(...args) { calls.push(["write", ...args]); },
    async rename(...args) { calls.push(["replace", ...args]); if (attempts++ < 2) throw denied(); },
    async wait(ms) { delays.push(ms); }, warn(text) { warnings.push(text); },
  });
  assert.equal(calls.filter(call => call[0] === "write").length, 1);
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [25, 50]);
  assert.equal(warnings.length, 1);
});

test("persistent denial is bounded and preserves valid destination and complete temp file", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-state-write-"));
  const file = path.join(dir, "state.json");
  writeFileSync(file, '{"old":true}');
  let attempts = 0;
  await assert.rejects(atomicStateWrite(file, '{"new":true}', {
    async writeFile(file, content) { writeFileSync(file, content); },
    async rename() { attempts++; throw denied(); }, async wait() {}, warn() {},
  }), error => error instanceof StatePersistenceError && /EPERM.*7/.test(error.message));
  assert.equal(attempts, 7);
  assert.deepEqual(JSON.parse(readFileSync(file)), { old: true });
  assert.deepEqual(JSON.parse(readFileSync(file + ".tmp")), { new: true });
});

test("non-transient disk failure does not retry indefinitely; normal replacement is valid JSON", async () => {
  let attempts = 0;
  await assert.rejects(atomicStateWrite("state", "data", {
    async writeFile() { attempts++; throw Object.assign(new Error("full"), { code: "ENOSPC" }); }, async rename() { throw Error("must not run"); }, async wait() { throw Error("must not wait"); }, warn() {},
  }), StatePersistenceError);
  assert.equal(attempts, 1);
  const dir = mkdtempSync(path.join(tmpdir(), "pi-state-success-"));
  const file = path.join(dir, "state.json");
  await atomicStateWrite(file, '{"new":true}');
  assert.deepEqual(JSON.parse(readFileSync(file)), { new: true });
});

test("real write queue serializes competing saves and recovers after a failed task", async () => {
  const source = readFileSync(new URL("../electron/data-store.ts", import.meta.url), "utf8");
  const start = source.indexOf("  private enqueueWrite(");
  const begin = source.indexOf("): Promise<void> {", start) + "): Promise<void> {".length;
  const end = source.indexOf("\n  }", begin);
  const enqueue = new Function("task", source.slice(begin, end));
  const state = { writeQueue: Promise.resolve() };
  const calls = [];
  let release;
  const first = enqueue.call(state, async () => { calls.push("first-start"); await new Promise(resolve => { release = resolve; }); calls.push("first-end"); });
  const second = enqueue.call(state, async () => { calls.push("second"); });
  await Promise.resolve();
  assert.deepEqual(calls, ["first-start"]);
  release(); await Promise.all([first, second]);
  assert.deepEqual(calls, ["first-start", "first-end", "second"]);
  await assert.rejects(enqueue.call(state, async () => { throw denied(); }));
  await enqueue.call(state, async () => { calls.push("recovered"); });
  assert.equal(calls.at(-1), "recovered");
});

test("persistence failure preserves lifecycle events and emits a non-terminal UI error", () => {
  const source = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
  const start = source.indexOf("  private handlePersistenceFailure(");
  const begin = source.indexOf("): void {", start) + "): void {".length;
  const end = source.indexOf("\n  }", begin);
  const body = stripTypeScriptTypes(`function handle(conversationId, event, error) {${source.slice(begin, end)}\n}`);
  const handle = new Function(`${body};return handle;`)();
  const runtime = { snapshot: { state: { isStreaming: false } } }, events = [];
  const host = { runtimes: new Map([["chat", runtime]]), store: { getConversation: () => ({ id: "chat", status: "working" }) }, publish(channel, value) { events.push({ channel, value }); } };
  handle.call(host, "chat", { type: "agent_start" }, new Error("disk"));
  assert.equal(runtime.snapshot.state.isStreaming, true);
  assert.ok(events.some(item => item.value.event?.type === "agent_start"));
  assert.ok(events.some(item => item.value.event?.type === "desktop_persistence_error"));
  assert.equal(events.some(item => item.value.event?.type === "runtime_error"), false);
  handle.call(host, "chat", { type: "agent_settled" }, new Error("disk"));
  assert.equal(runtime.snapshot.state.isStreaming, false);
  const ui = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const branch = ui.slice(ui.indexOf('event.type === "desktop_persistence_error"'), ui.indexOf('event.type === "runtime_error"'));
  assert.doesNotMatch(branch, /setWorking\(false\)/);
});
