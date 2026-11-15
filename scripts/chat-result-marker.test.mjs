import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerHooks, stripTypeScriptTypes } from "node:module";

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const file = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
    if (existsSync(file)) return next(file.href, context);
  }
  return next(specifier, context);
}, load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith(".ts")) return result;
  const source = typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
  return { ...result, format: "module", source: stripTypeScriptTypes(source, { mode: "transform", sourceUrl: url }) };
} });

const { DataStore } = await import("../electron/data-store.ts");

// The green dot depends on one storage contract: a finished run stays marked until
// the chat is opened, the mark survives a restart, and opening removes it for good.
test("a reported result stays marked across restarts until the chat is opened", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "pi-result-marker-"));
  const makeStore = () => new DataStore(data, process.cwd(), process.execPath, path.join(data, "shared"));
  const first = makeStore();
  await first.initialize({ refreshSessions: false });
  const chat = await first.createConversation();
  assert.equal(chat.resultUnseen, undefined);

  const finishedAt = new Date().toISOString();
  await first.updateConversation(chat.id, { status: "idle", resultUnseen: finishedAt });
  assert.equal(first.getConversation(chat.id).resultUnseen, finishedAt);

  const reopened = makeStore();
  await reopened.initialize({ refreshSessions: false });
  assert.equal(reopened.getConversation(chat.id).resultUnseen, finishedAt, "The mark survives closing the app");

  // Opening the chat acknowledges the work: the field must not linger as undefined.
  await reopened.updateConversation(chat.id, { resultUnseen: undefined });
  const persisted = JSON.parse(await readFile(path.join(data, "desktop-state.json"), "utf8"));
  const stored = persisted.conversations.find(item => item.id === chat.id);
  assert.equal("resultUnseen" in stored, false, "An acknowledged result leaves no field behind");
  const afterRestart = makeStore();
  await afterRestart.initialize({ refreshSessions: false });
  assert.equal(afterRestart.getConversation(chat.id).resultUnseen, undefined);
});
