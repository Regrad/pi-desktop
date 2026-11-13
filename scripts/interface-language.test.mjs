import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
const { translateUi, normalizeInterfaceLanguage } = await import("../shared/interface-language.ts");
const { englishUi } = await import("../shared/ui-catalog.ts");
const { DataStore } = await import("../electron/data-store.ts");

test("English is the default; translations preserve interpolated user content", () => {
  for (const value of [undefined, null, "", "de", {}, "en"]) assert.equal(normalizeInterfaceLanguage(value), "en");
  assert.equal(normalizeInterfaceLanguage("ru"), "ru");
  assert.equal(translateUi("Настройки", "en"), "Settings");
  assert.equal(translateUi("Настройки", "ru"), "Настройки");
  assert.equal(translateUi("Удалить «{0}»?", "en", "Мой проект {1}"), "Delete “Мой проект {1}”?");
  assert.equal(translateUi("Удалить «{0}»?", "ru", "My project"), "Удалить «My project»?");
  for (const unknown of ["unknown", "constructor", "__proto__"]) assert.equal(translateUi(unknown, "en"), unknown);
});

test("catalog covers literal UI keys and preserves interpolation slots", async () => {
  for (const [key, value] of Object.entries(englishUi)) {
    assert.ok(value.length, key);
    assert.deepEqual([...value.matchAll(/\{\d+\}/g)].map(m => m[0]).sort(), [...key.matchAll(/\{\d+\}/g)].map(m => m[0]).sort(), key);
  }
  const files = (await readdir(new URL("../src/", import.meta.url))).filter(name => /\.(tsx|ts)$/.test(name));
  const missing = [];
  for (const file of files) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
    for (const match of source.matchAll(/\bt\(("(?:\\.|[^"\\])*")/g)) {
      const key = JSON.parse(match[1]);
      if (!Object.hasOwn(englishUi, key)) missing.push(`${file}: ${key}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("language survives reopening the portable store without renaming existing chats", async () => {
  const data = await mkdtemp(path.join(tmpdir(), "pi-language-test-"));
  const makeStore = () => new DataStore(data, process.cwd(), process.execPath, path.join(data, "shared"));
  const first = makeStore();
  await first.initialize({ refreshSessions: false });
  assert.equal(first.snapshot().interfaceLanguage, "en");
  const chat = await first.createConversation();
  assert.equal(chat.titleIsPlaceholder, true);
  await first.updateConversation(chat.id, { title: "Мой русский чат" });
  await first.setInterfaceLanguage("ru");
  await assert.rejects(first.setInterfaceLanguage("de"), /Unsupported interface language/);
  const second = makeStore();
  await second.initialize({ refreshSessions: false });
  assert.equal(second.snapshot().interfaceLanguage, "ru");
  assert.equal(second.getConversation(chat.id).title, "Мой русский чат");
  assert.equal(second.getConversation(chat.id).titleIsPlaceholder, false);
  await second.setInterfaceLanguage("en");
  const persisted = JSON.parse(await readFile(path.join(data, "desktop-state.json"), "utf8"));
  assert.equal(persisted.interfaceLanguage, "en");
  delete persisted.interfaceLanguage;
  await writeFile(path.join(data, "desktop-state.json"), JSON.stringify(persisted));
  const legacy = makeStore();
  await legacy.initialize({ refreshSessions: false });
  assert.equal(legacy.getInterfaceLanguage(), "en");
  assert.equal(legacy.getConversation(chat.id).title, "Мой русский чат");
});
