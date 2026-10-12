import test from "node:test";
import assert from "node:assert/strict";
import { applyGoalReport, settleGoal, goalPrompt, visibleGoalText, withCurrentGoalState, goalStatePrompt, goalContext } from "../shared/goal.ts";
import { registerHooks } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const hook = registerHooks({ resolve(specifier, context, nextResolve) {
  return nextResolve(["../shared/goal.js", "./state-context.js"].includes(specifier) ? specifier.replace(/\.js$/, ".ts") : specifier, context);
} });
const { default: goalExtension, readDesktopGoal } = await import("../electron/goal-extension.ts");
hook.deregister();

const goal = () => ({ id: "test", objective: "Fix the bug", criteria: "Regression test passes", status: "active",
  progress: "", evidence: "", steps: 1, maxSteps: 10, stalledSteps: 0, updatedAt: "" });

test("compaction without a goal restores absence, not cancellation, and does not stop an independent plan", () => {
  const handlers = new Map(), saved = [];
  goalExtension({ on(name, handler) { handlers.set(name, handler); }, registerTool() {},
    sendMessage(message) { saved.push({ ...message, role: "custom" }); } }, () => undefined);
  const history = [{ role: "compactionSummary", summary: "Continue the authorized checklist" }];
  const projected = handlers.get("context")({ messages: history }).messages;
  assert.match(projected.at(-1).content, /snapshot \(none\)/);
  assert.match(projected.at(-1).content, /Цель не задана/);
  assert.doesNotMatch(projected.at(-1).content, /Цель отменена|Не продолжай/);
  assert.equal(saved.length, 1);
  handlers.get("context")({ messages: [...history, ...saved] });
  assert.equal(saved.length, 1);
});

test("legacy false cancellation is superseded by a neutral absence snapshot", () => {
  const handlers = new Map();
  goalExtension({ on(name, handler) { handlers.set(name, handler); }, registerTool() {}, sendMessage() {} }, () => undefined);
  const old = { role: "custom", customType: "desktop_goal_state", content: "Цель отменена.",
    details: { stateKey: "null", workState: null } };
  const projected = handlers.get("context")({ messages: [old] }).messages;
  assert.equal(projected.length, 2);
  assert.match(projected.at(-1).content, /Цель не задана/);
});

test("hides controller context in chat without changing ordinary user text", () => {
  const prompt = goalPrompt({ ...goal(), id: "11111111-1111-4111-8111-111111111111" });
  assert.equal(visibleGoalText(`My message\n\n${prompt}`), "My message");
  assert.equal(visibleGoalText("My message"), "My message");
});

test("accepts structured progress and completion with evidence", () => {
  const current = goal();
  const updated = applyGoalReport(current, { goalId: "test", status: "complete", progress: "Fixed", evidence: "Regression test passed" });
  assert.equal(updated.status, "complete");
  assert.equal(current.status, "active");
});
test("ignores stale, paused, malformed and unverified reports", () => {
  for (const report of [null, {}, { goalId: "old", status: "complete", progress: "Done", evidence: "test" },
    { goalId: "test", status: "complete", progress: "Done", evidence: " " }]) {
    const current = goal(); assert.equal(applyGoalReport(current, report), current);
  }
  const paused = { ...goal(), status: "paused" };
  assert.equal(applyGoalReport(paused, { goalId: "test", status: "active", progress: "Continue", evidence: "" }), paused);
});
test("missing progress reports do not implicitly pause a goal", () => {
  let current = goal();
  for (let i = 0; i < 3; i++) current = settleGoal(current, "");
  assert.equal(current.status, "active");
});
test("new progress resets stall count and old stage caps are not enforced", () => {
  assert.equal(settleGoal({ ...goal(), stalledSteps: 2, progress: "Tests added" }, "").stalledSteps, 0);
  assert.equal(settleGoal({ ...goal(), steps: 10, progress: "More work" }, "").status, "active");
});
test("settling cannot reactivate completed or blocked goals", () => {
  for (const status of ["complete", "blocked", "paused"]) {
    const current = { ...goal(), status }; assert.equal(settleGoal(current, ""), current);
  }
});
test("continuation supplies criteria, progress and permission boundaries", () => {
  const prompt = goalPrompt(goal());
  for (const text of ["test", "Regression test passes", "get_goal", "update_goal", "permissions", "blocked"]) assert.ok(prompt.includes(text));
});
test("goal tools return acknowledged host state, not optimistic reports", async () => {
  const tools = new Map(), calls = [];
  goalExtension({ on() {}, registerTool(value) { tools.set(value.name, value); } }, goal, async (name, params) => {
    calls.push({ name, params });
    return { goal: { ...goal(), status: params.status ?? "active" } };
  });
  assert.deepEqual([...tools.keys()], ["get_goal", "create_goal", "update_goal"]);
  const result = await tools.get("update_goal").execute("call", { status: "paused" });
  assert.equal(JSON.parse(result.content[0].text).goal.status, "paused");
  assert.equal(calls[0].params.goalId, "test");
  assert.equal(result.details, undefined);
});

const controllerId = "11111111-1111-4111-8111-111111111111";
const history = () => [
  { role: "compactionSummary", summary: "Old goal: continue autonomously" },
  { role: "user", content: [{ type: "text", text: `Old request\n\n${goalPrompt({ ...goal(), id: controllerId })}` }, { type: "image", data: "bytes", mimeType: "image/png" }] },
  { role: "assistant", content: [{ type: "text", text: "Old response" }] },
  { role: "user", content: "Answer my question" },
  { role: "toolResult", content: [{ type: "text", text: "tool output" }] },
];

test("paused goal overrides old directives and summaries without adding or saving a user message", () => {
  const original = history(), before = structuredClone(original);
  const projected = withCurrentGoalState(original, { ...goal(), status: "paused" });
  assert.equal(projected.length, original.length);
  assert.deepEqual(projected.map(message => message.role), original.map(message => message.role));
  assert.equal(projected[1].content[0].text, "Old request");
  assert.equal(projected[1].content[1].data, "bytes");
  assert.match(projected[3].content, /^Answer my question/);
  assert.match(projected[3].content, /Status: paused/);
  assert.match(projected[3].content, /Automatic goal work and goal reporting are disabled/);
  assert.deepEqual(original, before);
});

test("removal and completion do not authorize autonomous work", () => {
  for (const status of ["none", "complete", "blocked"]) {
    const prompt = goalStatePrompt(status === "none" ? undefined : { ...goal(), status });
    assert.ok(prompt.includes(`Status: ${status}`));
    assert.match(prompt, /Automatic goal work and goal reporting are disabled/);
    assert.match(prompt, /Previous IDs and previous versions/);
  }
});

test("updated goal supplies only current ID and objective, not the old controller block", () => {
  const updated = { ...goal(), id: "new-goal", objective: "New objective", updatedAt: "new timestamp" };
  const projected = withCurrentGoalState(history(), updated);
  assert.equal(JSON.stringify(projected).includes(controllerId), false);
  assert.match(projected[3].content, /Current goal ID: new-goal/);
  assert.match(projected[3].content, /Current objective: New objective/);
  assert.match(projected[3].content, /Answer the user's current request first/);
});

test("extension rereads pause, edits and removal between tool continuations without sending prompts", async () => {
  let current = { ...goal(), id: controllerId };
  const handlers = new Map();
  const entries = [];
  let tool;
  const saved = [];
  goalExtension({ sendMessage(message) { saved.push({ ...message, role: "custom" }); }, on(name, handler) { handlers.set(name, handler); }, registerTool(value) { tool = value; } }, () => current);
  const original = history();
  const context = () => handlers.get("context")({ messages: [...original, ...saved] }).messages;
  let projected = context();
  assert.equal(projected[3].content, "Answer my question");
  assert.match(projected.at(-1).content, /Objective: Fix the bug/);
  assert.equal(projected.at(-1).role, "custom");
  current = { ...current, status: "paused" };
  for (let i = 0; i < 3; i++) {
    projected = context();
    assert.equal(projected[3].content, "Answer my question");
    assert.match(projected.at(-1).content, /на паузе/);
    assert.doesNotMatch(projected.at(-1).content, /Fix the bug|continue active/i);
  }
  current = { ...current, id: "edited", objective: "Changed objective", status: "active" };
  assert.match(context().at(-1).content, /Changed objective/);
  current = undefined;
  assert.match(context().at(-1).content, /Цель отменена/);
  const count = saved.length;
  assert.equal(context().length, original.length + count);
  assert.equal(saved.length, count);
  const restarted = new Map();
  goalExtension({ sendMessage() { throw Error("duplicate after restart"); }, on(name, handler) { restarted.set(name, handler); }, registerTool() {} }, () => current);
  assert.equal(restarted.get("context")({ messages: [...original, ...saved] }).messages.length, original.length + count);
  const before = handlers.get("before_agent_start")({ systemPrompt: "Base system" });
  assert.match(before.systemPrompt, /^Base system/);
  assert.match(before.systemPrompt, /Use get_goal/);
  assert.equal(before.message, undefined);
});

test("restart does not infer another cancellation from historical goal entries", () => {
  const entries = [{ role: "custom", customType: "desktop_goal_state", content: "Old goal", details: { stateKey: "removed" } }];
  const handlers = new Map();
  goalExtension({ sendMessage(message) { entries.push({ ...message, role: "custom" }); }, on(name, handler) { handlers.set(name, handler); }, registerTool() {} }, () => undefined);
  const ctx = { sessionManager: { getBranch: () => entries } };
  assert.match(handlers.get("context")({ messages: [...entries] }, ctx).messages.at(-1).content, /Цель не задана/);
  assert.equal(handlers.get("context")({ messages: [...entries] }, ctx).messages.length, 2);
});

test("after an observed removal, compaction emits absence without repeating cancellation", () => {
  let current = goal();
  const handlers = new Map(), saved = [];
  goalExtension({ on(name, handler) { handlers.set(name, handler); }, registerTool() {},
    sendMessage(message) { saved.push({ ...message, role: "custom" }); } }, () => current);
  handlers.get("context")({ messages: [] });
  current = undefined;
  handlers.get("context")({ messages: [...saved] });
  assert.match(saved.at(-1).content, /Цель отменена/);
  const restored = handlers.get("context")({ messages: [{ role: "compactionSummary", summary: "Prior goal" }] }).messages;
  assert.match(restored.at(-1).content, /Цель не задана/);
  assert.doesNotMatch(restored.at(-1).content, /Цель отменена/);
});

test("state loader selects the right conversation and fails closed for unavailable state", () => {
  const folder = mkdtempSync(path.join(tmpdir(), "pi-goal-state-test-"));
  const file = path.join(folder, "desktop-state.json");
  writeFileSync(file, JSON.stringify({ conversations: [
    { id: "other", goal: { ...goal(), updatedAt: "now" } },
    { id: "target", goal: { ...goal(), status: "paused", updatedAt: "now" } },
  ] }), "utf8");
  assert.equal(readDesktopGoal(folder, "target").status, "paused");
  assert.equal(readDesktopGoal(folder, "missing"), undefined);
  writeFileSync(file, "broken", "utf8");
  assert.equal(readDesktopGoal(folder, "target"), undefined);
});

test("historical service continuations retain their original positions after goal changes", () => {
  const current = { ...goal(), id: controllerId };
  const service = { role: "custom", customType: "desktop_goal_continuation", content: "Service", display: false, details: { goalId: controllerId } };
  const messages = [...history(), service, { role: "assistant", content: [] }];
  const before = structuredClone(messages);
  assert.equal(goalContext(messages, current).filter(m => m.customType === service.customType).length, 1);
  for (const state of [undefined, { ...current, status: "paused" }, { ...current, id: "edited" }]) {
    assert.equal(goalContext(messages, state).some(m => m.customType === service.customType), true);
  }
  assert.deepEqual(messages, before);
});

test("delayed older goal snapshot does not invalidate a successful pause acknowledgement", () => {
  const current = { ...goal(), status: "paused", updatedAt: "2026-10-07T18:19:30.287Z" };
  const handlers = new Map(), sent = [];
  goalExtension({ on(name, handler) { handlers.set(name, handler); }, registerTool() {},
    sendMessage(message) { sent.push(message); } }, () => current);
  const history = [{ role: "user", content: "тормозни", timestamp: 1 },
    { role: "toolResult", toolName: "update_goal", content: [{ type: "text", text: JSON.stringify({ goal: current }) }] },
    { role: "custom", customType: "desktop_goal_state", content: "old active state", details: {
      stateKey: "old", userKey: "old", workState: { ...current, status: "active", updatedAt: "2026-10-07T18:16:55.397Z" } } }];
  assert.deepEqual(handlers.get("context")({ messages: history }).messages, history);
  assert.equal(sent.length, 0);
});

test("paused reminder repeats only for a new user message, not tool steps; acknowledged changes need no snapshot", () => {
  let current = { ...goal(), status: "paused" };
  const handlers = new Map(), saved = [];
  const api = { on(name, handler) { handlers.set(name, handler); }, registerTool() {},
    sendMessage(message, options) { assert.deepEqual(options, { triggerTurn: false }); saved.push({ ...message, role: "custom" }); } };
  goalExtension(api, () => current);
  const run = messages => handlers.get("context")({ messages }).messages;
  let messages = run([{ role: "user", content: "Question", timestamp: 1 }]);
  messages.push({ role: "assistant", content: [] }, { role: "toolResult", toolName: "read", content: [] });
  assert.deepEqual(run(messages), messages);
  assert.equal(saved.length, 1);
  messages.push({ role: "user", content: "Question", timestamp: 2 });
  messages = run(messages);
  assert.equal(saved.length, 2);
  assert.deepEqual(run(messages), messages);
  current = { ...current, status: "active", objective: "Changed" };
  messages.push({ role: "toolResult", toolName: "get_goal", content: [{ type: "text", text: JSON.stringify({ goal: current }) }] });
  assert.deepEqual(run(messages), messages);
  assert.equal(saved.length, 2);
  current = { ...current, status: "paused" };
  messages.push({ role: "toolResult", toolName: "update_goal", content: [{ type: "text", text: JSON.stringify({ goal: current }) }] });
  assert.deepEqual(run(messages), messages);
  messages.push({ role: "user", content: "New question after acknowledged pause", timestamp: 3 });
  messages = run(messages);
  assert.equal(saved.length, 3);
  assert.deepEqual(run(messages), messages);
  current = undefined;
  messages = run(messages);
  assert.match(messages.at(-1).content, /Цель отменена/);
  assert.deepEqual(run(messages), messages);
  assert.equal(saved.length, 4);
  const restarted = new Map();
  goalExtension({ ...api, on(name, handler) { restarted.set(name, handler); } }, () => current);
  assert.deepEqual(restarted.get("context")({ messages }).messages, messages);
  assert.equal(saved.length, 4);
});

test("compaction restores current goal and legacy notices are superseded without removing history", () => {
  const handlers = new Map(), saved = [];
  goalExtension({ on(name, handler) { handlers.set(name, handler); }, registerTool() {}, sendMessage(message) { saved.push(message); } }, () => ({ ...goal(), status: "paused" }));
  const old = { role: "custom", customType: "desktop_goal_state", content: "Legacy active goal" };
  const messages = [old, { role: "compactionSummary", summary: "Continue previous task" }];
  const result = handlers.get("context")({ messages }).messages;
  assert.deepEqual(result.slice(0, -1), messages);
  assert.match(result.at(-1).content, /на паузе/);
  assert.equal(saved.length, 1);
});

test("real Pi custom-message delivery preserves service state in agent history and session context without starting a turn", async () => {
  const { AgentSession } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js");
  const { SessionManager } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js");
  const sessionManager = SessionManager.inMemory(process.cwd());
  const user = { role: "user", content: "Question", timestamp: 1 };
  sessionManager.appendMessage(user);
  const host = { isStreaming: true, agent: { state: { messages: [user] }, steer() { throw Error("must not steer"); } },
    _pendingCustomMessages: [], sessionManager, _emit() {},
    _appendCustomMessage: AgentSession.prototype._appendCustomMessage,
    _refreshFinalizedContext() { this.agent.state.messages = sessionManager.buildSessionContext().messages; },
    _runAgentPrompt() { throw Error("must not start a turn"); } };
  const handlers = new Map();
  const deliveries = [];
  const api = { on(name, handler) { handlers.set(name, handler); }, registerTool() {},
    sendMessage(message, options) { deliveries.push(AgentSession.prototype.sendCustomMessage.call(host, message, options)); } };
  goalExtension(api, () => ({ ...goal(), status: "paused" }));
  const projected = handlers.get("context")({ messages: structuredClone(host.agent.state.messages) }).messages;
  await Promise.all(deliveries);
  assert.equal(projected.length, 2);
  // Pi 1.0.4 persists context-only messages at turn_end, after any tool results.
  assert.equal(host.agent.state.messages.length, 1);
  assert.equal(host._pendingCustomMessages.length, 1);
  AgentSession.prototype._flushPendingCustomMessages.call(host);
  assert.equal(host.agent.state.messages.length, 2);
  const restored = sessionManager.buildSessionContext().messages;
  assert.equal(restored.length, 2);
  assert.equal(restored[1].details.stateKey, host.agent.state.messages[1].details.stateKey);
  handlers.get("context")({ messages: structuredClone(restored) });
  assert.equal(host.agent.state.messages.length, 2);
  assert.equal(sessionManager.buildSessionContext().messages.length, 2);
  assert.equal(host._pendingCustomMessages.length, 0);
});
