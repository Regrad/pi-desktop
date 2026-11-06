import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { DataStore } from "../dist-electron/electron/data-store.js";
import { selectConfiguredModel } from "../shared/model-selection.ts";

async function fixture(t) {
  const directory = await mkdtemp("C:/AI_Temp/pi-model-servers-");
  const data = path.join(directory, "data");
  await mkdir(path.join(data, "agent"), { recursive: true });
  await writeFile(path.join(data, "agent/models.json"), '{"providers":{}}');
  await writeFile(path.join(data, "agent/settings.json"), '{}');
  const state = { ids: ["old-model"], context: 8192, status: 200, propsStatus: 200, reasoning: false, key: "fixture-secret", requests: [] };
  const server = http.createServer((req, res) => {
    state.requests.push({ path: req.url, auth: req.headers.authorization });
    if (state.key && req.headers.authorization !== `Bearer ${state.key}`) { res.writeHead(401).end(); return; }
    res.writeHead(req.url === "/props" ? state.propsStatus : state.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(req.url === "/v1/models" ? { data: state.ids.map(id => ({ id })) }
      : req.url === "/props" ? { build_info: "fixture", model_alias: state.ids[0], chat_template: state.reasoning ? "enable_thinking preserve_thinking reasoning_effort" : "", default_generation_settings: { n_ctx: state.context } }
      : { status: "ok" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.ok(path.resolve(directory).startsWith(path.resolve("C:/AI_Temp/pi-model-servers-")));
    await rm(directory, { recursive: true, force: true });
  });
  const store = new DataStore(data, process.cwd(), process.execPath);
  const input = { address: "http://127.0.0.1", port: String(server.address().port), apiKey: state.key };
  const add = () => store.discoverModelServer(input);
  return { directory, data, store, state, input, add };
}

test("saved API key authenticates rediscovery, stays private in views, and survives portable transfer", async t => {
  const f = await fixture(t);
  const added = await f.add();
  assert.equal(added.server.apiKeyConfigured, true);
  assert.ok(!JSON.stringify(added).includes(f.state.key));
  const edited = await f.store.discoverModelServer({ ...f.input, apiKey: undefined, providerId: added.server.id });
  assert.equal(edited.server.id, added.server.id);
  assert.ok(f.state.requests.every(req => req.auth === `Bearer ${f.state.key}`));
  const moved = path.join(f.directory, "other-computer/data");
  await cp(f.data, moved, { recursive: true });
  const store = new DataStore(moved, process.cwd(), process.execPath);
  await store.refreshModelServers(true);
  const config = JSON.parse(await readFile(path.join(moved, "agent/models.json"), "utf8"));
  assert.equal(config.providers[added.server.id].apiKey, f.state.key);
  assert.equal((await store.getModelServers())[0].apiKeyConfigured, true);
});

test("authoritative discovery replaces removed models and updates metadata without rewriting unchanged data", async t => {
  const f = await fixture(t); const added = await f.add();
  f.state.ids = ["new-model"]; f.state.context = 16384;
  await f.store.refreshModelServers(true);
  const current = (await f.store.getModelServers())[0];
  assert.equal(current.id, added.server.id);
  assert.deepEqual(current.models.map(model => model.id), ["new-model"]);
  assert.equal(current.models[0].contextWindow, 16384);
  const file = path.join(f.data, "agent/models.json");
  await f.store.refreshModelServers(true);
  const before = await stat(file, { bigint: true });
  await f.store.refreshModelServers(true);
  assert.equal((await stat(file, { bigint: true })).mtimeNs, before.mtimeNs);
});

test("offline and unauthorized discovery responses never erase saved models or credentials", async t => {
  const f = await fixture(t); await f.add();
  for (const status of [500, 401]) {
    f.state.status = status;
    const before = await f.store.getAgentConfiguration();
    await f.store.refreshModelServers(true);
    assert.equal((await f.store.getAgentConfiguration()).revision, before.revision);
    assert.deepEqual((await f.store.getModelServers())[0].models.map(model => model.id), ["old-model"]);
  }
});

test("an authoritative empty model list clears stale choices and later loading restores them", async t => {
  const f = await fixture(t); await f.add();
  f.state.ids = [];
  await f.store.refreshModelServers(true);
  assert.deepEqual((await f.store.getModelServers())[0].models, []);
  f.state.ids = ["loaded-later"];
  await f.store.refreshModelServers(true);
  assert.equal((await f.store.getModelServers())[0].models[0].id, "loaded-later");
});

test("explicit credential clearing removes authentication rather than keeping the old password", async t => {
  const f = await fixture(t); const added = await f.add();
  f.state.key = "";
  const result = await f.store.discoverModelServer({ ...f.input, apiKey: "", providerId: added.server.id });
  assert.equal(result.server.apiKeyConfigured, false);
  assert.equal(f.state.requests.at(-1).auth, undefined);
});

test("manual parameter overrides survive refresh while unedited server capabilities remain automatic", async t => {
  const f = await fixture(t); const added = await f.add(); const model = added.server.models[0];
  await f.store.updateConfiguredModel({ ...model, providerId: added.server.id, originalModelId: model.id,
    samplingParams: { temperature: 0.42 } });
  f.state.context = 32768;
  await f.store.refreshModelServers(true);
  const result = (await f.store.getModelServers())[0].models[0];
  assert.deepEqual(result.samplingParams, { temperature: 0.42 });
  assert.equal(result.contextWindow, 32768);
});

test("a manually hidden model does not resurrect during polling, but explicit rediscovery can restore it", async t => {
  const f = await fixture(t); const added = await f.add();
  await f.store.deleteConfiguredModel(added.server.id, "old-model");
  await f.store.refreshModelServers(true);
  assert.deepEqual((await f.store.getModelServers())[0].models, []);
  await f.store.discoverModelServer({ ...f.input, providerId: added.server.id });
  assert.equal((await f.store.getModelServers())[0].models.length, 1);
});

test("concurrent polls share a single discovery and normal polls obey the freshness interval", async t => {
  const f = await fixture(t); await f.add(); f.state.requests.length = 0;
  await Promise.all(Array.from({ length: 12 }, () => f.store.refreshModelServers(true)));
  assert.equal(f.state.requests.length, 3);
  await f.store.refreshModelServers();
  assert.equal(f.state.requests.length, 3);
});

test("model selection never invents removed IDs or silently switches an existing chat to another provider", () => {
  const models = [{ provider: "same-api", id: "new-model" }, { provider: "other-api", id: "different" }];
  assert.deepEqual(selectConfiguredModel(models, "same-api", "old-model"), models[0]);
  assert.equal(selectConfiguredModel(models, "deleted-api", "old-model"), null);
  assert.deepEqual(selectConfiguredModel(models), models[0]);
  assert.equal(selectConfiguredModel([], "same-api", "old-model"), null);
});

test("a failed optional properties endpoint does not erase previously verified reasoning or context", async t => {
  const f = await fixture(t); f.state.reasoning = true; await f.add();
  f.state.propsStatus = 500;
  await f.store.refreshModelServers(true);
  const model = (await f.store.getModelServers())[0].models[0];
  assert.equal(model.reasoning, true);
  assert.equal(model.contextWindow, 8192);
  assert.ok(model.thinkingLevels.includes("off"));
});

test("removed API connections stay identifiable but do not retain their passwords or old models", async t => {
  const f = await fixture(t); const added = await f.add();
  await f.store.deleteModelServer(added.server.id);
  const config = await f.store.getAgentConfiguration();
  assert.ok(config.managedProviders.includes(added.server.id));
  assert.deepEqual(config.models, []);
  assert.ok(!(await readFile(path.join(f.data, "agent/models.json"), "utf8")).includes(f.state.key));
});

const managerSource = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
const start = managerSource.indexOf("  async modelConfigurationChanged(): Promise<void> {");
const body = managerSource.slice(managerSource.indexOf("{", start) + 1, managerSource.indexOf("\n  }", start));
const synchronize = new Function("selectConfiguredModel", "allThinkingLevels", stripTypeScriptTypes(`async function sync(){${body}\n}`) + "; return sync;")(selectConfiguredModel, () => ["off", "low", "medium", "high"]);

test("live catalog synchronization waits for active work, switches only when idle, and never reloads history", async () => {
  const configuration = { revision: "new", models: [{ provider: "api", id: "new-model", thinkingLevels: ["off"] }] };
  const conversation = { id: "chat", provider: "api", model: "old-model" };
  const calls = [], events = [];
  const runtime = { modelsRevision: "old", snapshot: { models: [], state: { isStreaming: true, model: { provider: "api", id: "old-model" } } }, rpc: {
    async request(type, args) { calls.push({ type, args }); return { models: configuration.models, thinkingLevels: ["off"] }; },
  } };
  const host = { modelCatalogSync: Promise.resolve(), runtimes: new Map([["chat", runtime]]),
    store: { async getAgentConfiguration() { return configuration; }, getConversation() { return conversation; }, snapshot() { return { activeConversationId: "chat" }; } },
    async refreshState() { return runtime.snapshot.state = { model: configuration.models[0], thinkingLevel: "off", isStreaming: false }; },
    async updateConversation(_id, changes) { Object.assign(conversation, changes); }, publish(_type, event) { events.push(event); },
  };
  await synchronize.call(host);
  assert.deepEqual(calls, []);
  runtime.snapshot.state.isStreaming = false;
  await synchronize.call(host);
  assert.deepEqual(calls, [{ type: "desktop_refresh_models", args: { provider: "api", modelId: "new-model" } }]);
  assert.equal(conversation.model, "new-model");
  assert.equal(runtime.modelsRevision, "new");
  assert.equal(events[0].event.type, "desktop_models_update");
  await synchronize.call(host);
  assert.equal(calls.length, 1);
});
