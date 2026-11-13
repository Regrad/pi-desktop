import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { SessionManager } from "@earendil-works/pi-coding-agent";
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const file = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
    if (existsSync(file)) return next(file.href, context);
  }
  return next(specifier, context);
} });
const { migratePortableSessions, portableSessionsDir, storedSessionReference } = await import("../electron/portable-sessions.ts");

async function fixture(t) {
  const folder = await mkdtemp(path.join(os.tmpdir(), "pi-portable-session-test-"));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const legacy = path.join(folder, "old", "sessions");
  const data = path.join(folder, "first", "data");
  await mkdir(legacy, { recursive: true });
  return { folder, legacy, data };
}

async function createSession(root, cwd, id) {
  const manager = SessionManager.create(cwd, path.join(root, "--project--"), { id });
  manager.appendMessage({ role: "user", content: "Original conversation", timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Original answer" }], api: "openai-completions", provider: "test", model: "test", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
  return manager.getSessionFile();
}

test("migration copies only referenced chats, preserves originals and supports Pi continuation", async (t) => {
  const { folder, legacy, data } = await fixture(t);
  const source = await createSession(legacy, folder, "11111111-1111-4111-8111-111111111111");
  await createSession(legacy, folder, "22222222-2222-4222-8222-222222222222");
  const original = await readFile(source);
  const migrated = await migratePortableSessions(data, [{ id: "11111111-1111-4111-8111-111111111111", sessionFile: source, title: "Keep title", archived: true }], legacy);
  assert.equal(migrated.copied, 1);
  const target = migrated.conversations[0].sessionFile;
  assert.ok(target.startsWith(path.join(data, "chats", migrated.conversations[0].id, "sessions") + path.sep));
  assert.deepEqual(await readFile(target), original);
  assert.deepEqual(await readFile(source), original);
  assert.equal(migrated.conversations[0].archived, true);
  const manager = SessionManager.open(target, path.dirname(target), folder);
  assert.equal(manager.buildSessionContext().messages.length, 2);
  manager.appendMessage({ role: "user", content: "Continued in portable folder", timestamp: 3 });
  assert.equal(SessionManager.open(target).buildSessionContext().messages.length, 3);
  assert.deepEqual(await readFile(source), original);
  const again = await migratePortableSessions(data, migrated.conversations, legacy);
  assert.equal(again.copied, 0);
  assert.equal(SessionManager.open(target).buildSessionContext().messages.length, 3);
});

test("saved relative references reopen after moving to another data directory", async (t) => {
  const { folder, legacy, data } = await fixture(t);
  const id = "33333333-3333-4333-8333-333333333333";
  const source = await createSession(legacy, folder, id);
  const first = await migratePortableSessions(data, [{ id, sessionFile: source }], legacy);
  const stored = storedSessionReference(data, first.conversations[0].sessionFile);
  assert.ok(stored.startsWith(`chats/${id}/sessions/`));
  assert.equal(path.isAbsolute(stored), false);
  const movedData = path.join(folder, "usb-other-drive", "data");
  await cp(data, movedData, { recursive: true });
  await rm(legacy, { recursive: true, force: true });
  await rm(data, { recursive: true, force: true });
  const moved = await migratePortableSessions(movedData, [{ id, sessionFile: stored }], legacy);
  assert.deepEqual(moved.missing, []);
  assert.equal(SessionManager.open(moved.conversations[0].sessionFile).buildSessionContext().messages.length, 2);
  // Compatibility with older indices that stored the previous absolute path.
  const oldAbsolute = await migratePortableSessions(movedData, first.conversations, legacy);
  assert.equal(oldAbsolute.conversations[0].sessionFile, moved.conversations[0].sessionFile);
});

test("portable history wins over stale global history and missing references are retained", async (t) => {
  const { folder, legacy, data } = await fixture(t);
  const id = "44444444-4444-4444-8444-444444444444";
  const source = await createSession(legacy, folder, id);
  const first = await migratePortableSessions(data, [{ id, sessionFile: source }], legacy);
  const target = first.conversations[0].sessionFile;
  SessionManager.open(target).appendMessage({ role: "user", content: "Newer portable message", timestamp: 3 });
  const repeated = await migratePortableSessions(data, [{ id, sessionFile: source }], legacy);
  assert.equal(repeated.copied, 0);
  assert.equal(SessionManager.open(repeated.conversations[0].sessionFile).buildSessionContext().messages.length, 3);
  const missingPath = path.join(legacy, "--gone--", "missing.jsonl");
  const missing = await migratePortableSessions(data, [{ id: "missing", sessionFile: missingPath }], legacy);
  assert.deepEqual(missing.missing, ["missing"]);
  assert.ok(storedSessionReference(data, missing.conversations[0].sessionFile).endsWith("/missing.jsonl"));
});

test("lost references recover by exact id and do not import unrelated global chats", async (t) => {
  const { folder, legacy, data } = await fixture(t);
  const id = "55555555-5555-4555-8555-555555555555";
  await createSession(legacy, folder, id);
  const restored = await migratePortableSessions(data, [{ id }, { id: "new-empty-chat" }], legacy);
  assert.equal(restored.copied, 1);
  assert.equal(SessionManager.open(restored.conversations[0].sessionFile).buildSessionContext().messages.length, 2);
  assert.equal(restored.conversations[1].sessionFile, undefined);
});

test("path traversal and serialization outside portable storage are rejected", async (t) => {
  const { legacy, data } = await fixture(t);
  await assert.rejects(migratePortableSessions(data, [{ id: "bad", sessionFile: "C:/old/sessions/../../secret.jsonl" }], legacy), /Некорректный/);
  assert.throws(() => storedSessionReference(data, path.join(legacy, "other.jsonl")), /вне портативной/);
});
