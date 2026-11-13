import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { SessionManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js";
import { sessionHistoryTargets } from "../shared/session-history.ts";
import { readSessionPreview, listSessions, stopSessionReads } from "../dist-electron/electron/session-read.js";

async function history(t) {
  const directory = await mkdtemp("C:/AI_Temp/pi-history-worker-");
  t.after(async () => {
    await stopSessionReads();
    assert.ok(path.resolve(directory).startsWith(path.resolve("C:/AI_Temp") + path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  const file = path.join(directory, "history.jsonl");
  const timestamp = "2026-11-13T08:00:00.000Z";
  const entries = [{ type: "session", version: 3, id: "test-history", cwd: directory, timestamp }];
  for (let i = 0; i < 300; i++) entries.push({ type: "message", id: `e${i}`, parentId: i ? `e${i-1}` : null, timestamp,
    message: { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `Message ${i}: ${"details ".repeat(800)}` }], timestamp: i,
      ...(i % 2 ? { stopReason: "stop" } : {}) } });
  entries.push({ type: "custom", id: "position", parentId: "e299", timestamp, customType: "pi_desktop_history_position", data: {} });
  await writeFile(file, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n", "utf8");
  return { directory, file };
}

test("worker preserves native session context and history targets while the main loop remains available", async t => {
  const { file, directory } = await history(t);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  let result;
  try { result = await readSessionPreview(file, directory, directory); }
  finally { clearInterval(timer); }
  assert.ok(ticks > 0, "UI/main-process tasks can run during SDK loading and history parsing");
  const manager = SessionManager.open(file, directory, directory);
  const context = manager.buildSessionContext();
  assert.deepEqual(result.messages, context.messages);
  assert.deepEqual(result.entries, manager.getBranch());
  assert.deepEqual(result.historyTargets, sessionHistoryTargets(context.messages, manager.buildContextEntries()));
  assert.equal(result.navigationTimestamp, "2026-11-13T08:00:00.000Z");
});

test("cancelled history stops independently, and sidebar discovery uses the same native metadata", async t => {
  const { file, directory } = await history(t);
  const controller = new AbortController();
  const pending = readSessionPreview(file, directory, directory, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  const sessions = await listSessions(directory, directory);
  assert.deepEqual(sessions, await SessionManager.list(directory, directory));
  assert.equal(sessions.length, 1);
});

test("preview migrates legacy entries in memory without rewriting the file", async t => {
  const { file, directory } = await history(t);
  const legacy = (await readFile(file, "utf8")).replace('"version":3', '"version":2').trimEnd();
  await writeFile(file, legacy, "utf8");
  const result = await readSessionPreview(file, directory, directory);
  assert.equal(result.messages.length, 300);
  assert.equal(await readFile(file, "utf8"), legacy);
});

test("opening another chat cancels the first load without waiting for its history", async () => {
  const source = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
  const start = source.indexOf("  async openConversation(");
  const begin = source.indexOf("): Promise<ConversationSnapshot> {", start) + "): Promise<ConversationSnapshot> {".length;
  const end = source.indexOf("\n  }", begin);
  const code = stripTypeScriptTypes(`async function open(conversationId) {${source.slice(begin,end)}\n}`);
  const open = new Function(`${code}; return open;`)();
  const reads = [];
  const host = { runtimes: new Map(), store: { async activateConversation() {}, getConversation: id => ({id}) },
    async previewConversation(chat, signal) {
      reads.push(chat.id);
      if (chat.id === "slow") return new Promise((_resolve,reject) => signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError"))));
      return { conversation: chat };
    } };
  const slow = open.call(host, "slow");
  await new Promise(resolve => setImmediate(resolve));
  const rejected = assert.rejects(slow, { name: "AbortError" });
  assert.equal((await open.call(host, "fast")).conversation.id, "fast");
  await rejected;
  assert.deepEqual(reads, ["slow", "fast"]);
});
