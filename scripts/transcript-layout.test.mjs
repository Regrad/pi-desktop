import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf("\nfunction ", start + 1);
  assert.ok(start >= 0 && end > start);
  return stripTypeScriptTypes(source.slice(start, end));
}
const messageKey = new Function(`${extract("messageKey")}; return messageKey;`)();
const hasAnswer = new Function(`${extract("hasAnswerText")}; return hasAnswerText;`)();
const split = new Function("hasAnswerText", `${extract("splitAssistantTimelineItem")}; return splitAssistantTimelineItem;`)(hasAnswer);
const build = new Function("messageKey", "splitAssistantTimelineItem", "hasAnswerText",
  `${extract("buildTranscriptDisplay")}; return buildTranscriptDisplay;`)(messageKey, split, hasAnswer);
const offset = new Function(`${extract("filmScrollOffset")}; return filmScrollOffset;`)();
const item = (sourceIndex, role, content, timestamp = 100) => ({
  kind: "message", sourceIndex, message: { role, timestamp, content },
});
const key = entry => `${messageKey(entry.message, entry.sourceIndex)}:${entry.fragment ?? "whole"}:${entry.fragmentIndex ?? "whole"}`;

test("tool-use commentary remains visible when the next assistant reply arrives", () => {
  const first = item(0, "assistant", [
    { type: "thinking", thinking: "Inspecting the project" },
    { type: "text", text: "Сначала проверю файлы." },
    { type: "toolCall", id: "read-1", name: "read", arguments: {} },
  ]);
  first.message.stopReason = "toolUse";
  const tool = item(1, "toolResult", [{ type: "text", text: "File contents" }]);
  const final = item(2, "assistant", [
    { type: "thinking", thinking: "Checking the result" },
    { type: "text", text: "Проверка завершена." },
  ]);
  const visible = build([first, tool, final]).flatMap(row => {
    const entry = row.display === "fold" ? row.answer : row.item;
    return entry.kind === "message" && entry.message.role === "assistant"
      ? entry.message.content.filter(part => part.type === "text").map(part => part.text) : [];
  });
  assert.deepEqual(visible, ["Сначала проверю файлы.", "Проверка завершена."]);
});

test("timestamps and even repeated external IDs are not React row identities", () => {
  const a = { role: "toolResult", timestamp: 100, id: "same" };
  assert.notEqual(messageKey(a, 0), messageKey(a, 1));
  assert.equal(messageKey(a, 0), messageKey({ ...a, content: "updated" }, 0));
});

test("each direct reply closes its own fold and all fragments have distinct identities", () => {
  const first = item(0, "assistant", [{ type: "thinking", thinking: "Reasoning" }, { type: "text", text: "First answer" }]);
  first.message.stopReason = "toolUse";
  const second = item(1, "assistant", [{ type: "thinking", thinking: "More reasoning" }, { type: "text", text: "Second answer" }]);
  const result = build([first, second]);
  assert.equal(result.length, 2);
  assert.ok(result.every(row => row.display === "fold"));
  const keys = result.flatMap(fold => [...fold.process, fold.answer]).map(key);
  assert.equal(new Set(keys).size, keys.length);
  assert.notEqual(result[0].key, result[1].key);
});

test("completed answer stays visible across checklist continuation and later tool commentary", () => {
  const first = item(0, "assistant", [{ type: "thinking", thinking: "Task one reasoning" }, { type: "text", text: "Task one completed" }]);
  first.message.stopReason = "stop";
  const service = item(1, "custom", [{ type: "text", text: "Continue checklist" }]);
  service.message.display = false;
  const next = item(2, "assistant", [{ type: "text", text: "Starting task two" }, { type: "toolCall", id: "next-tool", name: "read", arguments: {} }]);
  next.message.stopReason = "toolUse";
  const nextThinking = item(3, "assistant", [{ type: "thinking", thinking: "Task two reasoning" }]);
  const final = item(4, "assistant", [{ type: "text", text: "Task two completed" }]);
  final.message.stopReason = "stop";
  for (const tail of [[next], [next, nextThinking], [next, nextThinking, final]]) {
    const rows = build([first, service, ...tail]);
    assert.equal(rows[0].display, "fold");
    assert.equal(rows[0].answer.sourceIndex, first.sourceIndex);
    assert.ok(!rows.some(row => row.display === "fold" && row.process.some(entry => entry.sourceIndex === first.sourceIndex && entry.fragment !== "thinking")));
  }
});

test("consecutive final answers, including legacy messages without stopReason, stay visible", () => {
  const first = item(0, "assistant", [{ type: "thinking", thinking: "First reasoning" }, { type: "text", text: "First result" }]);
  const second = item(1, "assistant", [{ type: "thinking", thinking: "Second reasoning" }, { type: "text", text: "Second result" }]);
  const rows = build([first, second]);
  assert.deepEqual(rows.map(row => row.answer.sourceIndex), [0, 1]);
});

test("live reply after a completed answer cannot replace the completed answer", () => {
  const first = item(0, "assistant", [{ type: "thinking", thinking: "Reasoning" }, { type: "text", text: "Completed result" }]);
  first.message.stopReason = "stop";
  const live = item(1, "assistant", [{ type: "text", text: "New reply still streaming" }]);
  const rows = build([first, live], live.message);
  assert.equal(rows[0].answer.sourceIndex, first.sourceIndex);
  assert.equal(rows[1].item.message, live.message);
});

test("legacy tool-call commentary remains visible even without stopReason", () => {
  const first = item(0, "assistant", [{ type: "thinking", thinking: "Reasoning" }, { type: "text", text: "Reading" }, { type: "tool_call", id: "read" }]);
  const final = item(1, "assistant", [{ type: "text", text: "Completed result" }]);
  final.message.stopReason = "stop";
  const rows = build([first, final]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].answer.sourceIndex, first.sourceIndex);
  assert.equal(rows[1].answer.sourceIndex, final.sourceIndex);
  assert.ok(rows.every(row => row.process.every(entry => !hasAnswer(entry.message))));
});

test("simultaneous tool results remain distinct before and after folding", () => {
  const reasoning = item(0, "assistant", [{ type: "thinking", thinking: "Working" }]);
  const results = [item(1, "toolResult", []), item(2, "toolResult", [])];
  const before = build([reasoning, ...results]);
  const keys = before.map(row => key(row.item));
  assert.equal(new Set(keys).size, keys.length);
  const answer = item(3, "assistant", [{ type: "text", text: "Done" }]);
  const folded = build([reasoning, ...results, answer]);
  assert.equal(folded.length, 1);
  assert.equal(folded[0].process.length, 3);
});

test("live thoughts collapse as text arrives and fragments retain their streaming source", () => {
  const entry = item(0, "assistant", [{ type: "thinking", thinking: "Reasoning" }, { type: "text", text: "Answer" }]);
  const fragments = split(entry);
  assert.equal(fragments.length, 2);
  assert.notEqual(key(fragments[0]), key(fragments[1]));
  assert.ok(fragments.every(fragment => fragment.sourceMessage === entry.message));
  const rows = build([entry]);
  assert.equal(rows[0].display, "fold");
  assert.equal(rows[0].process[0].fragment, "thinking");
  assert.equal(rows[0].answer.fragment, "answer");
});

test("alternating thoughts, text and tools within one message preserve their exact order", () => {
  const content = [
    { type: "thinking", thinking: "First thoughts" },
    { type: "text", text: "Первая реплика" },
    { type: "toolCall", id: "one", name: "read", arguments: {} },
    { type: "thinking", thinking: "Second thoughts" },
    { type: "text", text: "Вторая реплика" },
    { type: "thinking", thinking: "Still working" },
  ];
  const message = item(0, "assistant", content);
  const original = structuredClone(message);
  const rows = build([message]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(row => row.display), ["fold", "fold", "single"]);
  assert.deepEqual(rows[0].process[0].message.content, content.slice(0, 1));
  assert.deepEqual(rows[0].answer.message.content, content.slice(1, 2));
  assert.deepEqual(rows[1].process[0].message.content, content.slice(2, 4));
  assert.deepEqual(rows[1].answer.message.content, content.slice(4, 5));
  assert.deepEqual(rows[2].item.message.content, content.slice(5));
  const flat = rows.flatMap(row => row.display === "fold" ? [...row.process, row.answer] : [row.item]);
  assert.deepEqual(flat.flatMap(fragment => fragment.message.content), content);
  assert.equal(new Set(flat.map(key)).size, flat.length);
  assert.equal(new Set(rows.map(row => row.display === "fold" ? row.key : key(row.item))).size, rows.length);
  assert.deepEqual(flat.filter(fragment => fragment.historyActions).map(fragment => fragment.message.content[0].text), ["Вторая реплика"]);
  assert.deepEqual(message, original, "display grouping cannot mutate session/model history");
});

test("live fragment identities survive appended text, tools and commit", () => {
  const first = item(0, "assistant", [{ type: "thinking", thinking: "Thoughts" }, { type: "text", text: "Начинаю" }]);
  const next = item(0, "assistant", [...first.message.content.slice(0, 1), { type: "text", text: "Начинаю проверку" },
    { type: "toolCall", id: "check", name: "read", arguments: {} }]);
  const committed = { ...next, message: { ...next.message, stopReason: "toolUse" } };
  const initial = build([first])[0], updated = build([next])[0], saved = build([committed])[0];
  assert.equal(initial.key, updated.key);
  assert.equal(updated.key, saved.key);
  assert.equal(key(initial.answer), key(updated.answer));
  assert.equal(key(updated.answer), key(saved.answer));
});

test("plain string replies also stay visible between process groups", () => {
  const messages = [item(0, "assistant", "Проверяю"),
    item(1, "assistant", [{ type: "thinking", thinking: "More thoughts" }]),
    item(2, "assistant", "Готово")];
  const rows = build(messages);
  assert.equal(rows[0].item.message.content, "Проверяю");
  assert.equal(rows[1].answer.message.content, "Готово");
});

test("film origin is relative to its actual scroller, including borders", () => {
  const film = { getBoundingClientRect: () => ({ top: -950 }) };
  const scroll = { getBoundingClientRect: () => ({ top: 80 }), scrollTop: 1100, clientTop: 2 };
  assert.equal(offset(film, scroll), 68);
});

test("virtualized rows use normal flow, not independent overflow below the thread", () => {
  const frame = /\.virtual-film-frame\s*\{([^}]+)\}/.exec(css)?.[1];
  assert.ok(frame);
  assert.doesNotMatch(frame, /position:\s*absolute|inset:/);
  const renderer = source.slice(source.indexOf("  const visible: ReactNode[] = [];"), source.indexOf("function createRevealTailPlugin"));
  assert.doesNotMatch(renderer, /translateY|height: `\$\{layout\.totalHeight/);
  assert.equal((renderer.match(/className="virtual-film-spacer"/g) ?? []).length, 2);
});
