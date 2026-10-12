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
const split = new Function(`${extract("splitThinkingFromAnswer")}; return splitThinkingFromAnswer;`)();
const hasAnswer = new Function(`${extract("hasAnswerText")}; return hasAnswerText;`)();
const build = new Function("messageKey", "splitThinkingFromAnswer", "hasAnswerText",
  `${extract("buildTranscriptDisplay")}; return buildTranscriptDisplay;`)(messageKey, split, hasAnswer);
const offset = new Function(`${extract("filmScrollOffset")}; return filmScrollOffset;`)();
const item = (sourceIndex, role, content, timestamp = 100) => ({
  kind: "message", sourceIndex, message: { role, timestamp, content },
});
const key = entry => `${messageKey(entry.message, entry.sourceIndex)}:${entry.fragment ?? "whole"}`;

test("timestamps and even repeated external IDs are not React row identities", () => {
  const a = { role: "toolResult", timestamp: 100, id: "same" };
  assert.notEqual(messageKey(a, 0), messageKey(a, 1));
  assert.equal(messageKey(a, 0), messageKey({ ...a, content: "updated" }, 0));
});

test("thinking and answer fragments have distinct identities inside a merged fold", () => {
  const first = item(0, "assistant", [{ type: "thinking", thinking: "Reasoning" }, { type: "text", text: "First answer" }]);
  first.message.stopReason = "toolUse";
  const second = item(1, "assistant", [{ type: "thinking", thinking: "More reasoning" }, { type: "text", text: "Second answer" }]);
  const result = build([first, second]);
  assert.equal(result.length, 1);
  const fold = result[0];
  assert.equal(fold.display, "fold");
  const keys = [...fold.process, fold.answer].map(key);
  assert.equal(new Set(keys).size, keys.length);
  assert.match(fold.key, /^fold:/);
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

test("legacy tool-call text remains intermediate even without stopReason", () => {
  const first = item(0, "assistant", [{ type: "thinking", thinking: "Reasoning" }, { type: "text", text: "Reading" }, { type: "tool_call", id: "read" }]);
  const final = item(1, "assistant", [{ type: "text", text: "Completed result" }]);
  final.message.stopReason = "stop";
  const rows = build([first, final]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].answer.sourceIndex, final.sourceIndex);
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

test("live thinking is kept whole until it is committed", () => {
  const entry = item(0, "assistant", [{ type: "thinking", thinking: "Reasoning" }, { type: "text", text: "Answer" }]);
  assert.deepEqual(split(entry, entry.message), { item: entry });
  assert.notEqual(key(split(entry).item), key(split(entry).thinking));
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
