import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { SessionManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { sessionHistoryTargets, selectHistoryTarget, historyHasLaterMessages } from "../shared/session-history.ts";
import { historyWorkState } from "../shared/history-work-state.ts";
import { historyImageAttachments, imageAttachmentPrompt } from "../shared/image-attachments.ts";

const source = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
test("rewind action requires later conversation, not just hidden service snapshots", () => {
  const messages = [{ role: "user" }, { role: "assistant" }, { role: "custom", display: false }];
  assert.equal(historyHasLaterMessages(messages, 0), true);
  assert.equal(historyHasLaterMessages(messages, 1), false);
  assert.equal(historyHasLaterMessages([{ role: "user" }], 0), false);
  for (const role of ["user", "assistant", "toolResult", "tool"])
    assert.equal(historyHasLaterMessages([{ role: "assistant" }, { role }], 0), true);
  assert.equal(historyHasLaterMessages([{ role: "assistant" }, { role: "custom", display: true }], 0), true);
});
const start = source.indexOf("  private async changeHistory(");
const signature = "): Promise<ConversationSnapshot> {";
const bodyStart = source.indexOf(signature, start) + signature.length;
const bodyEnd = source.indexOf("\n  }", bodyStart);
assert.ok(start >= 0 && bodyStart > start && bodyEnd > bodyStart);
const changeHistory = new Function("SessionManager", "selectHistoryTarget", "historyImageAttachments", "existsSync", "historyWorkState",
  `${stripTypeScriptTypes(`async function changeHistory(conversationId, entryId, text) {${source.slice(bodyStart, bodyEnd)}\n}`)}; return changeHistory;`,
)(SessionManager, selectHistoryTarget, historyImageAttachments, () => true, historyWorkState);

function fixture() {
  const folder = mkdtempSync(path.join(tmpdir(), "pi-history-test-"));
  const manager = SessionManager.create(folder, folder);
  let timestamp = Date.now();
  const user = text => manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: timestamp++ });
  const assistant = text => manager.appendMessage({ role: "assistant", content: [{ type: "text", text }], timestamp: timestamp++, stopReason: "stop" });
  const first = user("First request"), answer = assistant("First answer"), last = user("Second request"), final = assistant("Second answer");
  const conversation = { id: "chat", status: "idle", sessionFile: manager.getSessionFile(), goal: { status: "paused" } };
  let queued = [{ id: "queued" }];
  const sends = [], events = [], stopped = [];
  const context = {
    historyMutations: new Set(), goalLaunching: new Set(), goalContinuationRequested: new Set(["chat"]), runtimes: new Map(),
    store: {
      getConversation() { return conversation; }, async getConversationWorkingDirectory() { return folder; },
      getSessionDir() { return folder; }, assertManagedSessionFile(file) { assert.equal(file, conversation.sessionFile); return file; },
      getQueuedPrompts() { return queued; }, async removeQueuedPrompt(_id, id) { queued = queued.filter(item => item.id !== id); },
    },
    async stopConversation(id) { stopped.push(id); },
    async updateConversation(_id, patch) { Object.assign(conversation, patch); },
    async previewConversation() {
      const current = SessionManager.open(conversation.sessionFile, folder, folder);
      return { conversation, messages: current.buildSessionContext().messages,
        historyTargets: sessionHistoryTargets(current.buildSessionContext().messages, current.getBranch()) };
    },
    publish(channel, payload) { events.push({ channel, payload }); },
    async sendPrompt(...args) { sends.push(args); },
    async refreshState(_id, runtime) { return runtime.snapshot.state; },
  };
  return { manager, folder, first, answer, last, final, conversation, context, sends, events, stopped, user, assistant,
    reopen: () => SessionManager.open(conversation.sessionFile, folder, folder) };
}

test("context targets use entry IDs and only the last user message is editable", () => {
  const f = fixture();
  const targets = sessionHistoryTargets(f.manager.buildSessionContext().messages, f.manager.getBranch());
  assert.deepEqual(targets.map(t => t.entryId), [f.first, f.answer, f.last, f.final]);
  assert.deepEqual(targets.filter(t => t.editable).map(t => t.entryId), [f.last]);
  assert.throws(() => selectHistoryTarget(f.manager.getBranch(), f.first, true), /последнее/);
});

test("history matching serializes each selectable message once and skips tool image payloads", () => {
  let serializations = 0;
  const messages = Array.from({ length: 100 }, (_, index) => ({ role: "assistant", content: `answer-${index}`,
    toJSON() { serializations++; return { role: this.role, content: this.content }; } }));
  const branch = messages.map((message, index) => ({ type: "message", id: `e${index}`, parentId: null, message }));
  const tool = { role: "toolResult", content: [{ type: "image", data: "large" }], toJSON() { throw new Error("Tool result must not be serialized for history matching"); } };
  const targets = sessionHistoryTargets([...messages, tool], [...branch, { type: "message", id: "tool", parentId: null, message: tool }]);
  assert.equal(targets.length, 100);
  assert.equal(serializations, 200);
});

test("identical messages map to distinct entries in branch order; synthetic and tool-call messages are excluded", () => {
  const message = { role: "assistant", content: [{ type: "text", text: "same" }] };
  const branch = ["first", "second"].map(id => ({ type: "message", id, parentId: null, message }));
  assert.deepEqual(sessionHistoryTargets([structuredClone(message), structuredClone(message), message], branch).map(target => target.entryId), ["first", "second"]);
  assert.deepEqual(sessionHistoryTargets([{ role: "assistant", content: "synthetic" }, { role: "assistant", content: [{ type: "toolCall" }] }], branch), []);
});

for (const where of ["first", "answer", "last"]) {
  test(`rewind to ${where} persists, keeps selected message, and preserves old branch bytes`, async () => {
    const f = fixture(), before = readFileSync(f.conversation.sessionFile, "utf8");
    const snapshot = await changeHistory.call(f.context, "chat", f[where]);
    const reopened = f.reopen();
    assert.ok(readFileSync(f.conversation.sessionFile, "utf8").startsWith(before));
    assert.equal(reopened.getEntries().some(entry => entry.id === f.final), true);
    assert.equal(reopened.getBranch().at(-1).customType, "pi_desktop_history_position");
    const expected = { first: 1, answer: 2, last: 3 }[where];
    assert.equal(reopened.buildSessionContext().messages.length, expected);
    assert.equal(snapshot.messages.length, expected);
    assert.equal(snapshot.historyTargets.at(-1).entryId, f[where]);
    assert.equal(f.context.store.getQueuedPrompts().length, 0);
    assert.equal(f.conversation.goal, undefined);
    assert.equal(f.context.goalContinuationRequested.has("chat"), false);
    assert.deepEqual(f.sends, []);
    assert.equal(f.events[0].payload.event.type, "desktop_history_rewound");
    assert.equal(f.context.historyMutations.size, 0);
  });
}

test("editing branches before last user and resends revised text", async () => {
  const f = fixture();
  await changeHistory.call(f.context, "chat", f.last, "Revised request");
  assert.equal(f.reopen().buildSessionContext().messages.length, 2);
  assert.deepEqual(f.sends[0], ["chat", "Revised request", [], undefined, undefined, true]);
  assert.equal(f.reopen().getEntries().some(entry => entry.id === f.last), true);
});

test("editing restores earlier plan and goal, not changes in the discarded answer", async () => {
  const f = fixture();
  const plan = { steps: [{ step: "Original work", status: "in_progress" }], execution: "active", revision: 2, updatedAt: new Date().toISOString() };
  const goal = { id: "goal", objective: "Original objective", status: "active", steps: 1, updatedAt: new Date().toISOString() };
  f.manager.appendMessage({ role: "toolResult", toolName: "update_plan", toolCallId: "p", content: [{ type: "text", text: JSON.stringify({ plan }) }], timestamp: Date.now() });
  f.manager.appendMessage({ role: "toolResult", toolName: "create_goal", toolCallId: "g", content: [{ type: "text", text: JSON.stringify({ goal }) }], timestamp: Date.now() });
  const editable = f.user("Continue");
  f.manager.appendMessage({ role: "toolResult", toolName: "update_plan", toolCallId: "p2", content: [{ type: "text", text: JSON.stringify({ plan: { ...plan, steps: [{ step: "Discarded work", status: "completed" }], revision: 3 } }) }], timestamp: Date.now() });
  f.assistant("Discarded answer");
  f.conversation.plan = { ...plan, revision: 3 };
  await changeHistory.call(f.context, "chat", editable, "Revised continue");
  assert.equal(f.conversation.plan.steps[0].step, "Original work");
  assert.equal(f.conversation.plan.execution, "paused");
  assert.equal(f.conversation.plan.revision, 4);
  assert.equal(f.conversation.goal.objective, "Original objective");
  assert.equal(f.conversation.goal.status, "paused");
  assert.equal(f.reopen().getBranch().at(-1).data.workState.plan.revision, 4);
});

test("editing first message persists empty context, without an abandoned summary", async () => {
  const f = fixture();
  await changeHistory.call(f.context, "chat", f.first);
  await changeHistory.call(f.context, "chat", f.first, "Replacement first request");
  assert.deepEqual(f.reopen().buildSessionContext().messages, []);
  assert.equal(f.reopen().getBranch().length, 1);
  assert.equal(f.sends[0][1], "Replacement first request");
});

test("rejects abandoned entries and non-last edits before stopping runtime", async () => {
  const f = fixture();
  await assert.rejects(changeHistory.call(f.context, "chat", f.first, "No"), /последнее/);
  assert.deepEqual(f.stopped, []);
  await changeHistory.call(f.context, "chat", f.answer);
  await assert.rejects(changeHistory.call(f.context, "chat", f.last), /текущей ветке/);
  assert.equal(f.context.historyMutations.size, 0);
});

test("rejects busy runtime, starting chat, goal launch and concurrent mutations", async () => {
  for (const busy of ["streaming", "starting", "working", "goal", "mutation"]) {
    const f = fixture();
    if (busy === "streaming") f.context.runtimes.set("chat", { eventQueue: Promise.resolve(), snapshot: { state: { isStreaming: true } } });
    else if (busy === "goal") f.context.goalLaunching.add("chat");
    else if (busy === "mutation") f.context.historyMutations.add("chat");
    else f.conversation.status = busy;
    const before = readFileSync(f.conversation.sessionFile, "utf8");
    await assert.rejects(changeHistory.call(f.context, "chat", f.answer));
    assert.equal(readFileSync(f.conversation.sessionFile, "utf8"), before);
    assert.deepEqual(f.stopped, []);
  }
});

test("excludes incomplete tool-call messages from rollback targets", () => {
  const f = fixture();
  const id = f.manager.appendMessage({ role: "assistant", timestamp: Date.now(), content: [{ type: "text", text: "Running" }, { type: "toolCall", id: "tool", name: "bash", arguments: {} }] });
  assert.equal(sessionHistoryTargets(f.manager.buildSessionContext().messages, f.manager.getBranch()).some(t => t.entryId === id), false);
  assert.throws(() => selectHistoryTarget(f.manager.getBranch(), id, false));
});

test("compaction maps kept messages, and rollback does not resurrect abandoned compactions", async () => {
  const f = fixture();
  const compactionId = f.manager.appendCompaction("Summary", f.last, 10000);
  const context = f.manager.buildSessionContext();
  const targets = sessionHistoryTargets(context.messages, f.manager.buildContextEntries());
  assert.deepEqual(targets.map(t => t.entryId), [f.last, f.final]);
  assert.equal(targets[0].messageIndex, 1); // Index zero is the synthetic summary, not an actionable message.
  await changeHistory.call(f.context, "chat", f.answer);
  const reopened = f.reopen();
  assert.equal(reopened.getBranch().some(entry => entry.id === compactionId), false);
  assert.equal(reopened.buildSessionContext().messages.some(message => message.role === "compactionSummary"), false);
});

test("editing retains image bytes, original paths, names and mask pairing", () => {
  const original = [
    { id: "source", name: "Фото.png", path: "C:\\gone\\photo.png", data: "photo-bytes", mimeType: "image/png" },
    { id: "mask", name: "Маска.png", path: "clipboard:mask", data: "mask-bytes", mimeType: "image/png", maskFor: "source" },
  ];
  const restored = historyImageAttachments({ content: [{ type: "text", text: `Edit me${imageAttachmentPrompt(original)}` }, ...original.map(({ data, mimeType }) => ({ type: "image", data, mimeType }))] });
  assert.equal(restored.length, 2);
  assert.equal(restored[0].data, "photo-bytes");
  assert.equal(restored[0].path, original[0].path);
  assert.equal(restored[0].name, "Фото.png");
  assert.equal(restored[1].maskFor, restored[0].id);
  assert.equal(restored[1].data, "mask-bytes");
});

test("IPC, preload and browser backend expose both history actions", () => {
  for (const file of ["electron/main.ts", "electron/preload.cts", "electron/web-backend.ts", "shared/types.ts"])
    assert.match(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), /rewindConversation[\s\S]*editLastMessage/);
  const ui = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(ui, /aria-modal="true"/);
  assert.match(ui, /изменения файлов и созданные медиа не отменяются/);
});
