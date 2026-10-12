import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DataStore } from "../dist-electron/electron/data-store.js";
import { updatedNotebook } from "../dist-electron/shared/notebook.js";

const directory = await mkdtemp(path.join(os.tmpdir(), "pi-notebook-persistence-"));
// Shared mode skips addon installation; the same state writer and reader are used.
const create = () => new DataStore(directory, process.cwd(), process.execPath, directory);
const store = create();
await store.initialize();
const first = await store.createConversation();
const second = await store.createConversation();
const notes = updatedNotebook({ content: "Папка: X:\\KDPI\nURL: https://example.test/kdpi\nПароль: test-only-secret", expectedRevision: 0 });
await store.updateConversation(first.id, { notebook: notes });
let restarted = create();
await restarted.initialize();
assert.deepEqual(restarted.getConversation(first.id).notebook, notes);
assert.equal(restarted.getConversation(second.id).notebook, undefined);
const cleared = updatedNotebook({ content: "", expectedRevision: notes.revision }, notes);
await restarted.updateConversation(first.id, { notebook: cleared });
restarted = create(); await restarted.initialize();
assert.deepEqual(restarted.getConversation(first.id).notebook, cleared);
const disk = JSON.parse(await readFile(path.join(directory, "desktop-state.json"), "utf8"));
assert.equal(disk.conversations.find(chat => chat.id === first.id).notebook.content, "");
console.log("Notebook persistence passed: real DataStore write, restart, isolation and clearing.");
