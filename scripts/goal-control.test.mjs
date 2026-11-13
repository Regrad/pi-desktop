import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { applyGoalReport } from "../shared/goal.ts";
import { updatedPlan } from "../shared/plan.ts";
import { confirmedPlanRevision } from "../shared/plan-activity.ts";
import { isPlanning, approvedPlanning, controlPlanningState } from "../shared/planning.ts";

// Exercise the real method bodies without starting Electron or a model.
// Remove only literal type assertions from these controller bodies; no project build.
const source = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
function method(name, parameters) {
  const start = source.indexOf(`\n  async ${name}(`);
  assert.ok(start >= 0, `Missing method ${name}`);
  const signature = "): Promise<void> {";
  const bodyStart = source.indexOf(signature, start) + signature.length;
  const bodyEnd = source.indexOf("\n  }", bodyStart);
  assert.ok(bodyStart > start && bodyEnd > bodyStart);
  const body = stripTypeScriptTypes(`async function invoke(${parameters.join(",")}) {${source.slice(bodyStart, bodyEnd)}\n}`);
  const execute = new Function("randomUUID", "updatedPlan", "confirmedPlanRevision", "isPlanning", "approvedPlanning", "controlPlanningState", `${body}; return invoke;`)(randomUUID, updatedPlan, confirmedPlanRevision, isPlanning, approvedPlanning, controlPlanningState);
  return function (...args) { return execute.call(this, ...args); };
}
const controlGoal = method("controlGoal", ["conversationId", "action"]);
const controlPlan = method("controlPlan", ["conversationId", "action"]);
const abort = method("abort", ["conversationId"]);
const editGoal = method("editGoal", ["conversationId", "objective"]);

function fixture(status = "active", working = true) {
  const conversation = { id: "chat", status: working ? "working" : "idle", goal: { id: "goal", objective: "Old objective", status, progress: "Stage underway", steps: 2, maxSteps: 25, stalledSteps: 0 } };
  const requests = [];
  const run = { startedAt: "now" };
  const runtime = { activeRun: run, snapshot: { state: { isStreaming: working } }, rpc: { async request(command) { requests.push(command); } } };
  const launches = [];
  const context = {
    invalidateStartup() {},
    store: { getConversation() { return conversation; }, async saveConversationRun() {} },
    runtimes: new Map([["chat", runtime]]),
    goalLaunching: new Set(), goalContinuationRequested: new Set(["chat"]),
    async updateConversation(id, patch) { assert.equal(id, "chat"); Object.assign(conversation, patch); },
    publish() {},
    launchGoal(id) { launches.push(id); },
  };
  context.abort = abort.bind(context);
  return { context, conversation, requests, runtime, run, launches };
}

test("manual checklist resume starts idle work without rewriting steps or a model call", async () => {
  const f = fixture("complete", false);
  f.conversation.plan = updatedPlan({ plan: [{ step: "Work", status: "in_progress" }], explanation: "Old interruption" });
  const steps = structuredClone(f.conversation.plan.steps);
  await controlPlan.call(f.context, "chat", "resume");
  assert.equal(f.conversation.plan.execution, "active");
  assert.equal(f.conversation.plan.explanation, undefined);
  assert.deepEqual(f.conversation.plan.steps, steps);
  assert.deepEqual(f.launches, ["chat"]);
  assert.deepEqual(f.requests, []);
});

test("manual checklist resume defers to existing work; pause does not abort it", async () => {
  const f = fixture("active", true);
  f.conversation.plan = updatedPlan({ plan: [{ step: "Work", status: "in_progress" }] });
  f.context.goalLaunching.add("chat");
  await controlPlan.call(f.context, "chat", "resume");
  assert.equal(f.context.goalContinuationRequested.has("chat"), true);
  assert.deepEqual(f.launches, []);
  await controlPlan.call(f.context, "chat", "pause");
  assert.equal(f.conversation.plan.execution, "paused");
  assert.equal(f.conversation.goal.status, "active");
  assert.equal(f.runtime.snapshot.state.isStreaming, true);
  assert.deepEqual(f.requests, []);
});

test("checklist manual resume cannot bypass paused goals or revive completed/removed plans", async () => {
  for (const status of ["paused", "blocked", "budget_limited"]) {
    const f = fixture(status, false);
    f.conversation.plan = updatedPlan({ plan: [{ step: "Work", status: "pending" }] });
    await assert.rejects(controlPlan.call(f.context, "chat", "resume"), /возобновите цель/);
    assert.equal(f.conversation.plan.execution, "paused");
    assert.deepEqual(f.launches, []);
  }
  const f = fixture("complete", false);
  await assert.rejects(controlPlan.call(f.context, "chat", "resume"), /не задан/);
  f.conversation.plan = updatedPlan({ plan: [{ step: "Done", status: "completed" }] });
  await assert.rejects(controlPlan.call(f.context, "chat", "resume"), /уже выполнен/);
  await assert.rejects(controlPlan.call(f.context, "chat", "invalid"), /Неизвестное/);
});

for (const action of ["pause", "remove"]) {
  test(`${action} disables goal continuation without aborting the streaming response`, async () => {
    const f = fixture();
    await controlGoal.call(f.context, "chat", action);
    assert.deepEqual(f.requests, []);
    assert.equal(f.runtime.snapshot.state.isStreaming, true);
    assert.equal(f.runtime.activeRun, f.run);
    assert.equal(f.conversation.status, "working");
    assert.equal(f.context.goalContinuationRequested.has("chat"), false);
    if (action === "pause") assert.equal(f.conversation.goal.status, "paused");
    else assert.equal(f.conversation.goal, undefined);
    assert.deepEqual(f.launches, []);
  });
}
test("Stop still aborts the current response and pauses an active goal", async () => {
  const f = fixture();
  await abort.call(f.context, "chat");
  assert.deepEqual(f.requests, ["abort"]);
  assert.equal(f.conversation.goal.status, "paused");
});

test("Stop dispatches abort before slow persistence and synchronously blocks goal and plan continuation", async () => {
  const f = fixture();
  f.conversation.plan = updatedPlan({ plan: [{ step: "Work", status: "in_progress" }], execution: "active" });
  const revision = f.conversation.plan.revision;
  let releaseSave;
  f.context.updateConversation = async () => new Promise(resolve => { releaseSave = resolve; });
  const stopping = abort.call(f.context, "chat");
  assert.deepEqual(f.requests, ["abort"]);
  assert.equal(f.conversation.goal.status, "paused");
  assert.equal(f.conversation.plan.execution, "paused");
  assert.equal(f.context.goalContinuationRequested.has("chat"), false);
  assert.throws(() => updatedPlan({ execution: "active", expectedRevision: revision }, f.conversation.plan), /changed/);
  releaseSave();
  await stopping;
});

test("persistence failure cannot prevent Stop cancellation", async () => {
  const f = fixture();
  f.context.updateConversation = async () => { throw Error("Disk locked"); };
  await assert.rejects(abort.call(f.context, "chat"), /Disk locked/);
  assert.deepEqual(f.requests, ["abort"]);
  assert.equal(f.conversation.goal.status, "paused");
});

test("Stop pauses state even without a running RPC process", async () => {
  const f = fixture();
  f.context.runtimes.clear();
  await abort.call(f.context, "chat");
  assert.deepEqual(f.requests, []);
  assert.equal(f.conversation.goal.status, "paused");
});
test("resume during a response reactivates the goal without a parallel prompt", async () => {
  const f = fixture("paused");
  await controlGoal.call(f.context, "chat", "resume");
  assert.deepEqual(f.requests, []);
  assert.equal(f.conversation.goal.status, "active");
  assert.equal(f.runtime.snapshot.state.isStreaming, true);
  assert.deepEqual(f.launches, []);
  await controlGoal.call(f.context, "chat", "resume");
  assert.deepEqual(f.launches, []);
});
test("resume starts an idle goal, but defers to an already launching stage", async () => {
  const f = fixture("paused", false);
  await controlGoal.call(f.context, "chat", "resume");
  assert.deepEqual(f.launches, ["chat"]);
  const launching = fixture("paused");
  launching.context.goalLaunching.add("chat");
  launching.context.goalContinuationRequested.clear();
  await controlGoal.call(launching.context, "chat", "resume");
  assert.equal(launching.conversation.goal.status, "active");
  assert.equal(launching.context.goalContinuationRequested.has("chat"), true);
  assert.deepEqual(launching.launches, []);
});
test("resume does not start a second response if the runtime is still streaming", async () => {
  const f = fixture("paused");
  f.conversation.status = "idle";
  await controlGoal.call(f.context, "chat", "resume");
  assert.equal(f.conversation.goal.status, "active");
  assert.deepEqual(f.launches, []);
});
test("resume followed by pause clears a pending continuation", async () => {
  const f = fixture("paused");
  f.context.goalLaunching.add("chat");
  await controlGoal.call(f.context, "chat", "resume");
  await controlGoal.call(f.context, "chat", "pause");
  assert.equal(f.conversation.goal.status, "paused");
  assert.equal(f.context.goalContinuationRequested.has("chat"), false);
  assert.deepEqual(f.requests, []);
});
test("completed goals are not reactivated by pause; missing goals are a no-op", async () => {
  const f = fixture("complete", false);
  await controlGoal.call(f.context, "chat", "pause");
  assert.equal(f.conversation.goal.status, "complete");
  await controlGoal.call(f.context, "chat", "remove");
  await controlGoal.call(f.context, "chat", "pause");
  assert.deepEqual(f.requests, []);
});

test("editing an active goal leaves its response running and rejects old-stage reports", async () => {
  const f = fixture();
  await editGoal.call(f.context, "chat", "  New objective  ");
  assert.equal(f.conversation.goal.objective, "New objective");
  assert.equal(f.conversation.goal.status, "active");
  assert.notEqual(f.conversation.goal.id, "goal");
  assert.equal(f.conversation.goal.progress, "");
  assert.equal(f.conversation.goal.steps, 0);
  assert.equal(f.runtime.snapshot.state.isStreaming, true);
  assert.deepEqual(f.requests, []);
  assert.deepEqual(f.launches, []);
  const edited = f.conversation.goal;
  assert.equal(applyGoalReport(edited, { goalId: "goal", status: "complete", progress: "Old goal done", evidence: "Test" }), edited);
});
test("editing paused/completed goals does not start them; active idle goals can launch", async () => {
  for (const status of ["paused", "blocked", "complete"]) {
    const f = fixture(status, false);
    await editGoal.call(f.context, "chat", "New objective");
    assert.equal(f.conversation.goal.status, "paused");
    assert.deepEqual(f.launches, []);
  }
  const idle = fixture("active", false);
  await editGoal.call(idle.context, "chat", "New objective");
  assert.deepEqual(idle.launches, ["chat"]);
  const launching = fixture();
  launching.context.goalLaunching.add("chat");
  launching.context.goalContinuationRequested.clear();
  await editGoal.call(launching.context, "chat", "New objective");
  assert.equal(launching.context.goalContinuationRequested.has("chat"), true);
});
test("editing validates text, preserves unchanged goals and cannot recreate a removed goal", async () => {
  const f = fixture();
  for (const text of [" ", "x".repeat(8001), null]) await assert.rejects(editGoal.call(f.context, "chat", text), /8000/);
  const goal = f.conversation.goal;
  await editGoal.call(f.context, "chat", " Old objective ");
  assert.equal(f.conversation.goal, goal);
  f.conversation.goal = undefined;
  await assert.rejects(editGoal.call(f.context, "chat", "New objective"), /удалена/);
});
