import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import http from "node:http";

const bridge = readFileSync("resources/pi-engine/protocol.js", "utf8");
const titleStart = bridge.indexOf("export async function generateChatTitle");
const titleEnd = bridge.indexOf("\n}\n", titleStart) + 2;
const generateChatTitle = new Function(`${bridge.slice(titleStart, titleEnd).replace("export ", "")};return generateChatTitle;`)();
const source = readFileSync("electron/pi-manager.ts", "utf8");
function method(name, params, bindings = {}) {
  const start = source.indexOf(`async ${name}(`), begin = source.indexOf("> {", start) + 3, end = source.indexOf("\n  }", begin);
  assert.ok(start >= 0 && begin > start && end > begin);
  const code = stripTypeScriptTypes(`async function run(${params}) {${source.slice(begin, end)}\n}`);
  return new Function(...Object.keys(bindings), `${code};return run;`)(...Object.values(bindings));
}
const nameConversation = method("nameConversation", "conversationId, runtime, message");
const sendPrompt = method("sendPrompt", "conversationId, message, attachments, behavior, expectedGoalId, historyEdit = false, requestPlan = false, expectedPlanRevision", {
  isPlanning: () => false, imageAttachmentPrompt: () => "",
});
function fixture(generate = async () => ({ title: "Ускорение запуска приложения" })) {
  const chat = { id: "chat", title: "Новый чат" }, calls = [], events = [];
  const runtime = { snapshot: { messages: [], state: { isStreaming: false } }, extensionUi: {},
    diffTracker: { covers: () => true, async beginRun() {}, close() {} },
    rpc: { async request(type, payload) { calls.push([type, payload]); return type === "desktop_generate_chat_title" ? generate() : {}; } } };
  const host = { runtimes: new Map([["chat", runtime]]), startupEpochs: new Map(), planningTransitions: new Set(), historyMutations: new Set(),
    store: { getConversation: () => chat, async saveConversationRun() {}, async getConversationWorkspacePaths() { return []; } },
    async ensureRuntime() { return runtime; }, async getModelServers() {}, async reloadPendingInstructions() {},
    async updateConversation(_id, changes) { Object.assign(chat, changes); calls.push(["persist", changes]); },
    publish(_name, payload) { events.push(payload.event); }, nameConversation };
  return { host, chat, runtime, calls, events, send: () => sendPrompt.call(host, "chat", "Почему приложение долго запускается?", []) };
}

test("title completion contains only the first message, no tools or conversation history", async () => {
  let captured;
  const session = { model: { id: "selected" }, modelRuntime: { async completeSimple(...args) { captured = args;
    return { stopReason: "stop", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "  «Ускорение\nзапуска приложения»  " }] }; } } };
  const title = await generateChatTitle(session, "Почему приложение долго запускается?", new AbortController().signal);
  assert.equal(title, "Ускорение запуска приложения");
  assert.equal(captured[0], session.model);
  assert.equal(captured[1].messages.length, 1);
  assert.equal(captured[1].messages[0].content, "Почему приложение долго запускается?");
  assert.equal(captured[1].tools, undefined);
  assert.match(captured[1].systemPrompt, /do not answer it/);
});

test("empty/error/aborted title cannot become a chat name", async () => {
  for (const result of [{ stopReason: "stop", content: [] }, { stopReason: "error", errorMessage: "offline", content: [] }]) {
    await assert.rejects(generateChatTitle({ model: {}, modelRuntime: { completeSimple: async () => result } }, "hello", new AbortController().signal));
  }
  const controller = new AbortController(); controller.abort(new Error("stopped"));
  await assert.rejects(generateChatTitle({ model: {}, modelRuntime: { completeSimple: async () => ({ content: [{ type: "text", text: "late" }] }) } }, "hello", controller.signal), /stopped/);
});

test("first send waits for model title and BOTH stores before answering; subsequent messages keep the name", async () => {
  let release;
  const f = fixture(() => new Promise(resolve => { release = resolve; }));
  const pending = f.send();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.calls.map(([type]) => type), ["desktop_generate_chat_title"]);
  assert.equal(f.events.at(-1).type, "desktop_chat_naming");
  release({ title: "Ускорение запуска приложения" }); await pending;
  assert.deepEqual(f.calls.map(([type]) => type), ["desktop_generate_chat_title", "set_session_name", "persist", "prompt"]);
  assert.equal(f.chat.title, "Ускорение запуска приложения");
  await f.send(); assert.equal(f.calls.filter(([type]) => type === "desktop_generate_chat_title").length, 1);
});

test("existing history and custom names are not renamed", async () => {
  for (const history of [false, true]) {
    const f = fixture();
    if (history) f.runtime.snapshot.messages = [{ role: "user", content: "earlier" }]; else f.chat.title = "My title";
    await f.send(); assert.deepEqual(f.calls.map(([type]) => type), ["prompt"]);
  }
});

test("Stop, generation failure and runtime replacement never dispatch a late answer", async () => {
  for (const mode of ["stop", "replace", "failure"]) {
    const f = fixture(async () => {
      if (mode === "stop") f.runtime.runAborted = true;
      if (mode === "replace") f.host.runtimes.delete("chat");
      if (mode === "failure") throw new Error("offline");
      return { title: "Late title" };
    });
    await assert.rejects(f.send());
    assert.deepEqual(f.calls.map(([type]) => type), ["desktop_generate_chat_title"]);
    assert.equal(f.chat.title, "Новый чат"); assert.equal(f.runtime.extensionUi.workingMessage, "");
  }
});

test("manual rename during generation wins", async () => {
  const f = fixture(async () => { f.chat.title = "Manual title"; return { title: "Generated title" }; });
  await f.send(); assert.equal(f.chat.title, "Manual title");
  assert.deepEqual(f.calls.map(([type]) => type), ["desktop_generate_chat_title", "prompt"]);
});

test("actual Pi names before answering with no naming history/events; abort cancels inference", { timeout: 30000 }, async () => {
  const code = stripTypeScriptTypes(readFileSync("electron/pi-rpc-process.ts", "utf8"), { mode: "transform" });
  const { PiRpcProcess } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const folder = mkdtempSync("C:/AI_Temp/pi-title-live-"), agentDir = path.join(folder, "agent"); mkdirSync(agentDir);
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
  const captured = [], events = []; let blockedRequest;
  const blocked = new Promise(resolve => { blockedRequest = resolve; });
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")); captured.push(body);
    if (body.messages.some(message => message.content === "hold")) { blockedRequest(); return; }
    const text = captured.length === 1 ? "Ускорение запуска приложения" : "Ответ пользователю";
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "title-test": { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "test-only",
    models: [{ id: "test", name: "test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }] } } }));
  const app = process.env.PI_TEST_APP_ROOT || process.cwd();
  let settled; const done = new Promise(resolve => { settled = resolve; });
  const rpc = new PiRpcProcess({ executablePath: process.env.PI_TEST_EXECUTABLE || process.execPath, enginePath: path.join(app, "resources/pi-engine/worker.mjs"),
    cwd: folder, agentDir, sessionsDir: path.join(folder, "sessions"), sessionId: "title-test", provider: "title-test", model: "test", isolatedExtensions: [],
    mcpEntryPath: "unused", mcpDirectTools: [], onEvent(event) { events.push(event); if (event.type === "agent_settled") settled(); }, onExtensionUi() {}, onExit() {} });
  try {
    await rpc.start();
    const { title } = await rpc.request("desktop_generate_chat_title", { message: "Почему приложение долго запускается?" }, 15000);
    assert.equal(title, "Ускорение запуска приложения");
    assert.equal((await rpc.request("get_messages")).messages.length, 0);
    assert.equal(events.some(event => ["agent_start", "agent_settled", "message_start"].includes(event.type)), false);
    assert.equal(captured[0].tools?.length || 0, 0);
    await rpc.request("set_session_name", { name: title });
    assert.equal((await rpc.request("get_state")).sessionName, title);
    await rpc.request("prompt", { message: "Почему приложение долго запускается?" }); await done;
    const history = (await rpc.request("get_messages")).messages;
    assert.deepEqual(history.filter(message => message.role !== "system").map(message => message.role), ["user", "assistant"]);
    assert.equal(captured[1].messages.some(message => JSON.stringify(message.content).includes("Create a short descriptive chat title")), false);
    const cancelled = assert.rejects(rpc.request("desktop_generate_chat_title", { message: "hold" }, 5000), /отменена/);
    await blocked; await rpc.request("abort"); await cancelled;
    assert.deepEqual((await rpc.request("get_messages")).messages, history);
    const original = await rpc.request('get_state');
    await rpc.stop();
    await rpc.start();
    assert.equal((await rpc.request('get_state', {}, 30000)).sessionName, title);
    assert.deepEqual((await rpc.request('get_messages')).messages, history);
    await rpc.request('new_session');
    assert.equal((await rpc.request('get_messages')).messages.length, 0);
    await rpc.request('switch_session', {sessionPath: original.sessionFile});
    assert.deepEqual((await rpc.request('get_messages')).messages, history);
  } finally {
    await rpc.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.ok(path.resolve(folder).startsWith(path.resolve("C:/AI_Temp") + path.sep)); rmSync(folder, { recursive: true, force: true });
  }
});
