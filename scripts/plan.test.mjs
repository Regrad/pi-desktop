import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { updatedPlan, planContext, planPolicy, planTick, canContinuePlan, planRequestSuffix, planRequestText, requestedPlanContext, visiblePlanRequestText } from "../shared/plan.ts";
import { confirmedPlanRevision } from "../shared/plan-activity.ts";
import { isPlanning, approvedPlanning, planningToolAllowed } from "../shared/planning.ts";

const hooks = registerHooks({ resolve(specifier, context, next) {
  const local = ["../shared/plan.js", "../shared/goal.js", "./goal-extension.js", "./state-context.js"];
  return next(local.includes(specifier) ? specifier.replace(/\.js$/, ".ts") : specifier, context);
} });
const { default: planExtension, readDesktopPlan } = await import("../electron/plan-extension.ts");
const { default: goalExtension } = await import("../electron/goal-extension.ts");
const { stateFreshnessPolicy } = await import("../shared/goal.ts");
hooks.deregister();
const step = (text, status = "pending") => ({ step: text, status });

test("explanation-only plan writes carry a revision and reach the host writer", async () => {
  const tools = [], calls = [];
  let current = { steps: [step("Work", "in_progress")], execution: "active", revision: 7 };
  planExtension({ on() {}, registerTool(tool) { tools.push(tool); } }, () => current,
    async (name, params) => { calls.push(params); if (params.expectedRevision !== undefined) current = updatedPlan(params, current); return { plan: current }; });
  const result = await tools[0].execute("call", { explanation: "New verified evidence" });
  assert.equal(calls[0].expectedRevision, 7);
  assert.equal(JSON.parse(result.content[0].text).plan.revision, 8);
  assert.equal(JSON.parse(result.content[0].text).plan.explanation, undefined);
  assert.equal(current.explanation, "New verified evidence");
  const read = JSON.parse((await tools[0].execute("read", {})).content[0].text);
  assert.equal(read.plan.explanation, "New verified evidence");
  assert.deepEqual(read.plan.steps, current.steps);
  const source = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
  assert.match(source, /params\?\.plan === undefined && params\?\.execution === undefined && params\?\.explanation === undefined/);
});

test("pause is the only inactive mode exposed to the model; legacy waiting plans stay paused", () => {
  const legacy = { steps: [step("Work")], execution: "waiting", explanation: "Need clarification", revision: 3, updatedAt: "old" };
  assert.equal(canContinuePlan(legacy), false);
  assert.equal(updatedPlan({ plan: legacy.steps }, legacy).execution, "paused");
  assert.equal(updatedPlan({ execution: "paused", explanation: "Need approval" }, legacy).explanation, "Need approval");
  assert.match(planContext(legacy), /"execution":"paused"/);
  assert.doesNotMatch(planContext(legacy), /waiting/);
  const tools = [];
  planExtension({ on() {}, registerTool(tool) { tools.push(tool); } }, () => legacy);
  assert.deepEqual(tools[0].parameters.properties.execution.anyOf.map(value => value.const), ["active", "paused"]);
  assert.match(tools[0].description, /set execution=paused.*reason in explanation/);
  assert.match(tools[0].description, /New plans default to paused unless execution="active" is explicitly supplied/);
  assert.match(tools[0].description, /A paused plan does not imply that work was interrupted/);
  assert.match(tools[0].description, /Pausing disables automatic continuation, not the current response/);
  assert.match(tools[0].description, /Ending a normal response does not pause an active plan/);
  assert.match(tools[0].description, /omit plan to keep the steps unchanged/);
  assert.match(tools[0].description, /If execution is omitted, revisions preserve the current mode/);
  assert.match(tools[0].description, /do not resend unchanged steps/);

  const directory = mkdtempSync(path.join(tmpdir(), "pi-plan-legacy-"));
  const file = path.join(directory, "desktop-state.json");
  const previousFile = process.env.PI_DESKTOP_GOAL_STATE_FILE, previousId = process.env.PI_DESKTOP_CONVERSATION_ID;
  try {
    writeFileSync(file, JSON.stringify({ conversations: [{ id: "legacy", plan: legacy }] }));
    process.env.PI_DESKTOP_GOAL_STATE_FILE = file;
    process.env.PI_DESKTOP_CONVERSATION_ID = "legacy";
    assert.equal(readDesktopPlan().execution, "paused");
    assert.equal(readDesktopPlan().explanation, legacy.explanation);
    assert.equal(readDesktopPlan().revision, legacy.revision);
  } finally {
    if (previousFile === undefined) delete process.env.PI_DESKTOP_GOAL_STATE_FILE; else process.env.PI_DESKTOP_GOAL_STATE_FILE = previousFile;
    if (previousId === undefined) delete process.env.PI_DESKTOP_CONVERSATION_ID; else process.env.PI_DESKTOP_CONVERSATION_ID = previousId;
  }
});

test("continuation requires explicit execution, respects pause and inactive goals, ends on completion or clearing", () => {
  const proposed = updatedPlan({ plan: [step("Investigate")] });
  assert.equal(canContinuePlan(proposed), false);
  const active = updatedPlan({ execution: "active" }, proposed);
  assert.equal(canContinuePlan(active), true);
  assert.equal(updatedPlan({ plan: [step("Revised")] }, active).execution, "active");
  assert.equal(updatedPlan({ plan: [step("Revised")] }, proposed).execution, "paused");
  assert.deepEqual(active.steps, proposed.steps);
  for (const status of ["active", "paused", "blocked", "budget_limited"]) assert.equal(canContinuePlan(active, { status }), false);
  assert.equal(canContinuePlan(active, { status: "complete" }), true);
  assert.equal(canContinuePlan(updatedPlan({ execution: "paused", explanation: "Need user input" }, active)), false);
  assert.throws(() => updatedPlan({ execution: "waiting" }, active));
  assert.equal(canContinuePlan(updatedPlan({ plan: [] }, active)), false);
  assert.equal(canContinuePlan(updatedPlan({ plan: [step("Done", "completed")], execution: "active" }, active)), false);
  assert.throws(() => updatedPlan({ execution: "unknown" }, active));
});

test("real dispatcher uses one launch for goal and checklist, prioritizes user queue and streaming", async () => {
  const source = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
  const start = source.indexOf("  private launchGoal(");
  const begin = source.indexOf("): void {", start) + "): void {".length;
  const end = source.indexOf("\n  }", begin);
  const body = stripTypeScriptTypes(`function launch(conversationId, attachments = [], requestPlan = false, resumeBeforeQueue = false) {${source.slice(begin, end)}\n}`);
  const timers = [];
  const launch = new Function("canContinuePlan", "setTimeout", "isPlanning", "approvedPlanning", `${body};return launch;`)(canContinuePlan, callback => timers.push(callback), isPlanning, approvedPlanning);
  const conversation = { status: "idle", plan: updatedPlan({ plan: [step("Work")], execution: "active" }) };
  const calls = [], runtime = { snapshot: { state: { isStreaming: false } } };
  let queued = [];
  const host = { planningTransitions: new Set(), goalLaunching: new Set(), goalContinuationRequested: new Set(), runtimes: new Map([["chat", runtime]]),
    store: { getConversation: () => conversation, getQueuedPrompts: () => queued }, async sendPrompt(...args) { calls.push(args); } };
  launch.call(host, "chat"); launch.call(host, "chat");
  assert.equal(timers.length, 1);
  timers.shift()(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1); assert.equal(calls[0][7], conversation.plan.revision); assert.equal(calls[0][4], undefined);
  conversation.goal = { id: "goal", status: "active", steps: 1 };
  launch.call(host, "chat"); timers.shift()(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[1][4], "goal"); assert.equal(calls[1][7], undefined);
  conversation.goal.status = "paused"; launch.call(host, "chat"); assert.equal(timers.length, 0);
  delete conversation.goal; queued = [{}]; launch.call(host, "chat"); assert.equal(timers.length, 0);
  launch.call(host, "chat", [], false, true);
  assert.equal(timers.length, 1, "Explicit resume is not blocked by a held queue");
  timers.shift()(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[2][8], true);
  assert.equal(queued.length, 1);
  queued = []; runtime.snapshot.state.isStreaming = true; launch.call(host, "chat"); assert.equal(timers.length, 0);
});

test("Stop pauses checklist before abort and stale writes cannot revive it", async () => {
  const source = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
  const start = source.indexOf("  async abort(");
  const begin = source.indexOf("): Promise<void> {", start) + "): Promise<void> {".length;
  const end = source.indexOf("\n  }", begin);
  const body = stripTypeScriptTypes(`async function abort(conversationId) {${source.slice(begin, end)}\n}`);
  const abort = new Function("updatedPlan", `${body};return abort;`)(updatedPlan);
  const chat = { plan: updatedPlan({ plan: [step("Work")], execution: "active" }), goal: { id: "goal", status: "active", updatedAt: "2026-01-01T00:00:00.000Z" } };
  const revision = chat.plan.revision, calls = [];
  const host = { invalidateStartup() {}, goalContinuationRequested: new Set(), store: { getConversation: () => chat }, async updateConversation(_id, patch) { Object.assign(chat, patch); calls.push("save"); },
    runtimes: new Map([["chat", { rpc: { async request(type) { assert.equal(chat.plan.execution, "paused"); calls.push(type); } } }]]) };
  await abort.call(host, "chat");
  assert.deepEqual(calls, ["abort", "save"]);
  assert.equal(chat.goal.status, "paused");
  assert.ok(Date.parse(chat.goal.updatedAt) > Date.parse("2026-01-01T00:00:00.000Z"));
  assert.throws(() => updatedPlan({ execution: "active", expectedRevision: revision }, chat.plan), /changed/);
});

test("actual continuation sends service RPC, not another user prompt, and rechecks removed plans", async () => {
  const source = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
  const start = source.indexOf("  async sendPrompt(");
  const begin = source.indexOf("): Promise<void> {", start) + "): Promise<void> {".length;
  const end = source.indexOf("\n  }", begin);
  const body = stripTypeScriptTypes(`async function send(conversationId, message, attachments, behavior, expectedGoalId, historyEdit = false, requestPlan = false, expectedPlanRevision, resumeBeforeQueue = false) {${source.slice(begin, end)}\n}`);
  const send = new Function("canContinuePlan", "planContext", "imageAttachmentPrompt", "isPlanning", "approvedPlanning", `${body};return send;`)(canContinuePlan, planContext, () => "", isPlanning, approvedPlanning);
  const chat = { title: "Existing chat", plan: updatedPlan({ plan: [step("Work", "in_progress")], execution: "active" }) }, calls = [], events = [];
  const runtime = { snapshot: { state: { isStreaming: false } }, diffTracker: { covers: () => true, async beginRun() {} }, rpc: { async request(type, payload) { calls.push({ type, payload }); } } };
  let queue = [];
  const host = { startupEpochs: new Map(), async getModelServers() { return []; }, planningTransitions: new Set(), historyMutations: new Set(), runtimes: new Map([["chat", runtime]]), async ensureRuntime() { return runtime; }, async reloadPendingInstructions() {}, publish(_channel, payload) { events.push(payload.event); },
    store: { getConversation: () => chat, getQueuedPrompts: () => queue, async saveConversationRun() {}, async getConversationWorkspacePaths() { return []; } } };
  await send.call(host, "chat", "Service", [], undefined, undefined, false, false, chat.plan.revision);
  assert.equal(calls.length, 1); assert.equal(calls[0].type, "desktop_plan_continue");
  assert.match(calls[0].payload.message, /source="plan"/);
  assert.equal(events.find(event => event.type === "desktop_run_started").planWorkingRevision, chat.plan.revision,
    "The scheduled checklist run keeps its spinner active while agent_start is pending");
  queue = [{ id: "waiting" }];
  await send.call(host, "chat", "Service", [], undefined, undefined, false, false, chat.plan.revision);
  assert.equal(calls.length, 1, "Automatic continuation cannot jump ahead of queued input");
  await send.call(host, "chat", "Service", [], undefined, undefined, false, false, chat.plan.revision, true);
  assert.equal(calls.length, 2, "Explicit manual resume continues the interrupted task before queued input");
  assert.equal(queue.length, 1);
  assert.equal(runtime.runAborted, false);
  const revision = chat.plan.revision; chat.plan = updatedPlan({ plan: [] }, chat.plan);
  await send.call(host, "chat", "Service", [], undefined, undefined, false, false, revision);
  assert.equal(calls.length, 2);
});

test("plan continuation is not paused for turns without tools; errors and interruptions still pause", async () => {
  const source = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
  const queueStart = source.indexOf("      const hasQueued = this.store.getQueuedPrompts(conversationId).length > 0;");
  const guardStart = source.indexOf("      const currentPlan =", queueStart);
  const end = source.indexOf("      if (!completedNormally ||", guardStart);
  assert.ok(guardStart >= 0 && end > guardStart);
  const body = stripTypeScriptTypes(`async function settle(conversationId, runtime) { const completedNormally = !runtime.runAborted && runtime.runStopReason === "stop"; ${source.slice(guardStart, end)}\n}`);
  const settle = new Function("updatedPlan", `${body};return settle;`)(updatedPlan);
  const chat = { plan: updatedPlan({ plan: [step("Work")], execution: "active" }) };
  const host = { store: { getConversation: () => chat }, async updateConversation(_id, changes) { Object.assign(chat, changes); } };
  const runtime = { runStopReason: "stop" };
  for (let turn = 0; turn < 10; turn++) {
    await settle.call(host, "chat", runtime); assert.equal(chat.plan.execution, "active");
  }
  for (const reason of ["error", "aborted"]) {
    chat.plan = updatedPlan({ execution: "active" }, chat.plan);
    runtime.runStopReason = reason;
    await settle.call(host, "chat", runtime); assert.equal(chat.plan.execution, "paused");
  }
});

test("plan supports rewriting, reordering, adding, removing and resetting completed steps", () => {
  const first = updatedPlan({ plan: [step("Investigate", "completed"), step("Implement", "in_progress"), step("Verify")] });
  const next = updatedPlan({ expectedRevision: first.revision, explanation: "New evidence needs another check", plan: [step("Verify assumption", "in_progress"), step("Implement differently"), step("Investigate again")] }, first);
  assert.equal(next.revision, 2);
  assert.equal(next.steps[0].step, "Verify assumption");
  assert.equal(next.explanation, "New evidence needs another check");
  assert.equal(first.steps[0].status, "completed");
  assert.deepEqual(updatedPlan({ plan: [] }, next).steps, []);
});

test("invalid or stale updates cannot overwrite a valid plan", () => {
  const current = updatedPlan({ plan: [step("Work")] });
  for (const plan of [null, [step(" ")], [step("x", "unknown")], [step("a", "in_progress"), step("b", "in_progress")], Array(41).fill(step("x")), [step("x".repeat(301))]]) {
    assert.throws(() => updatedPlan({ plan }, current));
  }
  assert.throws(() => updatedPlan({ plan: [], expectedRevision: 0 }, current), /changed/);
  assert.throws(() => updatedPlan({ plan: [], explanation: 1 }, current), /explanation/);
  assert.equal(current.revision, 1);
});

test("extension injects live state after compaction, keeps prompt constant and forwards acknowledged updates", async () => {
  let current = updatedPlan({ plan: [step("Original", "in_progress")] });
  const handlers = new Map(), tools = [], calls = [];
  planExtension({ sendMessage() {}, on(name, handler) { handlers.set(name, handler); }, registerTool(tool) { tools.push(tool); } }, () => current,
    async (action, params) => { calls.push({ action, params }); if (params.plan !== undefined) current = updatedPlan(params, current); return { plan: current }; });
  assert.deepEqual(tools.map(tool => tool.name), ["update_plan"]);
  const before = handlers.get("before_agent_start")({ systemPrompt: "Base" });
  const history = [{ role: "user", content: "Task" }, { role: "compactionSummary", summary: "Old checklist" }];
  const projected = handlers.get("context")({ messages: history }).messages;
  assert.equal(projected.at(-1).role, "custom");
  assert.match(projected.at(-1).content, /Original/);
  assert.equal(history.length, 2);
  const result = await tools[0].execute("call", { explanation: "Revised", plan: [step("New", "completed")] });
  assert.equal(calls[0].action, "update_plan");
  assert.equal(calls[0].params.expectedRevision, 1);
  assert.equal(JSON.parse(result.content[0].text).plan.revision, 2);
  assert.deepEqual(before, handlers.get("before_agent_start")({ systemPrompt: "Base" }));
  const fresh = handlers.get("context")({ messages: projected }).messages;
  assert.equal(fresh.filter(message => message.customType === "desktop_plan_state").length, 2);
  assert.match(fresh.at(-1).content, /New/);
  assert.equal(fresh[2], projected[2]);
  assert.match(planContext(current), /does not resume a paused goal/);
  await tools[0].execute("read", {});
  assert.equal(calls.at(-1).params.expectedRevision, undefined);
});

test("actual host handler stores the checklist per chat and publishes through normal conversation updates", async () => {
  const source = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
  const start = source.indexOf("  private async handleGoalRequest(");
  const signature = "): Promise<unknown> {";
  const begin = source.indexOf(signature, start) + signature.length;
  const end = source.indexOf("\n  }", begin);
  const body = stripTypeScriptTypes(`async function handle(conversationId, request) {${source.slice(begin, end)}\n}`);
  const handle = new Function("updatedPlan", "confirmedPlanRevision", "isPlanning", "planningToolAllowed", `${body}; return handle;`)(updatedPlan, confirmedPlanRevision, isPlanning, planningToolAllowed);
  const chats = new Map([["one", {}], ["two", {}]]), published = [];
  const runtime = { snapshot: { state: { isStreaming: true } } }, events = [];
  const host = { runtimes: new Map([["one", runtime]]), publish(_channel, event) { events.push(event); }, store: { getConversation: id => chats.get(id) }, async updateConversation(id, changes) { Object.assign(chats.get(id), changes); published.push(id); } };
  const saved = await handle.call(host, "one", { action: "update_plan", params: { plan: [step("Check", "in_progress")] } });
  assert.equal(saved.plan.revision, 1);
  assert.equal(chats.get("two").plan, undefined);
  assert.deepEqual(published, ["one"]);
  assert.deepEqual(await handle.call(host, "one", { action: "update_plan", params: {} }), saved);
  await assert.rejects(handle.call(host, "one", { action: "update_plan", params: { plan: [], expectedRevision: 0 } }), /changed/);
  assert.equal(chats.get("one").plan.steps.length, 1);
  assert.equal(runtime.planWorkingRevision, undefined, "Paused creation does not animate");
  const active = await handle.call(host, "one", { action: "update_plan", params: { execution: "active", expectedRevision: 1 } });
  assert.equal(runtime.planWorkingRevision, active.plan.revision);
  assert.equal(runtime.snapshot.planWorkingRevision, active.plan.revision);
  assert.equal(events.at(-1).event.type, "desktop_plan_activity");
  assert.equal(events.at(-1).event.revision, active.plan.revision);
  const revision = runtime.planWorkingRevision;
  await handle.call(host, "one", { action: "update_plan", params: {} });
  assert.equal(runtime.planWorkingRevision, revision, "Read does not change activity");
  const explained = await handle.call(host, "one", { action: "update_plan", params: { explanation: "New evidence", expectedRevision: revision } });
  assert.equal(runtime.planWorkingRevision, explained.plan.revision, "Explanation edits preserve live activity");
  await handle.call(host, "one", { action: "update_plan", params: { execution: "paused", expectedRevision: explained.plan.revision } });
  assert.equal(runtime.planWorkingRevision, undefined, "Explicit pause clears live activity");
});

test("saved plan is read from the actual portable state for the current chat after restart", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "pi-plan-state-"));
  const file = path.join(directory, "desktop-state.json");
  const previousFile = process.env.PI_DESKTOP_GOAL_STATE_FILE, previousId = process.env.PI_DESKTOP_CONVERSATION_ID;
  try {
    const saved = updatedPlan({ plan: [step("Resume checklist", "in_progress")] });
    writeFileSync(file, JSON.stringify({ conversations: [{ id: "other", plan: { steps: [] } }, { id: "current", plan: saved }] }));
    process.env.PI_DESKTOP_GOAL_STATE_FILE = file;
    process.env.PI_DESKTOP_CONVERSATION_ID = "current";
    assert.deepEqual(readDesktopPlan(), JSON.parse(JSON.stringify(saved)));
    process.env.PI_DESKTOP_CONVERSATION_ID = "missing";
    assert.equal(readDesktopPlan(), undefined);
  } finally {
    if (previousFile === undefined) delete process.env.PI_DESKTOP_GOAL_STATE_FILE; else process.env.PI_DESKTOP_GOAL_STATE_FILE = previousFile;
    if (previousId === undefined) delete process.env.PI_DESKTOP_CONVERSATION_ID; else process.env.PI_DESKTOP_CONVERSATION_ID = previousId;
  }
});

test("user removal advances revision without aborting the response or mutating the goal", async () => {
  const source = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
  const start = source.indexOf("  async removePlan(");
  const signature = "): Promise<void> {";
  const begin = source.indexOf(signature, start) + signature.length;
  const end = source.indexOf("\n  }", begin);
  assert.ok(start >= 0 && begin > start && end > begin);
  const body = stripTypeScriptTypes(`async function remove(conversationId) {${source.slice(begin, end)}\n}`);
  const remove = new Function("updatedPlan", `${body}; return remove;`)(updatedPlan);
  const conversation = { goal: { id: "goal", status: "active" }, status: "working", plan: updatedPlan({ plan: [step("Work", "in_progress")] }) };
  const originalGoal = conversation.goal, originalRevision = conversation.plan.revision;
  const changes = [];
  const host = { store: { getConversation: () => conversation }, async updateConversation(_id, patch) { changes.push(patch); Object.assign(conversation, patch); }, abort() { throw Error("must not abort"); }, launchGoal() { throw Error("must not launch"); } };
  await remove.call(host, "chat");
  assert.equal(conversation.goal, originalGoal);
  assert.equal(conversation.status, "working");
  assert.deepEqual(Object.keys(changes[0]), ["plan"]);
  assert.deepEqual(conversation.plan.steps, []);
  assert.equal(conversation.plan.revision, originalRevision + 1);
  assert.throws(() => updatedPlan({ plan: [step("Stale update")], expectedRevision: originalRevision }, conversation.plan), /changed/);
  await remove.call(host, "chat");
  assert.equal(changes.length, 1);
});

test("cleared plan supersedes historical versions and instruction permits partial or complete replanning", () => {
  const current = updatedPlan({ plan: [] });
  const handlers = new Map();
  planExtension({ sendMessage() {}, on(name, handler) { handlers.set(name, handler); }, registerTool() {} }, () => current);
  const old = { role: "custom", customType: "desktop_plan_state", content: "Old checklist" };
  const projected = handlers.get("context")({ messages: [old] }).messages;
  assert.equal(projected.length, 2);
  assert.match(projected[1].content, /Checklist cleared/);
  assert.equal(projected[0], old);
  assert.match(planPolicy, /when the user requests one or when it helps/);
  assert.match(planPolicy, /For simple tasks, work without a checklist/);
  assert.match(planPolicy, /several tool calls alone do not make one necessary/);
  assert.match(planPolicy, /Before creating a plan, investigate/);
  assert.match(planPolicy, /Plan verifiable stages and results, not individual tool calls/);
  assert.match(planPolicy, /mark work completed only after verification/);
  assert.match(planPolicy, /revise steps when new evidence appears/);
  assert.match(planPolicy, /not force adherence to an obsolete approach/);
  assert.match(planPolicy, /revise the entire checklist/);
});

test("plan request becomes service context without changing the visible user message or later requests", () => {
  const flagged = { role: "user", content: [{ type: "text", text: "Discuss changes" + planRequestSuffix }, { type: "image", data: "image" }] };
  const original = structuredClone(flagged);
  const projected = requestedPlanContext([flagged]);
  assert.equal(projected.requested, true);
  assert.equal(projected.messages[0].content[0].text, "Discuss changes");
  assert.equal(projected.messages[0].content[1].data, "image");
  assert.deepEqual(flagged, original);
  assert.equal(visiblePlanRequestText("Discuss changes" + planRequestSuffix), "Discuss changes");
  assert.equal(requestedPlanContext([flagged, { role: "assistant", content: [] }, { role: "user", content: "Unmarked next message" }]).requested, false);
  assert.match(planRequestText, /carefully investigate the systems/);
  assert.match(planRequestText, /Only then create/);
  assert.match(planRequestText, /does not grant permission/);
  const handlers = new Map();
  planExtension({ on(name, handler) { handlers.set(name, handler); }, registerTool() {} }, () => undefined);
  const result = handlers.get("context")({ messages: [flagged] }).messages;
  assert.equal(result[0].content[0].text, "Discuss changes");
  assert.equal(result[1].customType, "desktop_plan_request");
  assert.equal(result[1].display, false);
});

test("queued marked messages preserve their preference through saving and dispatch", async () => {
  const storeSource = readFileSync(new URL("../electron/data-store.ts", import.meta.url), "utf8");
  const start = storeSource.indexOf("  async queuePrompt(");
  const signature = "): Promise<QueuedPrompt[]> {";
  const begin = storeSource.indexOf(signature, start) + signature.length;
  const end = storeSource.indexOf("\n  }", begin);
  const body = stripTypeScriptTypes(`async function queue(conversationId, message, attachments, requestPlan = false) {${storeSource.slice(begin, end)}\n}`);
  const queue = new Function("randomUUID", `${body};return queue;`)(() => "queued");
  let saved;
  const store = { state: { queuedPrompts: {} }, getConversation() {}, async save() { saved = JSON.parse(JSON.stringify(this.state)); } };
  const prompts = await queue.call(store, "chat", "Work", [], true);
  assert.equal(prompts[0].requestPlan, true);
  assert.equal(saved.queuedPrompts.chat[0].requestPlan, true);
  const manager = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
  const dispatchStart = manager.indexOf("  async sendQueuedPrompt(");
  const dispatchBegin = manager.indexOf(signature, dispatchStart) + signature.length;
  const dispatchEnd = manager.indexOf("\n  }", dispatchBegin);
  const dispatchBody = stripTypeScriptTypes(`async function dispatch(conversationId, promptId) {${manager.slice(dispatchBegin, dispatchEnd)}\n}`);
  const dispatch = new Function(`${dispatchBody};return dispatch;`)();
  const calls = [];
  const host = { store: { getQueuedPrompts: () => prompts, async removeQueuedPrompt() { return []; } }, runtimes: new Map(), async sendPrompt(...args) { calls.push(args); }, syncQueuedPrompts() {} };
  await dispatch.call(host, "chat", "queued");
  assert.equal(calls[0][6], true);
  assert.equal(calls[0][1], "Work");
});

test("plan state is persisted once, stays at its original position, and tool acknowledgements avoid duplication", async () => {
  let current = updatedPlan({ plan: [step("Work")], execution: "active" });
  const handlers = new Map(), persisted = [], tools = [];
  planExtension({ on(name, handler) { handlers.set(name, handler); }, registerTool(tool) { tools.push(tool); },
    sendMessage(message, options) { assert.deepEqual(options, { triggerTurn: false }); persisted.push({ ...message, role: "custom" }); }
  }, () => current, async (_action, params) => ({ plan: current = updatedPlan(params, current) }));
  const run = messages => handlers.get("context")({ messages }).messages;
  const user = { role: "user", content: "Work", timestamp: 1 };
  const first = run([user]);
  assert.equal(persisted.length, 1);
  const history = [...first, { role: "assistant", content: [] }, { role: "toolResult", toolName: "read", content: [] }];
  assert.deepEqual(run(history), history);
  assert.equal(persisted.length, 1);
  const result = await tools[0].execute("update", { execution: "paused" });
  history.push({ role: "toolResult", toolName: "update_plan", ...result });
  assert.deepEqual(run(history), history);
  assert.equal(persisted.length, 1);
  current = updatedPlan({ execution: "active" }, current);
  const changed = run(history);
  assert.deepEqual(changed.slice(0, -1), history);
  assert.equal(persisted.length, 2);
  const compacted = run([{ role: "compactionSummary", summary: "Earlier work" }]);
  assert.match(compacted.at(-1).content, /"execution":"active"/);
  assert.equal(persisted.length, 3);
});

test("delayed old plan reminder cannot overwrite a newer tool acknowledgement", () => {
  const current = { ...updatedPlan({ plan: [step("Work")] }), revision: 8 };
  const handlers = new Map(), sent = [];
  planExtension({ on(name, handler) { handlers.set(name, handler); }, registerTool() {},
    sendMessage(message) { sent.push(message); } }, () => current);
  const user = { role: "user", content: "тормозни", timestamp: 1 };
  const history = [user, { role: "toolResult", toolName: "update_plan", content: [{ type: "text", text: JSON.stringify({ plan: current }) }] },
    { role: "custom", customType: "desktop_plan_state", content: "old reminder", details: { stateKey: "7", userKey: "old" } }];
  assert.deepEqual(handlers.get("context")({ messages: history }).messages, history);
  assert.equal(sent.length, 0);
});

test("single step marks rewrite one row without resending the checklist", () => {
  const current = updatedPlan({ plan: [step("Investigate", "completed"), step("Implement"), step("Build")], execution: "active" });
  const marked = updatedPlan({ mark: 2, status: "in_progress" }, current);
  assert.deepEqual(marked.steps, [step("Investigate", "completed"), step("Implement", "in_progress"), step("Build")]);
  assert.equal(marked.execution, "active");
  assert.equal(marked.revision, current.revision + 1);
  assert.equal(updatedPlan({ mark: 3, status: "completed" }, marked).steps[2].status, "completed");
  assert.throws(() => updatedPlan({ mark: 3, status: "in_progress" }, marked), /Only one step may be in_progress/);
  assert.throws(() => updatedPlan({ mark: 0, status: "completed" }, current), /step number/);
  assert.throws(() => updatedPlan({ mark: 4, status: "completed" }, current), /step number from 1 to 3/);
  assert.throws(() => updatedPlan({ mark: 1.5, status: "completed" }, current), /step number/);
  assert.throws(() => updatedPlan({ mark: 1 }, current), /mark needs the new status/);
  assert.throws(() => updatedPlan({ status: "completed" }, current), /status writes a single marked step/);
  assert.throws(() => updatedPlan({ mark: 1, status: "completed", plan: current.steps }, current), /either mark/);
  assert.throws(() => updatedPlan({ mark: 1, status: "completed" }), /no checklist to mark/);
  assert.throws(() => updatedPlan({ mark: 1, status: "done" }, current), /pending, in_progress or completed/);
  assert.equal(updatedPlan({ mark: 1, status: "completed", expectedRevision: current.revision }, current).revision, current.revision + 1);
});

test("mark-only writes keep the revision guard and confirm working state like plan writes", async () => {
  const tools = [], calls = [];
  const current = { steps: [step("Work", "in_progress")], execution: "active", revision: 4 };
  planExtension({ on() {}, registerTool(tool) { tools.push(tool); } }, () => current,
    async (_action, params) => { calls.push(params); return { plan: updatedPlan(params, current) }; });
  const result = await tools[0].execute("call", { mark: 1, status: "completed" });
  assert.equal(calls[0].expectedRevision, 4);
  assert.equal(JSON.parse(result.content[0].text).plan.steps, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text).progress, { completed: 1, total: 1 });
  assert.deepEqual(tools[0].parameters.properties.mark.anyOf, undefined);
  assert.equal(tools[0].parameters.properties.mark.minimum, 1);
  assert.deepEqual(tools[0].parameters.properties.status.anyOf.map(value => value.const), ["pending", "in_progress", "completed"]);
  assert.match(tools[0].description, /\{mark: N, status\} where N is the 1-based position/);
  const source = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
  assert.match(source, /params\?\.explanation === undefined && params\?\.mark === undefined && params\?\.status === undefined\) return \{ plan: current \?\? null \}/);
  assert.equal(confirmedPlanRevision({ mark: 1, status: "completed" }, updatedPlan({ plan: [step("Work", "in_progress")], execution: "active" }), true), 1);
});

test("checklist tick reports progress without repeating the whole list", () => {
  const running = updatedPlan({ plan: [step("Investigate", "completed"), step("Implement", "in_progress"), step("Build")], execution: "active" });
  assert.match(planTick(running), /1\/3 completed, in progress: Implement, execution active/);
  assert.doesNotMatch(planTick(running), /"steps":\[/);
  assert.match(planTick(running), /revision 1/);
  assert.match(planTick(updatedPlan({ execution: "paused" }, running)), /execution paused/);
  assert.match(planTick(updatedPlan({ plan: [step("Short"), step("Second")] })), /0\/2 completed, next: Short/);
  assert.match(planTick(updatedPlan({ plan: [step("Д".repeat(120))] })), new RegExp(`${"Д".repeat(77)}…`));
  assert.doesNotMatch(planTick(running), /write a finished|continue|resume/i);
});

test("only active unfinished checklists get a short tick every three tool turns; acknowledgements reset it", () => {
  let current = updatedPlan({ plan: [step("Current", "in_progress"), step("Later")], execution: "active" });
  const handlers = new Map(), sent = [];
  planExtension({ on(name, handler) { handlers.set(name, handler); }, registerTool() {}, sendMessage(message) { sent.push(message); } }, () => current);
  const run = messages => handlers.get("context")({ messages }).messages;
  let history = run([{ role: "user", content: "Work" }]);
  const addTurn = () => history.push({ role: "assistant", content: [{ type: "toolCall", id: `call-${history.length}`, name: "read", arguments: {} }] },
    { role: "toolResult", toolName: "read", content: [] });
  for (let turn = 1; turn <= 9; turn++) {
    addTurn(); const next = run(history);
    assert.equal(next.length - history.length, turn % 3 === 0 ? 1 : 0);
    if (turn % 3 === 0) {
      assert.match(next.at(-1).content, /Checklist tick/);
      assert.doesNotMatch(next.at(-1).content, /Later|"steps"/);
      assert.deepEqual(next.slice(0, history.length), history);
    }
    history = next;
    assert.deepEqual(run(history), history, "same history cannot add another reminder");
  }
  addTurn(); addTurn();
  current = updatedPlan({ mark: 1, status: "completed" }, current);
  history.push({ role: "toolResult", toolName: "update_plan", content: [{ type: "text", text: JSON.stringify({ plan: current }) }] });
  assert.deepEqual(run(history), history);
  addTurn(); assert.deepEqual(run(history), history, "a plan write just presented the latest state");
  current = updatedPlan({ execution: "paused" }, current); history = run(history);
  for (let turn = 0; turn < 10; turn++) { addTurn(); assert.deepEqual(run(history), history); }
  current = updatedPlan({ mark: 2, status: "completed" }, current); history = run(history);
  history.push({ role: "user", content: "Unrelated question" });
  assert.deepEqual(run(history), history, "completed lists do not generate reminders");
});

test("active checklist gets a compact tick on a new user turn so marks cannot lag behind", () => {
  const current = updatedPlan({ plan: [step("Investigate", "completed"), step("Implement", "in_progress"), step("Build")], execution: "active" });
  const handlers = new Map(), persisted = [];
  planExtension({ on(name, handler) { handlers.set(name, handler); }, registerTool() {},
    sendMessage(message, options) { assert.deepEqual(options, { triggerTurn: false }); persisted.push(message); } }, () => current);
  const run = messages => handlers.get("context")({ messages }).messages;
  let history = run([{ role: "user", content: "Делай", timestamp: 1 }]);
  assert.match(history.at(-1).content, /Checklist snapshot/);
  history.push({ role: "assistant", content: [] }, { role: "toolResult", toolName: "edit", content: [] });
  assert.deepEqual(run(history), history);
  history.push({ role: "user", content: "Продолжай", timestamp: 2 });
  history = run(history);
  assert.match(history.at(-1).content, /Checklist tick/);
  assert.match(history.at(-1).content, /1\/3 completed/);
  history.push({ role: "toolResult", toolName: "read", content: [] });
  assert.deepEqual(run(history), history);
  assert.equal(persisted.length, 2);
});

test("checklist gets one short factual reminder per new user message, not per tool", () => {
  let current = updatedPlan({ plan: [step("Work")] });
  const handlers = new Map(), persisted = [];
  planExtension({ on(name, handler) { handlers.set(name, handler); }, registerTool() {},
    sendMessage(message, options) { assert.deepEqual(options, { triggerTurn: false }); persisted.push(message); }
  }, () => current);
  const run = messages => handlers.get("context")({ messages }).messages;
  let history = run([{ role: "user", content: "Work", timestamp: 1 }]);
  assert.match(history.at(-1).content, /"execution":"paused"/);
  history.push({ role: "assistant", content: [] }, { role: "toolResult", toolName: "read", content: [] });
  assert.deepEqual(run(history), history);
  history.push({ role: "user", content: "What is the status?", timestamp: 2 });
  history = run(history);
  assert.equal(history.at(-1).content, planTick(current));
  assert.match(history.at(-1).content, /execution paused/);
  assert.equal(history.at(-1).details.workState.revision, current.revision);
  history.push({ role: "toolResult", toolName: "read", content: [] });
  assert.deepEqual(run(history), history);
  assert.equal(persisted.length, 2);
  current = updatedPlan({ execution: "active" }, current);
  history = run(history);
  assert.match(history.at(-1).content, /"execution":"active"/);
  history.push({ role: "user", content: "Another question", timestamp: 3 });
  history = run(history);
  assert.match(history.at(-1).content, /Checklist tick/);
  assert.match(history.at(-1).content, /execution active/);
  current = updatedPlan({ plan: [] }, current);
  history = run(history);
  history.push({ role: "user", content: "One more question", timestamp: 4 });
  assert.deepEqual(run(history), history);
});

test("marked plan request stays adjacent to its original user message across tool steps", () => {
  const handlers = new Map();
  planExtension({ on(name, handler) { handlers.set(name, handler); }, registerTool() {}, sendMessage() { throw Error("no state to persist"); } }, () => undefined);
  const flagged = { role: "user", content: "Investigate" + planRequestSuffix };
  const history = [flagged, { role: "assistant", content: [] }, { role: "toolResult", content: [] }];
  const first = handlers.get("context")({ messages: [flagged] }).messages;
  const next = handlers.get("context")({ messages: history }).messages;
  assert.deepEqual(next.slice(0, first.length), first);
  assert.equal(next.filter(message => message.customType === "desktop_plan_request").length, 1);
  assert.equal(next.at(-1).role, "toolResult");
});

test("old paused snapshot cannot be described as live after a newer active acknowledgement", () => {
  const paused = { ...updatedPlan({ plan: [step("Work")] }), revision: 3 };
  const active = updatedPlan({ execution: "active" }, paused);
  const handlers = new Map();
  planExtension({ on(name, handler) { handlers.set(name, handler); }, registerTool() {},
    sendMessage() { throw Error("acknowledged state must not be repeated"); } }, () => active);
  const messages = [{ role: "user", content: "Wait" },
    { role: "custom", customType: "desktop_plan_state", content: planContext(paused), details: { stateKey: "3" } },
    { role: "user", content: "Continue" },
    { role: "toolResult", toolName: "update_plan", content: [{ type: "text", text: JSON.stringify({ plan: active }) }] }];
  assert.deepEqual(handlers.get("context")({ messages }).messages, messages);
  const prompt = handlers.get("before_agent_start")({ systemPrompt: "Base" }).systemPrompt;
  assert.ok(prompt.includes(stateFreshnessPolicy));
  assert.match(prompt, /higher revision supersedes a lower revision/);
  assert.match(prompt, /latest user instruction supersedes earlier conflicting user instructions/);
  assert.match(prompt, /whether it says stop, wait or continue/);
  assert.match(prompt, /end the response without further task tools/);
  assert.doesNotMatch(prompt, /block is current application state/);
  assert.match(planContext(paused), /Checklist snapshot/);
  assert.match(planContext(paused), /Later confirmed states supersede this snapshot/);
});

test("shared state freshness rules are included once regardless of goal/plan extension order", () => {
  for (const order of [[planExtension, goalExtension], [goalExtension, planExtension]]) {
    let systemPrompt = "Base";
    for (const extension of order) {
      const handlers = new Map();
      extension({ on(name, handler) { handlers.set(name, handler); }, registerTool() {} }, () => undefined);
      systemPrompt = handlers.get("before_agent_start")({ systemPrompt }).systemPrompt;
    }
    assert.equal(systemPrompt.split(stateFreshnessPolicy).length - 1, 1);
    assert.doesNotMatch(systemPrompt, /block is current application state|it overrides historical goals and summaries/);
  }
});
