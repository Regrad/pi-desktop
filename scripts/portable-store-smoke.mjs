import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { DataStore } from "../dist-electron/electron/data-store.js";

const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-portable-store-smoke-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
try {
  const legacyAgent = path.join(temporary, "legacy-agent");
  const legacyDir = path.join(legacyAgent, "sessions", "--old-project--");
  process.env.PI_CODING_AGENT_DIR = legacyAgent;
  const firstData = path.join(temporary, "first", "data");
  const id = randomUUID();
  const manager = SessionManager.create(temporary, legacyDir, { id });
  manager.appendMessage({ role: "user", content: "Previous history", timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Previous answer" }], api: "openai-completions", provider: "test", model: "test", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
  await mkdir(firstData, { recursive: true });
  const originalState = {
    version: 4, projects: [],
    conversations: [{ id, title: "Preserved title", sessionFile: manager.getSessionFile(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "idle", archived: true }],
    queuedPrompts: {}, compactions: {},
  };
  await writeFile(path.join(firstData, "desktop-state.json"), JSON.stringify(originalState), "utf8");
  const first = new DataStore(firstData, process.cwd(), process.execPath);
  await first.initialize();
  assert.ok(first.sessionsDir.startsWith(firstData));
  assert.equal(first.getConversation(id).title, "Preserved title");
  assert.equal(first.getConversation(id).archived, true);
  const state = JSON.parse(await readFile(path.join(firstData, "desktop-state.json"), "utf8"));
  assert.ok(state.conversations[0].sessionFile.startsWith("agent/sessions/"));
  assert.equal(path.isAbsolute(state.conversations[0].sessionFile), false);
  assert.deepEqual(JSON.parse(await readFile(path.join(firstData, "desktop-state.json.before-portable-sessions"), "utf8")), originalState);
  const movedData = path.join(temporary, "other-drive", "data");
  await cp(firstData, movedData, { recursive: true });
  await rm(firstData, { recursive: true, force: true });
  await rm(legacyAgent, { recursive: true, force: true });
  const moved = new DataStore(movedData, process.cwd(), process.execPath);
  await moved.initialize();
  const file = moved.getConversation(id).sessionFile;
  assert.ok(file.startsWith(movedData));
  assert.equal(moved.assertManagedSessionFile(file), file);
  const resumed = SessionManager.open(file, moved.getSessionDir(temporary), temporary);
  assert.equal(resumed.buildSessionContext().messages.length, 2);
  resumed.appendMessage({ role: "user", content: "Continued after moving", timestamp: 3 });
  assert.equal(SessionManager.open(file).buildSessionContext().messages.length, 3);
  console.log("DataStore startup, migration, backup, relative index, relocation and Pi continuation verified");
} finally {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(temporary, { recursive: true, force: true });
}
