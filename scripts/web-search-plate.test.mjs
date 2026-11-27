// One web search must own exactly one row of the transcript. Its call and its
// result are separate messages, so an interleaving message can split them across
// two folds; when both folds were keyed by the search id, the virtual film cached
// another row's height and React kept a stale node, repeating the same research
// plate down the chat.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

function grab(name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start > 0, `нет функции ${name} в src/App.tsx`);
  return source.slice(start + 1, source.indexOf("\n}\n", start) + 2);
}

const names = [
  "transcriptTimestamp", "messageKey", "toolCallParts", "toolCallIdentifier",
  "toolResultIdentifier", "hasAnswerText", "transcriptFoldKey",
  "splitAssistantTimelineItem", "buildTranscriptDisplay", "groupWebProcess",
];
const ui = await import("data:text/javascript;base64," + Buffer.from(
  stripTypeScriptTypes(names.map(grab).join("\n") + `\nexport { ${names.join(",")} };`, { mode: "transform" }),
).toString("base64"));

// The fold's tool registration lives inside the component; lift the same block so
// the ownership rule is tested as behaviour instead of as a text pattern.
function promote(display) {
  const tools = {};
  const blockStart = source.indexOf("    const imageTools: { id: string;", source.indexOf("const renderDisplayItem = "));
  const blockEnd = source.indexOf("    const answer = display.answer;", blockStart);
  assert.ok(blockStart > 0 && blockEnd > blockStart, "не найден блок регистрации инструментов свёртки");
  const block = source.slice(blockStart, blockEnd);
  const buildToolActivity = (call, fallbackId) => {
    const id = ui.toolCallIdentifier(call, fallbackId);
    const result = results.get(id);
    return { id, name: String(call.name ?? ""), result: result?.content, running: !result, error: false };
  };
  return new Function(
    "display", "toolCallParts", "messageKey", "toolResultIdentifier", "buildToolActivity",
    "nestedFor", "resultMessagePayload", "tools",
    // верхний return разрешён в теле new Function, но не в исходнике для stripTypeScriptTypes
    stripTypeScriptTypes(`function promoteFold(display) { ${block} return { webTools, nestedSearches, imageTools }; }`, { mode: "transform" })
      + "; return promoteFold(display);",
  )(display, ui.toolCallParts, ui.messageKey, ui.toolResultIdentifier, buildToolActivity, () => [],
    message => message.content, tools);
}

const results = new Map();
const text = (value) => ({ type: "text", text: value });
const thinking = (value) => ({ type: "thinking", thinking: value });
const call = (id, name) => ({ type: "toolCall", id, name, arguments: {} });
const assistant = (timestamp, content) => ({ role: "assistant", timestamp, content });
function toolResult(id, name, timestamp) {
  const message = { role: "toolResult", toolCallId: id, toolName: name, timestamp, content: [text("ok")] };
  results.set(id, message);
  return message;
}

function displayOf(messages) {
  return ui.buildTranscriptDisplay(messages.map((message, sourceIndex) => ({
    kind: "message", message, sourceIndex,
    timestamp: ui.transcriptTimestamp(message.timestamp, 0),
    order: sourceIndex * 2,
  })));
}

function foldKeys(display) {
  return display.filter((item) => item.display === "fold").map((item) => item.key);
}

// Every search id promoted into a plate, across all folds of one screen state.
function platedSearches(display) {
  const plated = [];
  for (const item of display) {
    if (item.display !== "fold") continue;
    const { webTools } = promote(item);
    if (!webTools.size) continue;
    for (const section of ui.groupWebProcess(item.process, webTools, new Map()))
      if (section.kind === "search") for (const tool of section.calls) plated.push(tool.id);
  }
  return plated;
}

test("a search call and its result in different folds never share one row key", () => {
  const display = displayOf([
    { role: "user", content: [text("ищи")], timestamp: 1 },
    assistant(2, [thinking("ага"), call("c1", "bash"), call("c2", "web_search")]),
    { role: "user", content: [text("стой")], timestamp: 3 },
    toolResult("c1", "bash", 4),
    toolResult("c2", "web_search", 5),
  ]);
  const keys = foldKeys(display);
  assert.equal(keys.length, 2, "обе свёртки должны остаться");
  assert.equal(new Set(keys).size, keys.length, `ключи свёрток должны быть уникальны: ${keys.join(", ")}`);
  assert.deepEqual(platedSearches(display), ["c2"], "завершённый поиск показывает одну плашку");
});

test("a search keeps one plate in every screen state of a long turn", () => {
  const messages = [{ role: "user", content: [text("начали")], timestamp: 1 }];
  for (let step = 0; step < 30; step += 1) {
    const timestamp = 10 + step * 10;
    // The model narrates between searches, which closes the running fold.
    messages.push(assistant(timestamp, [thinking(`шаг ${step}`), call(`s${step}`, "web_search"), call(`b${step}`, "bash")]));
    messages.push(toolResult(`s${step}`, "web_search", timestamp + 1));
    messages.push(toolResult(`b${step}`, "bash", timestamp + 2));
    if (step % 3 === 2) messages.push(assistant(timestamp + 3, [text(`итог шага ${step}`)]));
  }
  let states = 0;
  for (let end = 1; end <= messages.length; end += 1) {
    const display = displayOf(messages.slice(Math.max(0, end - 60), end));
    const keys = [...foldKeys(display),
      ...display.filter((item) => item.display === "single").map((item, index) => `single:${index}:${item.item.message?.toolCallId ?? item.item.message?.timestamp}`)];
    assert.equal(new Set(keys).size, keys.length, `дубли ключей в состоянии до ${end}: ${keys.filter((k, i) => keys.indexOf(k) !== i).join(", ")}`);
    const plated = platedSearches(display);
    assert.equal(new Set(plated).size, plated.length, `плашки повторяются в состоянии до ${end}: ${plated.join(", ")}`);
    states += 1;
  }
  assert.ok(states > 50, "проверено достаточно состояний экрана");
});

test("a search that is still running keeps its plate before any result exists", () => {
  results.clear();
  const display = displayOf([
    { role: "user", content: [text("ищи")], timestamp: 1 },
    assistant(2, [thinking("ищу"), call("live1", "web_search")]),
  ]);
  const plated = platedSearches(display);
  assert.deepEqual(plated, ["live1"], "выполняющийся поиск остаётся виден");
});
