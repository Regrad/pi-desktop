import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { updatedNotebook, notebookContext, notebookLimit, notebookPolicy, notebookUsage, validateNotebookLimit } from "../shared/notebook.ts";
import { atomicStateWrite } from "../electron/atomic-state.ts";

const hooks = registerHooks({ resolve(specifier, context, next) {
  const local = ["../shared/notebook.js", "../shared/goal.js", "./goal-extension.js", "./state-context.js"];
  return next(local.includes(specifier) ? specifier.replace(/\.js$/, ".ts") : specifier, context);
} });
const { default: notebookExtension, readDesktopNotebook, readDesktopNotebookLimit } = await import("../electron/notebook-extension.ts");
hooks.deregister();

function notebookHostMethods() {
  const source = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
  const start = source.indexOf("  async saveNotebook(");
  const begin = source.indexOf(" {", start) + 2;
  const end = source.indexOf("\n  }", begin);
  const branch = source.indexOf('    if (request.action === "update_notebook")');
  const next = source.indexOf('    if (request.action === "browser")', branch);
  assert.ok(start >= 0 && branch >= 0 && next > branch);
  const code = stripTypeScriptTypes(`async function saveNotebook(conversationId, content, expectedRevision, mutation) {${source.slice(begin, end)}\n}
    async function handleGoalRequest(conversationId, request) {${source.slice(branch, next)}\n}`);
  return new Function("updatedNotebook", "notebookUsage", `${code}; return { saveNotebook, handleGoalRequest };`)(updatedNotebook, notebookUsage);
}

test("configured limits apply to every mutation without truncating existing notes", () => {
  for (const invalid of [0, -1, 1.5, NaN, Infinity, "12000", null]) assert.throws(() => validateNotebookLimit(invalid));
  const larger = updatedNotebook({ content: "x".repeat(15000), expectedRevision: 0 }, undefined, 20000);
  assert.equal(larger.content.length, 15000);
  for (const mutation of [{ content: larger.content }, { append: "x" }, { old_text: larger.content, new_text: "x".repeat(1001) }])
    assert.throws(() => updatedNotebook({ ...mutation, expectedRevision: 1 }, larger, 1000), /1000/);
  assert.equal(larger.content.length, 15000, "Changing the limit must not truncate records");
  const trimmed = updatedNotebook({ old_text: larger.content, new_text: "kept", expectedRevision: 1 }, larger, 1000);
  assert.equal(trimmed.content, "kept");
  assert.equal(updatedNotebook({ content: "", expectedRevision: 1 }, larger, 1).content, "");
});

test("limit context changes append-only without changing tool schemas or repeating on each request", () => {
  let limit = 12000; const handlers = {}, tools = [], sent = [];
  notebookExtension({ on(name, fn) { handlers[name] = fn; }, registerTool(tool) { tools.push(tool); }, sendMessage(message) { sent.push(message); } },
    () => undefined, undefined, () => limit);
  const schema = JSON.stringify(tools[0].parameters);
  let messages = handlers.context({ messages: [{ role: "user", content: "test" }] }).messages;
  assert.equal(sent.length, 1); assert.match(messages.at(-1).content, /12000/);
  assert.deepEqual(handlers.context({ messages }).messages, messages); assert.equal(sent.length, 1);
  limit = 25000;
  const next = handlers.context({ messages }).messages;
  assert.deepEqual(next.slice(0, messages.length), messages); assert.match(next.at(-1).content, /25000/);
  assert.equal(JSON.stringify(tools[0].parameters), schema);
  messages = next;
  assert.deepEqual(handlers.context({ messages }).messages, messages); assert.equal(sent.length, 2);
  limit = 8000;
  messages = handlers.context({ messages }).messages;
  assert.match(messages.at(-1).content, /8000/);
  assert.deepEqual(handlers.context({ messages }).messages, messages);
  assert.equal(sent.length, 3, "lower limits are values, not obsolete revisions");
});

test("snapshot and limit changes supply usage without rewriting history or repeating service messages", () => {
  let limit = 10;
  const notebook = updatedNotebook({ content: "Факт", expectedRevision: 0 });
  const handlers = {}, sent = [];
  notebookExtension({ on(name, handler) { handlers[name] = handler; }, registerTool() {}, sendMessage(message) { sent.push(message); } },
    () => notebook, undefined, () => limit);
  const initial = [{ role: "user", content: "test" }];
  const first = handlers.context({ messages: initial }).messages;
  assert.deepEqual(first.slice(0, initial.length), initial);
  assert.match(first.find(message => message.customType === "desktop_notebook_state").content,
    /"usage":\{"currentChars":4,"limit":10,"remainingChars":6\}/);
  assert.equal(sent.length, 2);
  limit = 3;
  const next = handlers.context({ messages: first }).messages;
  assert.deepEqual(next.slice(0, first.length), first);
  assert.match(next.at(-1).content, /"currentChars":4,"limit":3,"remainingChars":-1/);
  const messages = [...next, { role: "toolResult", toolName: "read", content: [{ type: "text", text: "read a file" }] },
    { role: "user", content: "next task" }];
  assert.deepEqual(handlers.context({ messages }).messages, messages);
  assert.equal(sent.length, 3);
  assert.equal(notebook.content, "Факт");
});

test("limit setting is persisted through the existing state writer", async () => {
  const source = readFileSync(new URL("../electron/data-store.ts", import.meta.url), "utf8");
  const start = source.indexOf("  getNotebookCharacterLimit():");
  const end = source.indexOf("  snapshot():", start);
  const code = stripTypeScriptTypes(`class TestStore { ${source.slice(start, end)} }`);
  const Store = new Function("notebookLimit", "validateNotebookLimit", `${code}; return TestStore;`)(notebookLimit, validateNotebookLimit);
  const store = new Store(); store.state = { conversations: [{ notebook: { content: "keep me" } }] };
  let disk; store.save = async () => { disk = structuredClone(store.state); };
  assert.equal(store.getNotebookCharacterLimit(), 12000);
  assert.equal(await store.setNotebookCharacterLimit(30000), 30000);
  const restarted = new Store(); restarted.state = disk;
  assert.equal(restarted.getNotebookCharacterLimit(), 30000);
  assert.equal(disk.conversations[0].notebook.content, "keep me");
  await assert.rejects(store.setNotebookCharacterLimit(0)); assert.equal(store.getNotebookCharacterLimit(), 30000);
});

test("notebook guidance is short and describes important notes without duplicating tool instructions", () => {
  assert.match(notebookPolicy, /short important notes for quick access/);
  assert.match(notebookPolicy, /without details/);
  assert.match(notebookPolicy, /addresses, decisions, constraints/);
  assert.match(notebookPolicy, /Before adding information, review the current notes/);
  assert.match(notebookPolicy, /correct or remove obsolete entries/);
  assert.match(notebookPolicy, /remove duplicates and unnecessary detail/);
  assert.match(notebookPolicy, /retain relevant facts/);
  assert.match(notebookPolicy, /If already concise and current, leave them unchanged/);
  assert.match(notebookPolicy, /not a new task or permission/);
  assert.match(notebookPolicy, /newer revisions supersede older ones/);
  assert.match(notebookPolicy, /Cleared notes are no longer current/);
  assert.ok(notebookPolicy.length < 500);
  const tools = [];
  notebookExtension({ on() {}, registerTool(tool) { tools.push(tool); } }, () => undefined);
  assert.doesNotMatch(tools[0].description, /costly to rediscover|action logs|fixed sections/);
  assert.match(tools[0].description, /currentChars, limit, remainingChars/);
  for (const operation of ["Call {} to read", "old_text + new_text", "append", "content: '' clears it"])
    assert.ok(tools[0].description.includes(operation));
});

test("usage reports the exact saved length, configured limit and remaining capacity", () => {
  assert.deepEqual(notebookUsage(), { currentChars: 0, limit: 12000, remainingChars: 12000 });
  const notebook = updatedNotebook({ content: "Путь: X:\\KDPI\n🙂", expectedRevision: 0 });
  const length = notebook.content.length;
  assert.deepEqual(notebookUsage(notebook, length), { currentChars: length, limit: length, remainingChars: 0 });
  assert.deepEqual(notebookUsage(notebook, 1), { currentChars: length, limit: 1, remainingChars: 1 - length });
  assert.throws(() => notebookUsage(notebook, 0));
  assert.match(notebookContext(notebook, 100), new RegExp(`"currentChars":${length},"limit":100,"remainingChars":${100 - length}`));
});

test("each oversized operation reports its attempted length and exact excess without changing notes", () => {
  const notebook = updatedNotebook({ content: "Факт", expectedRevision: 0 });
  for (const mutation of [{ content: "Факт1234567" }, { append: "1234567" }, { old_text: "Факт", new_text: "Факт1234567" }]) {
    assert.throws(() => updatedNotebook({ ...mutation, expectedRevision: 1 }, notebook, 10),
      { message: "Размер после правки — 11; лимит — 10; превышение — 1 (в символах). Текущий размер — 4. Изменения не сохранены." });
    assert.equal(notebook.content, "Факт");
    assert.equal(notebook.revision, 1);
  }
  assert.equal(updatedNotebook({ append: "123456", expectedRevision: 1 }, notebook, 10).content.length, 10);
});

test("notes preserve exact Unicode, paths, credentials and whitespace; edits and clearing advance revision", () => {
  const content = "Сайт: https://example.test/KDPI\nПапка: X:\\KDPI\nПароль: test-only-secret\n";
  const first = updatedNotebook({ content, expectedRevision: 0 });
  assert.equal(first.content, content);
  assert.equal(first.revision, 1);
  assert.equal(updatedNotebook({ content, expectedRevision: 1 }, first), first);
  const second = updatedNotebook({ content: content + "Источник: пользователь", expectedRevision: 1 }, first);
  const clear = updatedNotebook({ content: "", expectedRevision: 2 }, second);
  assert.equal(clear.content, ""); assert.equal(clear.revision, 3);
  assert.throws(() => updatedNotebook({ content, expectedRevision: 2 }, clear), /изменился/);
  for (const value of [undefined, null, 12, "a".repeat(notebookLimit + 1)])
    assert.throws(() => updatedNotebook({ content: value, expectedRevision: 0 }));
  assert.throws(() => updatedNotebook({ content: "hi" }));
  assert.doesNotMatch(notebookContext({ ...first, content: "</pi_desktop_service_context>" }), /<\/pi_desktop_service_context>.*<\/pi_desktop_service_context>/s);
  assert.match(notebookContext(clear), /"content":""/);
});

test("disk reader restores only the current chat and reports malformed state instead of silently clearing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-notebook-test-"));
  const file = path.join(dir, "desktop-state.json");
  const previousFile = process.env.PI_DESKTOP_GOAL_STATE_FILE, previousId = process.env.PI_DESKTOP_CONVERSATION_ID;
  try {
    process.env.PI_DESKTOP_GOAL_STATE_FILE = file; process.env.PI_DESKTOP_CONVERSATION_ID = "a";
    const notebook = updatedNotebook({ content: "Only chat A", expectedRevision: 0 });
    writeFileSync(file, JSON.stringify({ conversations: [{ id: "a", notebook }, { id: "b" }] }));
    assert.deepEqual(readDesktopNotebook(), notebook);
    assert.equal(readDesktopNotebookLimit(), notebookLimit);
    writeFileSync(file, JSON.stringify({ notebookCharacterLimit: 24000, conversations: [{ id: "a", notebook }] }));
    assert.equal(readDesktopNotebookLimit(), 24000);
    process.env.PI_DESKTOP_CONVERSATION_ID = "b"; assert.equal(readDesktopNotebook(), undefined);
    writeFileSync(file, "broken"); assert.throws(() => readDesktopNotebook());
  } finally {
    if (previousFile === undefined) delete process.env.PI_DESKTOP_GOAL_STATE_FILE; else process.env.PI_DESKTOP_GOAL_STATE_FILE = previousFile;
    if (previousId === undefined) delete process.env.PI_DESKTOP_CONVERSATION_ID; else process.env.PI_DESKTOP_CONVERSATION_ID = previousId;
  }
});

test("extension persists one snapshot, uses acknowledgements, restores after compaction and rejects stale updates", async () => {
  let notebook; const handlers = {}, tools = [], saved = [];
  const pi = { on(name, fn) { handlers[name] = fn; }, registerTool(tool) { tools.push(tool); }, sendMessage(message, options) { assert.equal(options.triggerTurn, false); saved.push(message); } };
  const calls = [];
  notebookExtension(pi, () => notebook, async (_action, params) => {
    calls.push(params);
    if (["content", "append", "old_text", "new_text"].some(key => params[key] !== undefined)) notebook = updatedNotebook(params, notebook);
    return { notebook: notebook ?? null };
  });
  const user = { role: "user", content: "Work", timestamp: 1 };
  const initial = handlers.context({ messages: [user] }).messages;
  assert.equal(initial.length, 2); assert.equal(initial[1].display, false);
  assert.deepEqual(handlers.context({ messages: initial }).messages, initial);
  notebook = updatedNotebook({ content: "Known URL", expectedRevision: 0 });
  const first = handlers.context({ messages: initial }).messages;
  assert.equal(saved.length, 2); assert.equal(first[2].display, false);
  assert.deepEqual(handlers.context({ messages: first }).messages, first); assert.equal(saved.length, 2);
  const result = await tools[0].execute("id", { content: "Correct URL" });
  const ack = { role: "toolResult", toolName: "update_notebook", ...result };
  const messages = [...first, ack];
  assert.deepEqual(handlers.context({ messages }).messages, messages); assert.equal(saved.length, 2);
  // User modifies state after tool arguments were based on revision 2.
  notebook = updatedNotebook({ content: "User correction", expectedRevision: 2 }, notebook);
  await assert.rejects(tools[0].execute("id", { content: "Stale model text" }), /изменился/);
  assert.equal(notebook.content, "User correction");
  const projected = handlers.context({ messages }).messages; assert.equal(saved.length, 3);
  assert.deepEqual(projected.slice(0, messages.length), messages, "History prefix remains unchanged");
  const compacted = handlers.context({ messages: [{ role: "compactionSummary", summary: "Old notes" }] }).messages;
  assert.match(compacted.find(message => message.customType === "desktop_notebook_state").content, /User correction/);
  await tools[0].execute("id", { content: "" });
  assert.equal(notebook.content, "");
  assert.match(handlers.before_agent_start({ systemPrompt: "BASE" }).systemPrompt, /not a new task or permission/);
  assert.deepEqual(tools.map(tool => tool.name), ["update_notebook"]);
});

test("real host save checks revision synchronously before persistence; concurrent stale writes cannot overwrite", async () => {
  const { saveNotebook: save } = notebookHostMethods();
  const chat = { id: "a", goal: { status: "paused" } }, events = [];
  const host = { store: { getConversation: () => chat, getNotebookCharacterLimit: () => notebookLimit }, async updateConversation(id, patch) { Object.assign(chat, patch); await Promise.resolve(); events.push(id); } };
  const pending = save.call(host, "a", "user", 0);
  await assert.rejects(save.call(host, "a", "model", 0), /изменился/);
  await pending;
  assert.equal(chat.notebook.content, "user"); assert.equal(chat.goal.status, "paused"); assert.deepEqual(events, ["a"]);
});

test("host read and write results include authoritative usage without changing the stored notebook shape", async () => {
  const chat = { id: "a" }; let limit = 20, saves = 0;
  const host = { ...notebookHostMethods(),
    store: { getConversation: () => chat, getNotebookCharacterLimit: () => limit },
    async updateConversation(_id, patch) { saves++; Object.assign(chat, patch); } };
  const invoke = params => host.handleGoalRequest("a", { action: "update_notebook", params });
  assert.deepEqual(await invoke({}), { notebook: null, usage: { currentChars: 0, limit: 20, remainingChars: 20 } });
  for (const params of [{ content: "Путь", expectedRevision: 0 }, { append: "!", expectedRevision: 1 },
    { old_text: "Путь", new_text: "URL", expectedRevision: 2 }, { old_text: "!", new_text: "", expectedRevision: 3 }]) {
    const result = await invoke(params);
    assert.deepEqual(result.usage, notebookUsage(chat.notebook, limit));
    assert.deepEqual(Object.keys(chat.notebook).sort(), ["content", "revision", "updatedAt"]);
  }
  const saved = structuredClone(chat.notebook);
  assert.deepEqual(await invoke({}), { notebook: saved, usage: { currentChars: 3, limit: 20, remainingChars: 17 } });
  const writeCount = saves;
  for (const params of [{ append: "x".repeat(20), expectedRevision: 4 }, { old_text: "missing", new_text: "x", expectedRevision: 4 },
    { append: "x", expectedRevision: 3 }]) {
    await assert.rejects(invoke(params));
    assert.deepEqual(chat.notebook, saved); assert.equal(saves, writeCount);
  }
  limit = 2;
  assert.deepEqual((await invoke({})).usage, { currentChars: 3, limit: 2, remainingChars: -1 });
  assert.deepEqual(chat.notebook, saved); assert.equal(saves, writeCount);
  assert.equal((await invoke({ content: "", expectedRevision: 4 })).usage.currentChars, 0);
});

test("successful notes survive disk reload and rejected writes preserve both disk and memory", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-notebook-reload-"));
  const file = path.join(dir, "desktop-state.json");
  let chat = { id: "a", goal: { status: "paused" } };
  const host = { ...notebookHostMethods(),
    store: { getConversation: () => chat, getNotebookCharacterLimit: () => 100 },
    async updateConversation(_id, patch) {
      Object.assign(chat, patch);
      await atomicStateWrite(file, JSON.stringify({ conversations: [chat], notebookCharacterLimit: 100 }));
    } };
  const invoke = params => host.handleGoalRequest("a", { action: "update_notebook", params });
  const first = await invoke({ content: "Путь: X:\\KDPI\nСайт: https://example.test", expectedRevision: 0 });
  chat = JSON.parse(readFileSync(file, "utf8")).conversations[0];
  assert.deepEqual((await invoke({})).notebook, first.notebook);
  const disk = readFileSync(file, "utf8");
  for (const params of [{ append: "x".repeat(101), expectedRevision: 1 }, { old_text: "missing", new_text: "x", expectedRevision: 1 },
    { append: "stale", expectedRevision: 0 }]) {
    await assert.rejects(invoke(params));
    assert.equal(readFileSync(file, "utf8"), disk);
    assert.deepEqual(chat.notebook, first.notebook);
  }
  await invoke({ content: "", expectedRevision: 1 });
  chat = JSON.parse(readFileSync(file, "utf8")).conversations[0];
  assert.equal((await invoke({})).notebook.content, "");
  assert.equal(chat.goal.status, "paused");
});

test("targeted edits preserve all surrounding text; append is literal; no-op does not advance revision", () => {
  const original = updatedNotebook({ content: "Первое\nКривой фрагмент\nПоследнее $&", expectedRevision: 0 });
  const fixed = updatedNotebook({ old_text: "Кривой фрагмент", new_text: "Верный $& фрагмент", expectedRevision: 1 }, original);
  assert.equal(fixed.content, "Первое\nВерный $& фрагмент\nПоследнее $&");
  const same = updatedNotebook({ old_text: "Первое", new_text: "Первое", expectedRevision: 2 }, fixed);
  assert.equal(same, fixed);
  const deleted = updatedNotebook({ old_text: "Верный $& фрагмент\n", new_text: "", expectedRevision: 2 }, fixed);
  assert.equal(deleted.content, "Первое\nПоследнее $&");
  assert.equal(updatedNotebook({ append: "\nНовая заметка", expectedRevision: 3 }, deleted).content, "Первое\nПоследнее $&\nНовая заметка");
});

test("invalid, ambiguous, stale and oversized patches cannot change saved notes", () => {
  const original = updatedNotebook({ content: "aaa\nrepeat\nrepeat", expectedRevision: 0 });
  for (const patch of [{ old_text: "missing", new_text: "x" }, { old_text: "repeat", new_text: "x" },
    { old_text: "aa", new_text: "x" }, { old_text: "", new_text: "x" }, { old_text: "aaa" },
    { new_text: "x" }, { content: "x", append: "y" }, { append: "x", old_text: "aaa", new_text: "z" },
    { append: "" }, { append: "x".repeat(notebookLimit) }, { old_text: "aaa", new_text: "x".repeat(notebookLimit) }]) {
    assert.throws(() => updatedNotebook({ ...patch, expectedRevision: 1 }, original));
    assert.equal(original.content, "aaa\nrepeat\nrepeat");
    assert.equal(original.revision, 1);
  }
  assert.throws(() => updatedNotebook({ append: "x", expectedRevision: 0 }, original), /изменился/);
  assert.equal(updatedNotebook({ append: "First", expectedRevision: 0 }).content, "First");
});

test("extension forwards partial edits with the observed revision and retains the read operation", async () => {
  let notebook = updatedNotebook({ content: "old", expectedRevision: 0 });
  const tools = [], calls = [];
  notebookExtension({ on() {}, registerTool(tool) { tools.push(tool); } }, () => notebook, async (_action, params) => {
    calls.push(params);
    if (params.expectedRevision !== undefined) notebook = updatedNotebook(params, notebook);
    return { notebook };
  });
  await tools[0].execute("id", { old_text: "old", new_text: "new" });
  assert.deepEqual(calls[0], { old_text: "old", new_text: "new", expectedRevision: 1 });
  await tools[0].execute("id", { append: "\nnext" });
  assert.equal(calls[1].expectedRevision, 2);
  await tools[0].execute("id", {});
  assert.deepEqual(calls[2], {});
  assert.equal(notebook.content, "new\nnext");
});
