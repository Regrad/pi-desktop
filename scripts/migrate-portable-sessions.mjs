import { copyFile, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { migratePortableSessions, storedSessionReference } from "../electron/portable-sessions.ts";

const args = process.argv.slice(2);
const dataIndex = args.indexOf("--data");
const legacyIndex = args.indexOf("--legacy");
if (dataIndex < 0 || !args[dataIndex + 1]) throw new Error("Use --data <Pi Desktop data folder> [--legacy <old sessions folder>] [--write-index]");
const dataDir = path.resolve(args[dataIndex + 1]);
const legacyRoot = legacyIndex >= 0 ? path.resolve(args[legacyIndex + 1]) : path.join(os.homedir(), ".pi", "agent", "sessions");
const statePath = path.join(dataDir, "desktop-state.json");
const original = await readFile(statePath, "utf8");
const state = JSON.parse(original);
if (!Array.isArray(state.conversations)) throw new Error("Invalid chat index");
const migrated = await migratePortableSessions(dataDir, state.conversations, legacyRoot);
if (args.includes("--write-index")) {
  // Never edit an index concurrently changed by a running application.
  if (await readFile(statePath, "utf8") !== original) throw new Error("Chat index changed during migration; close Pi Desktop and retry");
  await copyFile(statePath, statePath + ".before-portable-sessions", constants.COPYFILE_EXCL).catch(error => {
    if (error.code !== "EEXIST") throw error;
  });
  state.conversations = migrated.conversations.map(conversation => ({
    ...conversation,
    sessionFile: conversation.sessionFile ? storedSessionReference(dataDir, conversation.sessionFile) : undefined,
  }));
  const temporary = statePath + ".migration.tmp";
  await writeFile(temporary, JSON.stringify(state, null, 2) + "\n", "utf8");
  await rename(temporary, statePath);
}
console.log(JSON.stringify({
  copied: migrated.copied,
  chats: migrated.conversations.length,
  withHistory: migrated.conversations.filter(conversation => conversation.sessionFile && !migrated.missing.includes(conversation.id)).length,
  missing: migrated.missing,
  indexUpdated: args.includes("--write-index"),
}, null, 2));
