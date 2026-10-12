import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
function method(file, signature) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const start = source.indexOf(signature), end = source.indexOf("\n  }", start) + 4;
  assert.ok(start >= 0 && end > start);
  const code = stripTypeScriptTypes(source.slice(start, end).replace(/^  private /, "").replace(/^async /, "async function ").replace(/^mutateModels/, "function mutateModels"));
  const name = signature.match(/private\s+(?:async\s+)?(\w+)/)[1];
  return new Function("moduleUrl", `${code.replaceAll("import.meta.url", "moduleUrl")};return ${name};`)(new URL(file, import.meta.url).href);
}
const start = method("../electron/pi-manager.ts", "  private async startConversation(");
const mutate = method("../electron/data-store.ts", "  private mutateModels<T>(");
const startOnce = method("../electron/pi-manager.ts", "  private async startConversationOnce(");
const ensure = method("../electron/pi-manager.ts", "  private async ensureRuntime(");
test("deleting or stopping a chat while resolving its directory cancels startup before spawn", async () => {
  let resolve;
  const instance = { runtimes: new Map(), startupEpochs: new Map(),
    store: { getConversationWorkingDirectory: () => new Promise(done => { resolve = done; }) },
  };
  const pending = startOnce.call(instance, { id: "chat" });
  instance.startupEpochs.set("chat", 1);
  resolve("C:/test-only");
  await assert.rejects(pending, /Запуск чата отменён/);
  assert.equal(instance.runtimes.size, 0);
});
test("a prompt waits for initialization even when the process record already exists", async () => {
  let resolve, finished = false;
  const startup = new Promise(done => { resolve = done; });
  const record = { state: "initializing" };
  const instance = { startingRuntimes: new Map([["chat", startup]]), runtimes: new Map([["chat", record]]) };
  const pending = ensure.call(instance, "chat").then(value => { finished = true; return value; });
  await Promise.resolve(); assert.equal(finished, false);
  record.state = "ready"; resolve();
  assert.equal(await pending, record);
});
test("concurrent requests for one chat share one process startup", async () => {
  let launches = 0, resolve;
  const pending = new Promise(done => { resolve = done; });
  const instance = { startingRuntimes: new Map(), startupEpochs: new Map(), startConversationOnce() { launches++; return pending; } };
  const first = start.call(instance, { id: "chat" });
  const second = start.call(instance, { id: "chat" });
  assert.equal(launches, 1);
  resolve("ready");
  assert.deepEqual(await Promise.all([first, second]), ["ready", "ready"]);
  assert.equal(instance.startingRuntimes.size, 0);
});
test("failed startup can be retried instead of leaving a rejected startup cached", async () => {
  const conversation = { id: "chat", status: "starting" };
  const instance = { startingRuntimes: new Map(), startupEpochs: new Map(),
    store: { snapshot: () => ({ conversations: [conversation] }) },
    updateConversation: async (_id, changes) => Object.assign(conversation, changes),
    startConversationOnce: () => Promise.reject(new Error("startup failed")) };
  await assert.rejects(start.call(instance, { id: "chat" }), /startup failed/);
  assert.equal(instance.startingRuntimes.size, 0);
  assert.equal(conversation.status, "error");
  instance.startConversationOnce = async () => "ready";
  assert.equal(await start.call(instance, { id: "chat" }), "ready");
});
test("concurrent model mutations read the preceding committed update", async () => {
  const instance = { modelsMutationQueue: Promise.resolve() };
  let stored = { models: ["a", "b", "c"] };
  const remove = id => mutate.call(instance, async () => {
    const config = structuredClone(stored);
    await new Promise(resolve => setImmediate(resolve));
    config.models = config.models.filter(value => value !== id);
    stored = config;
  });
  await Promise.all([remove("a"), remove("b")]);
  assert.deepEqual(stored.models, ["c"]);
  await assert.rejects(mutate.call(instance, () => Promise.reject(new Error("bad update"))));
  await remove("c");
  assert.deepEqual(stored.models, []);
});
