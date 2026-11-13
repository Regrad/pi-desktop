import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { applyMessagePatch } from "../shared/message-sync.ts";

const bridge = readFileSync(new URL("../resources/pi-engine/protocol.js", import.meta.url), "utf8");
const factorySource = bridge.slice(bridge.indexOf("export function createMessageSync()"), bridge.indexOf("function resolveModelFilePath"));
const createMessageSync = new Function("crypto", `${factorySource.replace("export ", "")}; return createMessageSync;`)({ randomUUID });

test("RPC acknowledges unchanged finalized history without serializing images", () => {
  const sync = createMessageSync();
  const messages = [{ role: "user", content: "hello" }, { role: "toolResult", content: [{ type: "image", data: "a".repeat(1000000) }] }];
  const initial = sync.read(messages);
  assert.equal(initial.startIndex, 0);
  assert.deepEqual(initial.messages, messages);
  const unchanged = sync.read(messages, initial.messageIds);
  assert.equal(unchanged.startIndex, 2);
  assert.deepEqual(unchanged.messages, []);
  assert.ok(JSON.stringify(unchanged).length < 300);
  assert.equal(applyMessagePatch(messages, unchanged), messages);
});

test("unseen custom metadata is appended; event IDs acknowledge already received final messages", () => {
  const sync = createMessageSync();
  const messages = [{ role: "user", content: "hello" }];
  const initial = sync.read(messages);
  const answer = { role: "assistant", content: "answer" };
  messages.push(answer);
  initial.messageIds.push(sync.id(answer));
  const metadata = { role: "custom", display: false, content: "plan state" };
  messages.push(metadata);
  const patch = sync.read(messages, initial.messageIds);
  assert.equal(patch.startIndex, 2);
  assert.deepEqual(patch.messages, [metadata]);
  assert.deepEqual(applyMessagePatch(messages.slice(0, 2), patch), messages);
});

test("persisted custom projections keep identity across rebuilds, but context edits invalidate it", () => {
  const sync = createMessageSync();
  const custom = { role: "custom", content: "plan", display: false };
  const emittedId = sync.id(custom, "entry::0");
  const recreated = { ...custom };
  const first = sync.read([recreated], [emittedId], ["entry::0"]);
  assert.deepEqual(first.messages, []);
  assert.deepEqual(sync.read([{ ...custom }], first.messageIds, ["entry::0"]).messages, []);
  assert.equal(sync.read([{ ...custom, content: "revised" }], first.messageIds, ["entry:edit-id:0"]).startIndex, 0);
});

test("compaction, earlier replacements, trimming and new runtime force authoritative reset", () => {
  const sync = createMessageSync();
  const messages = [{ role: "user", content: "old" }, { role: "assistant", content: "answer" }];
  const oldIds = sync.read(messages).messageIds;
  for (const changed of [[{ role: "user", content: "summary" }, messages[1]], messages.slice(0, 1), []]) {
    const patch = sync.read(changed, oldIds);
    assert.equal(patch.startIndex, 0);
    assert.deepEqual(applyMessagePatch(messages, patch), changed);
  }
  assert.equal(createMessageSync().read(messages, oldIds).startIndex, 0);
  assert.equal(sync.read(messages, ["wrong", oldIds[1]]).startIndex, 0);
  assert.throws(() => applyMessagePatch(messages, { startIndex: 1, messages: [] }), /prefix/);
});

const manager = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
const refreshStart = manager.indexOf("  private async refreshRuntimeSnapshot(");
const refreshBody = manager.indexOf(" {", refreshStart) + 2;
const refreshEnd = manager.indexOf("\n  }", refreshBody);
const refresh = new Function("applyMessagePatch", "preserveKnownContextUsage", `${stripTypeScriptTypes(`async function refresh(runtime) {${manager.slice(refreshBody, refreshEnd)}\n}`)}; return refresh;`)(applyMessagePatch, state => state);

test("host preserves history identity on settlement and requests only unacknowledged messages", async () => {
  const messages = [{ role: "user", content: "test" }];
  const calls = [];
  const runtime = { messageIds: ["runtime:1"], extensionErrors: [], extensionUi: {}, snapshot: { messages, state: {}, conversation: { id: "chat" } },
    rpc: { async request(name, args) { calls.push([name, args]); return name === "get_messages" ? { startIndex: 1, messages: [], messageIds: ["runtime:1"] } : name === "get_session_entries" ? { entries: [] } : {}; } } };
  const host = { normalizeState: state => state, async getHistoryTargets() { return []; }, store: { getCompactions() { return []; } } };
  assert.equal(await refresh.call(host, runtime), undefined);
  assert.equal(runtime.snapshot.messages, messages);
  assert.deepEqual(calls.find(([name]) => name === "get_messages")[1], { knownMessageIds: ["runtime:1"] });
  const settled = manager.slice(manager.indexOf('} else if (event.type === "agent_settled")'), manager.indexOf('} else if (', manager.indexOf('} else if (event.type === "agent_settled")') + 15));
  assert.match(settled, /messagePatch,/);
  assert.doesNotMatch(settled, /messages: runtime\.snapshot\?\.messages/);
});

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const handlerStart = app.indexOf("  const handlePiEvent = (event: JsonObject) => {");
const handlerBody = app.indexOf("=> {", handlerStart) + 4;
const handlerEnd = app.indexOf("\n  };", handlerBody);
const handlerSource = stripTypeScriptTypes(`function handle(event) {${app.slice(handlerBody, handlerEnd)}\n}`);
function renderer() {
  let messages = [], recoveries = 0;
  const noop = () => {};
  const bindings = { setMessages: update => { messages = typeof update === "function" ? update(messages) : update; }, setStreamingMessage: noop,
    setWorking: noop, setWorkingMessage: noop, setTools: noop, setSnapshot: noop, setElapsed: noop, setLastDuration: noop,
    startedAtRef: {}, messageText: message => String(message.content), applyMessagePatch,
    queueMicrotask: callback => callback(), recoverConversationHistory: () => { recoveries++; } };
  const handle = new Function(...Object.keys(bindings), `${handlerSource}; return handle;`)(...Object.values(bindings));
  return { handle, get messages() { return messages; }, get recoveries() { return recoveries; } };
}

test("renderer commits tool results once and no-op settlement keeps the transcript identity", () => {
  const view = renderer();
  const tool = { role: "toolResult", content: "result", toolCallId: "id" };
  view.handle({ type: "message_start", message: tool });
  assert.equal(view.messages.length, 0);
  view.handle({ type: "message_end", message: tool });
  assert.equal(view.messages.length, 1);
  const before = view.messages;
  view.handle({ type: "agent_settled", messageCount: 1 });
  assert.equal(view.messages, before);
  assert.equal(view.recoveries, 0);
});

test("renderer applies appended hidden metadata and resets after context replacement", () => {
  const view = renderer();
  view.handle({ type: "message_start", message: { role: "user", content: "request" } });
  view.handle({ type: "agent_settled", messagePatch: { startIndex: 1, messages: [{ role: "custom", display: false }] }, messageCount: 2 });
  assert.equal(view.messages.length, 2);
  view.handle({ type: "agent_settled", messagePatch: { startIndex: 0, messages: [{ role: "system", content: "summary" }] }, messageCount: 1 });
  assert.equal(view.messages[0].content, "summary");
  assert.equal(view.recoveries, 0);
});

test("renderer detects missed stream events and requests a bounded full recovery", () => {
  const view = renderer();
  view.handle({ type: "agent_settled", messageCount: 2 });
  assert.equal(view.recoveries, 1);
  view.handle({ type: "agent_settled", messagePatch: { startIndex: 2, messages: [{ role: "assistant" }] }, messageCount: 3 });
  assert.equal(view.recoveries, 2);
  assert.equal(view.messages.length, 0);
});
