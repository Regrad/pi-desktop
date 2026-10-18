import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { setImmediate as nextTick } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { updatedPlan, canContinuePlan } from "../shared/plan.ts";
import { confirmedPlanRevision } from "../shared/plan-activity.ts";
import { settleGoal, goalPrompt } from "../shared/goal.ts";
import { canResumeRun } from "../shared/run-state.ts";

// Exercise the actual controller methods without Electron, inference or a build.
const source = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
function method(name, parameters, privateMethod = false) {
  const start = source.indexOf(`\n  ${privateMethod ? "private " : ""}async ${name}(`);
  const begin = source.indexOf("> {", start) + 3;
  const end = source.indexOf("\n  }", begin);
  assert.ok(start >= 0 && begin > start && end > begin, name);
  const body = stripTypeScriptTypes(`async function invoke(${parameters}) {${source.slice(begin, end)}\n}`);
  return new Function("updatedPlan", "confirmedPlanRevision", "settleGoal", "randomUUID", "canContinuePlan", "goalPrompt", "imageAttachmentPrompt", "canResumeRun", `${body}; return invoke;`)(updatedPlan, confirmedPlanRevision, settleGoal, randomUUID, canContinuePlan, goalPrompt, () => "", canResumeRun);
}
const handle = method("handleEvent", "conversationId, event", true);
const exit = method("handleRuntimeExit", "conversationId, runtime, error", true);
const abort = method("abort", "conversationId");
const sendQueued = method("sendQueuedPrompt", "conversationId, promptId");
const sendNext = method("sendNextQueuedPrompt", "conversationId", true);
const send = method("sendPrompt", "conversationId, message, attachments, behavior, expectedGoalId, historyEdit = false, requestPlan = false, expectedPlanRevision, resumeBeforeQueue = false");
const controlGoal = method("controlGoal", "conversationId, action");
const controlPlan = method("controlPlan", "conversationId, action");
const resume = method("resumeConversation", "conversationId");

function fixture(withWork = true) {
  const chat = { id: "chat", status: "working", ...(withWork ? {
    plan: updatedPlan({ plan: [{ step: "Unfinished task", status: "in_progress" }], execution: "active" }),
    goal: { id: "goal", status: "active", progress: "working", steps: 1, maxSteps: 0, stalledSteps: 0 },
  } : {}) };
  let queue = [{ id: "one", message: "next task", attachments: [] }, { id: "two", message: "another task", attachments: [] }];
  const requests = [], events = [], launches = [];
  const oldAnswer = { role: "assistant", stopReason: "stop", content: "Previous completed answer" };
  const runtime = { snapshot: { messages: [oldAnswer], state: { isStreaming: true } }, liveTools: {},
    activeRun: { startedAt: new Date().toISOString() }, rpc: { async request(type) { requests.push(type); } } };
  const host = {
    runtimes: new Map([["chat", runtime]]), resumingRuns: new Set(), goalLaunching: new Set(), goalContinuationRequested: new Set(["chat"]),
    store: { getConversation: () => chat, getQueuedPrompts: () => queue, async saveConversationRun() {},
      async removeQueuedPrompt(_id, promptId) { queue = queue.filter(item => item.id !== promptId); return queue; } },
    async updateConversation(_id, patch) { Object.assign(chat, patch); },
    async refreshRuntimeSnapshot() { runtime.snapshot.state.isStreaming = false; },
    async refreshState() { return runtime.snapshot.state; },
    async inspectConversation() { return runtime.snapshot; },
    publish(_channel, payload) { events.push(payload); },
    syncQueuedPrompts() {}, async sendPrompt(...args) { requests.push(args); },
    launchGoal(id) { launches.push(id); },
  };
  host.sendNextQueuedPrompt = sendNext.bind(host);
  host.sendQueuedPrompt = sendQueued.bind(host);
  return { host, chat, runtime, requests, events, launches, queue: () => queue,
    event: event => handle.call(host, "chat", event),
    answer: stopReason => handle.call(host, "chat", { type: "message_end", message: { role: "assistant", stopReason, content: "Answer" } }),
    settle: () => handle.call(host, "chat", { type: "agent_settled" }),
  };
}

for (const reason of ["error", "aborted", "length", "toolUse", undefined]) {
  test(`interrupted run (${reason}) preserves queue and pauses unfinished work`, async () => {
    const f = fixture();
    await f.answer(reason);
    await f.settle();
    await nextTick();
    assert.equal(f.queue().length, 2);
    assert.deepEqual(f.requests, []);
    assert.deepEqual(f.launches, []);
    assert.equal(f.chat.plan.execution, "paused");
    assert.equal(f.chat.goal.status, "paused");
    assert.equal(f.host.goalContinuationRequested.size, 0);
  });
}

test("connection failure holds queue even without a checklist or goal", async () => {
  const f = fixture(false);
  await f.answer("error");
  await f.settle();
  assert.equal(f.queue().length, 2);
  assert.deepEqual(f.requests, []);
});

test("cancelling retry cannot mistake older projected success for completion", async () => {
  const f = fixture();
  await f.answer("error");
  // Pi omits failed attempts from projected history during auto-retry.
  f.runtime.snapshot.messages.splice(1);
  await f.event({ type: "auto_retry_end", success: false, finalError: "Retry cancelled" });
  await f.settle();
  assert.equal(f.queue().length, 2);
  assert.deepEqual(f.requests, []);
  assert.equal(f.chat.plan.execution, "paused");
});

test("successful retry sends only the oldest queued prompt, after final settlement", async () => {
  const f = fixture();
  await f.answer("error");
  await f.event({ type: "agent_start" });
  assert.equal(f.queue().length, 2);
  await f.answer("stop");
  await f.settle();
  await nextTick();
  assert.deepEqual(f.queue().map(item => item.id), ["two"]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0][1], "next task");
  assert.equal(f.chat.plan.execution, "active");
});

test("Stop while a tool is running prevents queue dispatch, even after a successful assistant message", async () => {
  const f = fixture();
  await f.answer("stop");
  await abort.call(f.host, "chat");
  await f.settle();
  assert.equal(f.queue().length, 2);
  assert.deepEqual(f.requests, ["abort"]);
});

test("Stop during final diff collection also retains queued prompts", async () => {
  const f = fixture();
  f.runtime.diffTracker = { async endRun() { await abort.call(f.host, "chat"); return {}; } };
  await f.answer("stop");
  await f.settle();
  assert.equal(f.queue().length, 2);
  assert.deepEqual(f.requests, ["abort"]);
});

test("unknown outcome never reuses a successful answer from an earlier run", async () => {
  const f = fixture();
  await f.event({ type: "agent_start" });
  await f.settle();
  assert.equal(f.queue().length, 2);
  assert.deepEqual(f.requests, []);
});

test("manual send remains available after failure and does not silently drain the rest", async () => {
  const f = fixture();
  await f.answer("error");
  await f.settle();
  await sendQueued.call(f.host, "chat", "one");
  assert.deepEqual(f.queue().map(item => item.id), ["two"]);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0][1], "next task");
});

test("manual goal resume can continue interrupted work ahead of the held queue", async () => {
  const f = fixture();
  await f.answer("error");
  await f.settle();
  f.chat.title = "Existing chat";
  f.host.historyMutations = new Set();
  f.host.ensureRuntime = async () => f.runtime;
  f.host.reloadPendingInstructions = async () => {};
  f.host.store.getConversationWorkspacePaths = async () => [];
  f.runtime.snapshot.extensionState = { activeTools: ["get_goal"] };
  f.runtime.diffTracker = { covers: () => true, async beginRun() {} };
  const launches = [];
  f.host.launchGoal = (...args) => launches.push(args);
  await controlGoal.call(f.host, "chat", "resume");
  assert.deepEqual(launches, [["chat", [], false, true]]);
  await send.call(f.host, "chat", "Continue", [], undefined, "goal");
  assert.deepEqual(f.requests, [], "Automatic continuation still respects the queue");
  await send.call(f.host, "chat", "Continue", [], undefined, "goal", false, false, undefined, true);
  assert.deepEqual(f.requests, ["desktop_goal_continue"]);
  assert.equal(f.queue().length, 2);
  assert.equal(f.runtime.runAborted, false);
  assert.equal(f.runtime.runStopReason, undefined);
});

test("manual checklist resume explicitly requests continuation ahead of a held queue", async () => {
  const f = fixture();
  delete f.chat.goal;
  await f.answer("error");
  await f.settle();
  const launches = [];
  f.host.launchGoal = (...args) => launches.push(args);
  await controlPlan.call(f.host, "chat", "resume");
  assert.deepEqual(launches, [["chat", [], false, true]]);
  assert.equal(f.queue().length, 2);
});

test("runtime exit pauses checklist, preserves queue and cannot schedule stale continuation", async () => {
  const f = fixture();
  await exit.call(f.host, "chat", f.runtime, new Error("connection lost"));
  assert.equal(f.chat.status, "error");
  assert.equal(f.chat.plan.execution, "paused");
  assert.equal(f.chat.goal.status, "paused");
  assert.equal(f.runtime.runAborted, true);
  assert.equal(f.queue().length, 2);
  assert.deepEqual(f.requests, []);
  assert.equal(f.host.goalContinuationRequested.size, 0);
  assert.equal(f.events.find(item => item.event.type === "desktop_run_state").event.stopped, true);
});

test("a clean process exit during work also exposes Continue without requiring an error event", async () => {
  const f = fixture(false);
  await exit.call(f.host, "chat", f.runtime);
  const event = f.events.find(item => item.event.type === "desktop_run_state").event;
  assert.equal(event.stopped, true);
  assert.equal(canResumeRun(event.run), true);
  assert.equal(f.events.some(item => item.event.type === "runtime_error"), false);
});

test("a failed run without queued prompts cannot launch an automatic continuation", async () => {
  const f = fixture();
  await f.host.store.removeQueuedPrompt("chat", "one");
  await f.host.store.removeQueuedPrompt("chat", "two");
  await f.answer("error");
  await f.settle();
  assert.deepEqual(f.launches, []);
});

for (const reason of ["error", "aborted"]) {
  test(`Continue after ${reason} restores only this run's paused work and retains the queue`, async () => {
    const f = fixture();
    await f.answer(reason);
    await f.settle();
    assert.equal(f.runtime.snapshot.run.interruption.planRevision, f.chat.plan.revision);
    assert.equal(f.runtime.snapshot.run.interruption.goalId, f.chat.goal.id);
    await resume.call(f.host, "chat");
    assert.equal(f.chat.plan.execution, "active");
    assert.equal(f.chat.goal.status, "active");
    assert.equal(f.queue().length, 2);
    assert.deepEqual(f.requests, [["chat", "Продолжить прерванную работу.", [], "resume"]]);
    assert.equal(f.host.resumingRuns.size, 0);
  });
}

test("Continue works without a checklist or goal and survives reopening the saved run", async () => {
  const f = fixture(false);
  await f.answer("error");
  await f.settle();
  const saved = JSON.parse(JSON.stringify(f.runtime.snapshot));
  f.host.runtimes.clear();
  f.host.inspectConversation = async () => saved;
  await resume.call(f.host, "chat");
  assert.equal(f.requests[0][3], "resume");
  assert.equal(f.queue().length, 2);
});

test("Continue cannot revive a separately edited checklist or replaced goal", async () => {
  const f = fixture();
  await f.answer("error");
  await f.settle();
  f.chat.plan = updatedPlan({ explanation: "User changed the plan", execution: "paused" }, f.chat.plan);
  f.chat.goal = { ...f.chat.goal, id: "new-goal", status: "paused" };
  await resume.call(f.host, "chat");
  assert.equal(f.chat.plan.execution, "paused");
  assert.equal(f.chat.goal.status, "paused");
});

test("Continue cannot revive a goal/checklist already paused before Stop", async () => {
  const f = fixture();
  f.chat.plan.execution = "paused";
  f.chat.goal.status = "paused";
  await abort.call(f.host, "chat");
  await f.settle();
  await resume.call(f.host, "chat");
  assert.equal(f.chat.plan.execution, "paused");
  assert.equal(f.chat.goal.status, "paused");
  assert.equal(f.requests.at(-1)[3], "resume");
});

test("failed resume restores the interruption marker and allows another attempt", async () => {
  const f = fixture();
  await f.answer("error");
  await f.settle();
  f.host.sendPrompt = async () => { throw Error("Cannot connect"); };
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(resume.call(f.host, "chat"), /Cannot connect/);
    assert.equal(f.chat.plan.execution, "paused");
    assert.equal(f.chat.goal.status, "paused");
    assert.equal(f.runtime.activeRun.interruption.planRevision, f.chat.plan.revision);
    assert.equal(canResumeRun(f.runtime.snapshot.run), true);
    assert.equal(f.host.resumingRuns.size, 0);
  }
});

test("a double click issues one continuation and settlement is awaited first", async () => {
  const f = fixture(false);
  await f.answer("error");
  await f.settle();
  let release;
  f.runtime.eventQueue = new Promise(resolve => { release = resolve; });
  const first = resume.call(f.host, "chat");
  const second = resume.call(f.host, "chat");
  assert.equal(f.requests.length, 0);
  release();
  await Promise.all([first, second]);
  assert.equal(f.requests.length, 1);
});

test("Continue rejects active and normally completed runs", async () => {
  const f = fixture();
  await assert.rejects(resume.call(f.host, "chat"), /Дождитесь остановки/);
  await f.answer("stop");
  // Keep the test idle rather than dispatching a pending queue.
  await f.host.store.removeQueuedPrompt("chat", "one");
  await f.host.store.removeQueuedPrompt("chat", "two");
  await f.settle();
  await assert.rejects(resume.call(f.host, "chat"), /Нет прерванной работы/);
});

test("actual resume dispatch uses dedicated RPC, retains history and does not send queued input", async () => {
  const f = fixture(false);
  await f.answer("error");
  await f.settle();
  const history = f.runtime.snapshot.messages;
  const contents = structuredClone(history);
  f.chat.title = "Existing chat";
  f.host.historyMutations = new Set();
  f.host.ensureRuntime = async () => f.runtime;
  f.host.reloadPendingInstructions = async () => {};
  f.host.store.getConversationWorkspacePaths = async () => [];
  f.runtime.diffTracker = { covers: () => true, async beginRun() {} };
  f.host.sendPrompt = send.bind(f.host);
  await resume.call(f.host, "chat");
  assert.deepEqual(f.requests, ["desktop_run_resume"]);
  assert.equal(f.queue().length, 2);
  assert.equal(f.runtime.snapshot.messages, history);
  assert.deepEqual(history, contents);
  assert.equal(f.runtime.activeRun.interruption, undefined);
});

test("Stop during resume preparation cancels dispatch and keeps a resumable paused run", async () => {
  const f = fixture();
  await f.answer("error");
  await f.settle();
  f.chat.title = "Existing chat";
  f.host.historyMutations = new Set();
  f.host.ensureRuntime = async () => f.runtime;
  f.host.reloadPendingInstructions = async () => {};
  f.host.store.getConversationWorkspacePaths = async () => [];
  f.runtime.diffTracker = { covers: () => true, async beginRun() { await abort.call(f.host, "chat"); } };
  f.host.sendPrompt = send.bind(f.host);
  await assert.rejects(resume.call(f.host, "chat"), /отменено пользователем/);
  assert.deepEqual(f.requests, ["abort"]);
  assert.equal(f.chat.plan.execution, "paused");
  assert.equal(f.chat.goal.status, "paused");
  assert.equal(f.runtime.activeRun.interruption.planRevision, f.chat.plan.revision);
  assert.equal(f.queue().length, 2);
  assert.equal(canResumeRun(f.runtime.snapshot.run), true);
});
