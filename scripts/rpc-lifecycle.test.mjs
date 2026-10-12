import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { EventEmitter } from "node:events";

const source = readFileSync(new URL("../electron/pi-rpc-process.ts", import.meta.url), "utf8");
function method(name, args, async = false) {
  const start = source.indexOf(` ${name}(`);
  const begin = source.indexOf("{", source.indexOf("): ", start)) + 1;
  const end = source.indexOf("\n  }", begin);
  assert.ok(start >= 0 && begin > start && end > begin);
  const code = stripTypeScriptTypes(`${async ? "async " : ""}function run(${args}) {${source.slice(begin, end)}\n}`);
  return new Function(`${code}; return run;`)();
}
const rejectPending = method("rejectPending", "error");
const exit = method("handleExit", "error, child = this.process");
const stop = method("stop", "", true);
const request = method("request<T = unknown>", "type, payload = {}, timeoutMs = 1000", true);
test("synchronous stdin failure rejects request without a leaked timer", async () => {
  const instance = host({ stdin: { write() { throw new Error("closed pipe"); } } });
  await assert.rejects(request.call(instance, "get_state"), /closed pipe/);
  assert.equal(instance.pending.size, 0);
});
function host(child) {
  const exited = [];
  return { process: child, pending: new Map(), sequence: 0, rejectPending,
    options: { onExit: error => exited.push(error) }, exited };
}
test("intentional stop settles requests immediately, including normal SIGTERM", async () => {
  const child = new EventEmitter();
  child.kill = () => { queueMicrotask(() => child.emit("exit", 0)); return true; };
  const instance = host(child);
  let rejected;
  instance.pending.set("call", { timer: setTimeout(() => assert.fail("leaked timer"), 10000), reject: error => { rejected = error; } });
  await stop.call(instance);
  assert.match(rejected.message, /остановлен/);
  assert.equal(instance.pending.size, 0);
});
test("late old process exit cannot clear a replacement or reject its requests", () => {
  const old = {}, current = {}, instance = host(current);
  instance.pending.set("new", { reject: () => assert.fail("new request rejected") });
  exit.call(instance, new Error("old exit"), old);
  assert.equal(instance.process, current);
  assert.equal(instance.pending.size, 1);
  assert.equal(instance.exited.length, 0);
});
test("a broken pipe stops its still-running child instead of orphaning it", () => {
  let kills = 0;
  const child = { exitCode: null, signalCode: null, killed: false, kill(signal) { assert.equal(signal, "SIGTERM"); kills++; } };
  const instance = host(child);
  exit.call(instance, new Error("EPIPE"), child);
  assert.equal(kills, 1);
  assert.equal(instance.process, undefined);
  assert.equal(instance.exited.length, 1);
});
test("error and exit notification settle the same process exactly once", () => {
  const child = {}, instance = host(child);
  let count = 0;
  instance.pending.set("call", { timer: setTimeout(() => {}, 10000), reject: () => count++ });
  exit.call(instance, new Error("failed"), child);
  exit.call(instance, new Error("exit"), child);
  assert.equal(count, 1);
  assert.equal(instance.exited.length, 1);
});
test("invalid JSON payload creates no pending request; IDs and command types cannot be overridden", async () => {
  let command;
  const instance = host({ stdin: { write(value) { command = JSON.parse(value); } } });
  const circular = {}; circular.self = circular;
  await assert.rejects(request.call(instance, "get_state", circular), /circular/i);
  assert.equal(instance.pending.size, 0);
  const waiting = request.call(instance, "get_state", { id: "wrong", type: "abort" });
  assert.equal(command.id, "desktop-2");
  assert.equal(command.type, "get_state");
  instance.pending.get(command.id).resolve("ok");
  clearTimeout(instance.pending.get(command.id).timer);
  assert.equal(await waiting, "ok");
});
