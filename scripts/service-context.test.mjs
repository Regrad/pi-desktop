import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { projectDesktopServiceContext, desktopSummaryMessages, desktopSummaryInstructions, serializeDesktopSummary, discardDelayedStateSnapshots } from "../resources/pi-rpc-bridge/service-context.js";
import { patchServiceMessages, patchDesktopCompaction } from "./service-context-patch.mjs";

const snapshot = (type, content) => ({ role: "custom", customType: type, content, display: false });
const service = content => snapshot("desktop_goal_state", content);
const text = content => ({ type: "text", text: content });
const user = content => ({ role: "user", content });
const blocks = message => typeof message.content === "string" ? message.content : message.content.map(x => x.text ?? "").join("\n");

test("delayed older snapshots cannot contradict successful state writes or contaminate compaction", () => {
  for (const [type, tool, field] of [["desktop_plan_state", "update_plan", "plan"],
    ["desktop_notebook_state", "update_notebook", "notebook"]]) {
    const old = { ...snapshot(type, "obsolete snapshot"), details: { stateKey: "7" } };
    const ack = { role: "toolResult", toolName: tool, content: [text(JSON.stringify({ [field]: { revision: 8 } }))] };
    const history = [user("тормозни"), old, ack, old];
    assert.deepEqual(discardDelayedStateSnapshots(history), history.slice(0, 3));
    assert.deepEqual(discardDelayedStateSnapshots(discardDelayedStateSnapshots(history)), history.slice(0, 3));
    assert.doesNotMatch(blocks(projectDesktopServiceContext(history).at(-1)), /obsolete snapshot/);
    const saved = process.env.PI_DESKTOP_CONVERSATION_ID;
    try {
      process.env.PI_DESKTOP_CONVERSATION_ID = "fixture";
      assert.equal(desktopSummaryMessages(history).length, 3);
    } finally { if (saved === undefined) delete process.env.PI_DESKTOP_CONVERSATION_ID; else process.env.PI_DESKTOP_CONVERSATION_ID = saved; }
    assert.equal(discardDelayedStateSnapshots([ { ...ack, isError: true }, old]).length, 2);
    assert.equal(discardDelayedStateSnapshots([ack, { ...old, details: { stateKey: "9" } }]).length, 2);
  }
});

test("delayed goal status cannot supersede a later confirmed status of the same goal", () => {
  const goal = { id: "goal", status: "paused", updatedAt: "2026-10-07T18:19:30.287Z" };
  const ack = { role: "toolResult", toolName: "update_goal", content: [text(JSON.stringify({ goal }))] };
  const stale = { ...snapshot("desktop_goal_state", "obsolete active goal"), details: {
    workState: { ...goal, status: "active", updatedAt: "2026-10-07T18:16:55.397Z" } } };
  assert.deepEqual(discardDelayedStateSnapshots([ack, stale]), [ack]);
  assert.equal(discardDelayedStateSnapshots([stale, ack]).length, 2, "historical prefix is preserved");
  assert.equal(discardDelayedStateSnapshots([ack, { ...stale, details: { workState: { ...goal, status: "active", updatedAt: "2026-10-07T18:20:00.000Z" } } }]).length, 2);
});

test("service snapshots never create a user turn or replace the latest real request", () => {
  const image = { type: "image", data: "original", mimeType: "image/png" };
  const messages = [user([text("Продолжай работу"), image]), service("goal active"), service("goal paused")];
  const original = structuredClone(messages);
  const projected = projectDesktopServiceContext(messages);
  assert.equal(projected.length, 1);
  assert.equal(projected[0].role, "user");
  assert.deepEqual(projected[0].content.slice(1), original[0].content);
  assert.ok(blocks(projected[0]).indexOf("goal active") < blocks(projected[0]).indexOf("goal paused"));
  assert.ok(blocks(projected[0]).endsWith("Продолжай работу\n"));
  assert.deepEqual(messages, original);
  assert.deepEqual(projectDesktopServiceContext(projected), projected);
});

test("tool results retain pairing, media and original evidence with separately sourced metadata", () => {
  const result = { role: "toolResult", toolCallId: "call", toolName: "read", isError: false,
    content: [text("verified X:/KDPI"), { type: "image", data: "bytes", mimeType: "image/png" }] };
  const messages = [user("Read"), { role: "assistant", content: [{ type: "toolCall", id: "call" }] }, result,
    snapshot("desktop_notebook_state", "notebook revision 2"), service("no goal")];
  const projected = projectDesktopServiceContext(messages);
  assert.equal(projected.length, 3);
  assert.equal(projected.at(-1).toolCallId, "call");
  assert.deepEqual(projected.at(-1).content.slice(0, 2), result.content);
  assert.match(blocks(projected.at(-1)), /not a user request or a tool result/);
  assert.ok(blocks(projected.at(-1)).indexOf("revision 2") < blocks(projected.at(-1)).indexOf("no goal"));
  assert.deepEqual(projected[0], messages[0], "unchanged prefix stays byte-identical");
});

test("leading snapshots and compaction restore data without service-only user requests", () => {
  assert.equal(projectDesktopServiceContext([service("paused"), user("Answer my question")]).length, 1);
  const summary = { role: "compactionSummary", summary: "Earlier task", timestamp: 1 };
  const projected = projectDesktopServiceContext([summary, service("no goal")]);
  assert.equal(projected.length, 1);
  assert.match(projected[0].summary, /Earlier task.*\n.*\n.*no goal/s);
  const only = projectDesktopServiceContext([service("paused")]);
  assert.equal(only[0].role, "system");
});

test("continuation requests and other addons keep their intended behavior", () => {
  const continuation = { role: "custom", customType: "desktop_plan_continuation", content: "Continue authorized work", display: false };
  const visible = { role: "custom", customType: "loop-police", content: "Recover", display: true };
  const projected = projectDesktopServiceContext([continuation, service("active plan"), visible]);
  assert.equal(projected.length, 2);
  assert.equal(projected[0].customType, continuation.customType);
  assert.match(blocks(projected[0]), /Continue authorized work/);
  assert.deepEqual(projected[1], visible);
});

test("new tail events do not rewrite the leading system prompt or earlier turns", () => {
  const history = [{ role: "system", content: "Stable instructions" }, user("First task"), service("old state"),
    { role: "assistant", content: [text("Answer")] }, user("New task")];
  const before = projectDesktopServiceContext(history);
  const after = projectDesktopServiceContext([...history, service("new state")]);
  assert.deepEqual(after.slice(0, -1), before.slice(0, -1));
  assert.equal(after.filter(x => x.role === "user").length, 2);
  assert.equal(after[0].content, "Stable instructions");
});

test("summaries exclude private hypotheses but retain answers, calls and verified tool data", () => {
  const old = process.env.PI_DESKTOP_CONVERSATION_ID;
  const messages = [user("Use exact path"), { role: "assistant", content: [{ type: "thinking", thinking: "Guess tilda.so" }, text("Checked"), { type: "toolCall", id: "call", name: "read", arguments: {} }] },
    { role: "toolResult", content: [text("verified tilda.ru")] }];
  try {
    delete process.env.PI_DESKTOP_CONVERSATION_ID;
    assert.equal(desktopSummaryMessages(messages), messages);
    process.env.PI_DESKTOP_CONVERSATION_ID = "fixture";
    const projected = desktopSummaryMessages(messages);
    assert.equal(projected[1].content.length, 2);
    assert.equal(messages[1].content.length, 3);
    assert.deepEqual(projected[2], messages[2]);
    const instructions = desktopSummaryInstructions("- PRESERVE all existing information from the previous summary");
    assert.doesNotMatch(instructions, /PRESERVE all/);
    assert.match(instructions, /correct or remove claims contradicted/);
    assert.match(instructions, /Copy paths, URLs and identifiers exactly/);
  } finally { if (old === undefined) delete process.env.PI_DESKTOP_CONVERSATION_ID; else process.env.PI_DESKTOP_CONVERSATION_ID = old; }
});

test("version-pinned context patches are idempotent and fail on incompatible upstream code", () => {
  for (const [file, patch] of [["messages.js", patchServiceMessages], ["compaction/compaction.js", patchDesktopCompaction]]) {
    const source = readFileSync(new URL(`../node_modules/@earendil-works/pi-coding-agent/dist/core/${file}`, import.meta.url), "utf8");
    assert.equal(patch(patch(source)), patch(source));
    assert.throws(() => patch("incompatible"), /no longer matches/);
  }
});

test("compaction retains exact notebook state independently of truncated tool output", async () => {
  const { convertToLlm } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/messages.js");
  const { serializeConversation } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/utils.js");
  const old = process.env.PI_DESKTOP_CONVERSATION_ID;
  try {
    process.env.PI_DESKTOP_CONVERSATION_ID = "summary-fixture";
    const messages = [user("Продолжай работу"), { role: "toolResult", content: [text("x".repeat(15000))] },
      snapshot("desktop_notebook_state", "Verified URL https://tilda.ru/ and path X:/KDPI")];
    const projected = convertToLlm(desktopSummaryMessages(messages));
    const serialized = serializeDesktopSummary(projected, serializeConversation);
    assert.match(serialized, /\[Application state snapshot, not a user request\]: Verified URL https:\/\/tilda\.ru\/ and path X:\/KDPI/);
    assert.match(serialized, /\[User\]: Продолжай работу/);
    assert.doesNotMatch(serialized, /\[User\]: Verified URL/);
  } finally { if (old === undefined) delete process.env.PI_DESKTOP_CONVERSATION_ID; else process.env.PI_DESKTOP_CONVERSATION_ID = old; }
});
