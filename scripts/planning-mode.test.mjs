import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { isPlanning, approvedPlanning, completePlanning, controlPlanningState, revisePlanning, planningToolAllowed, planningContext, planningLimit } from "../shared/planning.ts";
import { updatedPlan, canContinuePlan } from "../shared/plan.ts";
import { desktopPlanningLocked, assertPlanningModelAccess, guardExtensionHandler } from "../resources/tool-routing/desktop-planning-permissions.js";
import { discardDelayedStateSnapshots, projectDesktopServiceContext } from "../resources/pi-rpc-bridge/service-context.js";
import { patchToolRouting, patchCodemodePlanning } from "../resources/tool-routing/patch.js";

const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
    const file = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
    if (existsSync(file)) return next(file.href, context);
  }
  return next(specifier, context);
} });
const { default: planningExtension, readDesktopPlanning } = await import("../electron/planning-extension.ts");
hook.deregister();
const source = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
function hostMethod(name, signature, bindings = {}) {
  const start = source.indexOf(name), begin = source.indexOf("): Promise<", start);
  assert.ok(start > 0, name);
  const body = source.indexOf(" {", begin) + 2, end = source.indexOf("\n  }", body);
  const code = stripTypeScriptTypes(`${signature} {${source.slice(body, end)}\n}`, { mode: "transform" });
  return new Function(...Object.keys(bindings), `${code};return run;`)(...Object.values(bindings));
}
function fixture() {
  const handlers = new Map(), tools = new Map(), messages = [];
  let state = controlPlanningState("start", 0);
  planningExtension({ on(name, callback) { handlers.set(name, callback); }, registerTool(tool) { tools.set(tool.name, tool); },
    getAllTools: () => [...tools.values()], getActiveTools: () => [...tools.keys()], setActiveTools() {}, sendMessage(message) { messages.push(message); } }, () => state, async (_name, params) => {
    if (Object.keys(params).length) state = params.complete !== undefined ? completePlanning(params, state) : revisePlanning(params, state);
    return { planning: state };
  });
  return { handlers, tools, messages, get state() { return state; }, set state(value) { state = value; } };
}
function review(state = controlPlanningState("start", 0)) {
  return revisePlanning({ content: "Plan", ready: true, expectedRevision: state.revision }, state);
}
function approve(state) { return controlPlanningState("approve", state.revision, state); }
function removeTemporary(folder) {
  assert.ok(path.resolve(folder).startsWith(path.resolve("C:/AI_Temp") + path.sep));
  rmSync(folder, { recursive: true, force: true });
}

test("approval is user-controlled and bound to a nonempty reviewed revision", () => {
  const state = controlPlanningState("start", 0);
  assert.equal(isPlanning(state), true);
  assert.throws(() => controlPlanningState("approve", state.revision, state), /готового плана/);
  const ready = review(state), accepted = approve(ready);
  assert.throws(() => controlPlanningState("approve", ready.revision - 1, ready), /изменился/);
  assert.equal(approvedPlanning(accepted), true);
  assert.equal(isPlanning(accepted), false);
  const updated = revisePlanning({ content: "Refined approach", expectedRevision: accepted.revision }, accepted);
  assert.equal(updated.phase, "working");
  assert.equal(updated.approvedRevision, undefined, "do not claim the user approved edited text");
  assert.equal(isPlanning(updated), false);
  const revised = controlPlanningState("revise", accepted.revision, accepted);
  assert.equal(revised.approvedRevision, undefined);
  assert.equal(isPlanning(revised), true);
  assert.equal(isPlanning({ ...accepted, approvedRevision: undefined }), true);
  assert.equal(isPlanning({ phase: "unknown" }), true);
  const cancelled = controlPlanningState("cancel", revised.revision, revised);
  assert.equal(cancelled.content, accepted.content);
  assert.equal(cancelled.phase, "inactive");
  assert.match(planningContext(cancelled), /neither authorizes historical work/);
});

test("model can create, edit and finish a plan in normal mode without a review gate", async () => {
  const f = fixture(); f.state = undefined;
  f.handlers.get("context")({ messages: [] });
  const tool = f.tools.get("update_implementation_plan");
  await tool.execute("create", { content: "Investigate\nImplement", ready: true });
  assert.equal(f.state.phase, "working");
  assert.equal(isPlanning(f.state), false);
  assert.equal(approvedPlanning(f.state), false);
  assert.equal(f.handlers.get("tool_call")({ toolName: "write", input: {} }), undefined);
  assert.equal(f.handlers.get("user_bash")(), undefined);
  await tool.execute("append", { append: "\nVerify" });
  await tool.execute("edit", { old_text: "Implement", new_text: "Implement and test" });
  assert.equal(f.state.content, "Investigate\nImplement and test\nVerify");
  assert.equal(f.state.phase, "working");
  assert.match(planningContext(f.state), /normal mode/i);
  assert.doesNotMatch(planningContext(f.state), /implementation is forbidden/);
  await tool.execute("complete", { complete: true });
  assert.equal(f.state.phase, "completed");
});

test("saved and completed documents can be revised without entering Plan mode", () => {
  for (const state of [undefined, { content: "old", phase: "inactive", revision: 5 }, { content: "old", phase: "completed", revision: 5 }]) {
    const next = revisePlanning({ content: "Current task", expectedRevision: state?.revision ?? 0 }, state);
    assert.equal(next.phase, "working");
    assert.equal(isPlanning(next), false);
    assert.throws(() => revisePlanning({ append: "stale", expectedRevision: next.revision - 1 }, next), /изменился/);
    assert.equal(isPlanning(controlPlanningState("start", next.revision, next)), true);
  }
});

test("targeted edits preserve surrounding text and reject ambiguous, stale or oversized updates", () => {
  const state = revisePlanning({ content: "Первый пункт\nВторой пункт", expectedRevision: 1 }, controlPlanningState("start", 0));
  const revised = revisePlanning({ old_text: "Второй", new_text: "Последний", expectedRevision: state.revision }, state);
  assert.equal(revised.content, "Первый пункт\nПоследний пункт");
  assert.equal(revisePlanning({ append: "\nПроверить", expectedRevision: revised.revision }, revised).content, revised.content + "\nПроверить");
  for (const params of [{ old_text: "пункт", new_text: "x" }, { old_text: "absent", new_text: "x" }, { old_text: "Первый" }, { ready: "true" }, { content: "x".repeat(planningLimit + 1) }, { content: "", ready: true }, { content: "x", append: "y" }, { expectedRevision: 0 }])
    assert.throws(() => revisePlanning({ expectedRevision: state.revision, ...params }, state));
  assert.equal(state.content, "Первый пункт\nВторой пункт");
});

test("a prose specification is completed explicitly, independently of checklist marks", () => {
  const prose = "## Задача\nПодробное описание ожидаемого результата.\n\n## Подход\nАрхитектура, ограничения и способ проверки, без списка рабочих шагов.";
  const state = approve(revisePlanning({ content: prose, ready: true, expectedRevision: 1 }, controlPlanningState("start", 0)));
  const checklist = updatedPlan({ plan: [{ step: "Реализовать", status: "in_progress" }, { step: "Проверить", status: "pending" }], execution: "active" });
  assert.throws(() => completePlanning({ complete: true, expectedRevision: state.revision }, state, checklist), /незавершённые/);
  const checked = updatedPlan({ plan: checklist.steps.map(step => ({ ...step, status: "completed" })) }, checklist);
  assert.equal(state.phase, "implementation", "finishing the checklist does not finish the specification");
  const done = completePlanning({ complete: true, expectedRevision: state.revision }, state, checked);
  assert.equal(done.phase, "completed"); assert.equal(done.content, prose);
  assert.equal(isPlanning(done), false); assert.equal(approvedPlanning(done), false);
  assert.match(planningContext(done), /completed and retained for reference/);
  assert.doesNotMatch(planningContext(done), /PLAN mode: implementation is forbidden/);
  assert.equal(completePlanning({ complete: true, expectedRevision: done.revision }, done), done);
  assert.equal(controlPlanningState("revise", done.revision, done).phase, "draft");
  assert.equal(completePlanning({ complete: true, expectedRevision: state.revision }, state).phase, "completed", "a checklist is optional");
  for (const current of [undefined, controlPlanningState("start", 0), review()])
    assert.throws(() => completePlanning({ complete: true, expectedRevision: current?.revision ?? 0 }, current), /согласованный/);
  assert.throws(() => completePlanning({ complete: true, expectedRevision: state.revision - 1 }, state), /изменился/);
  for (const params of [{ complete: false }, { complete: true, content: "changed" }, { complete: true, ready: true }])
    assert.throws(() => completePlanning({ expectedRevision: state.revision, ...params }, state), /только complete/);
});

test("model can finish an approved document through the existing tool without resending it", async () => {
  const f = fixture(); f.state = approve(review(f.state));
  f.handlers.get("context")({ messages: [{ role: "user", content: "Implement" }] });
  const content = f.state.content, tool = f.tools.get("update_implementation_plan");
  const result = await tool.execute("complete", { complete: true });
  assert.equal(JSON.parse(result.content[0].text).planning.phase, "completed");
  assert.equal(f.state.content, content);
});

test("normal tools remain discoverable; direct and nested execution obey the live permission", () => {
  const f = fixture(), guard = f.handlers.get("tool_call");
  for (const name of ["read", "grep", "find", "ls", "codemode", "web_search", "get_search_content"]) assert.equal(planningToolAllowed(name), true);
  for (const name of ["write", "edit", "bash", "powershell", "apply_patch", "manage_skills", "create_goal", "update_goal", "comfyui_run_workflow", "unknown_readonly_hint"]) {
    assert.equal(planningToolAllowed(name), false);
    for (const parentToolCallId of [undefined, "outer/1"]) assert.equal(guard({ toolName: name, input: {}, parentToolCallId }).block, true);
  }
  for (const name of ["update_notebook", "update_plan"]) {
    assert.equal(planningToolAllowed(name, {}), true);
    assert.equal(planningToolAllowed(name, { execution: "active" }), false);
    assert.equal(planningToolAllowed(name, { content: "bad" }), false);
  }
  assert.equal(planningToolAllowed("browser", { action: "snapshot" }), true);
  for (const action of ["click", "type", "fill", "upload", "webmcp-call", "key", "dialog"]) assert.equal(planningToolAllowed("browser", { action }), false);
  assert.equal(planningToolAllowed("manage_skills", { action: "read" }), true);
  assert.equal(planningToolAllowed("manage_skills", { action: "delete" }), false);
  assert.equal(planningToolAllowed("lsp_navigation", { operation: "references" }), true);
  assert.equal(planningToolAllowed("lsp_navigation", { operation: "rename", apply: true }), false);
  assert.equal(planningToolAllowed("lsp_navigation", { operation: "executeCommand" }), false);
  assert.equal(planningToolAllowed("media_status", {}), true);
  assert.equal(planningToolAllowed("comfyui_job", { action: "cancel" }), false);
  assert.equal(f.handlers.get("user_bash")().result.exitCode, 1);
  f.state = approve(review(f.state));
  assert.equal(guard({ toolName: "write", input: {} }), undefined, "same extension, no process restart");
  assert.equal(f.handlers.get("user_bash")(), undefined);
});

test("web research uses existing tools with read-only operations", () => {
  const guard = fixture().handlers.get("tool_call");
  const search = { toolName: "web_search", input: { workflow: "summary-review", includeContent: true } };
  assert.equal(guard(search), undefined);
  assert.equal(search.input.workflow, "none"); assert.equal(search.input.includeContent, false);
  const fetch = { toolName: "fetch_content", input: { url: "https://example.org" } };
  assert.equal(guard(fetch), undefined); assert.equal(fetch.input.mode, "raw");
  for (const input of [{ mode: "answer" }, { mode: "raw", forceClone: true }, { mode: "raw", frames: 3 }]) assert.equal(guard({ toolName: "fetch_content", input }).block, true);
});

test("system prompt and tool contracts do not depend on the current mode", () => {
  const f = fixture();
  f.handlers.get("session_start")({}, { cwd: "C:/AI_Temp" });
  assert.deepEqual([...f.tools.keys()].sort(), ["find", "grep", "ls", "update_implementation_plan"]);
  const schemas = JSON.stringify([...f.tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters })));
  const system = f.handlers.get("before_agent_start")({ systemPrompt: "Base prompt" }).systemPrompt;
  const active = approve(review());
  for (const state of [undefined, review(), active, completePlanning({ complete: true, expectedRevision: active.revision }, active), controlPlanningState("cancel", 1, controlPlanningState("start", 0))]) {
    f.state = state;
    assert.equal(f.handlers.get("before_agent_start")({ systemPrompt: "Base prompt" }).systemPrompt, system);
    assert.equal(JSON.stringify([...f.tools.values()].map(({ name, description, parameters }) => ({ name, description, parameters }))), schemas);
  }
  assert.equal(f.tools.has("planning_tools"), false); assert.equal(f.tools.has("planning_fetch"), false);
});

test("document context is revision-based, not repeated per tool or represented as another user request", async () => {
  const f = fixture(), history = [{ role: "user", content: "Make a plan" }], context = f.handlers.get("context");
  const first = context({ messages: history }).messages;
  context({ messages: first }); assert.equal(f.messages.length, 1);
  await f.tools.get("update_implementation_plan").execute("id", { content: "Plan", ready: true });
  const result = { role: "toolResult", toolName: "update_implementation_plan", content: [{ type: "text", text: JSON.stringify({ planning: f.state }) }] };
  context({ messages: [...first, result] }); assert.equal(f.messages.length, 1);
  context({ messages: [{ role: "compactionSummary", summary: "Task" }] }); assert.equal(f.messages.length, 2);
  assert.equal(discardDelayedStateSnapshots([history[0], result, first.at(-1)]).length, 2);
  const projected = projectDesktopServiceContext(first);
  assert.equal(projected.filter(message => message.role === "user").length, 1);
  assert.equal(projected.filter(message => message.role === "custom").length, 0);
});

test("planning uses short phase reminders and write acknowledgements, restoring the full specification when needed", async () => {
  const f = fixture(), context = messages => f.handlers.get("context")({ messages }).messages;
  let history = context([{ role: "user", content: "Plan the change" }]);
  const response = await f.tools.get("update_implementation_plan").execute("write", { content: "Detailed specification\n".repeat(300), ready: true });
  const ack = { role: "toolResult", toolName: "update_implementation_plan", ...response };
  assert.equal(JSON.parse(response.content[0].text).planning.content, undefined);
  assert.ok(response.content[0].text.length < 180);
  history.push(ack); assert.deepEqual(context(history), history, "a write must not cause another full snapshot");
  history.push({ role: "user", content: "What stage is this?" });
  let next = context(history);
  assert.deepEqual(next.slice(0, history.length), history);
  assert.match(next.at(-1).content, /Planning document: review/);
  assert.doesNotMatch(next.at(-1).content, /Detailed specification/);
  assert.deepEqual(context(next), next);
  const read = await f.tools.get("update_implementation_plan").execute("read", {});
  assert.equal(JSON.parse(read.content[0].text).planning.content, f.state.content);
  const restored = context([{ role: "compactionSummary", summary: "Earlier work" }, ack]);
  assert.ok(restored.at(-1).content.includes(f.state.content.replaceAll("\n", "\\n")), "compact acknowledgement cannot replace the document after compaction");
  f.state = approve(f.state); history = context(next);
  assert.match(history.at(-1).content, /Detailed specification/, "approval supplies the full agreed specification");
  f.state = completePlanning({ complete: true, expectedRevision: f.state.revision }, f.state);
  next = context(history); assert.match(next.at(-1).content, /Planning document: completed/);
  next.push({ role: "user", content: "Another task" }); assert.deepEqual(context(next), next);
});

test("review/approval is version-checked and never stops or replaces the Pi process", async () => {
  const control = hostMethod("  async controlPlanning(", "async function run(conversationId, action, expectedRevision)", { controlPlanningState, updatedPlan });
  const chat = { status: "idle", planning: review(), goal: { status: "active" }, plan: updatedPlan({ plan: [{ step: "Old", status: "pending" }], execution: "active" }) };
  const events = [], runtime = { snapshot: { state: { isStreaming: true } }, eventQueue: Promise.resolve() }; let queue = [];
  const host = { planningTransitions: new Set(), planningWrites: new Set(), goalContinuationRequested: new Set(), startingRuntimes: new Map(), runtimes: new Map([["chat", runtime]]),
    store: { getConversation: () => chat, getQueuedPrompts: () => queue }, async stopConversation() { throw new Error("must not restart"); },
    async updateConversation(_id, patch) { Object.assign(chat, patch); events.push("persist"); }, async sendPrompt() { assert.equal(this.planningTransitions.size, 0); events.push("implement"); } };
  await assert.rejects(control.call(host, "chat", "approve", chat.planning.revision), /остановите/);
  runtime.snapshot.state.isStreaming = false;
  queue = [{}]; await assert.rejects(control.call(host, "chat", "approve", chat.planning.revision), /очереди/);
  queue = []; await assert.rejects(control.call(host, "chat", "approve", chat.planning.revision - 1), /изменился/);
  await control.call(host, "chat", "approve", chat.planning.revision);
  assert.deepEqual(events, ["persist", "implement"]);
  assert.equal(host.runtimes.get("chat"), runtime); assert.equal(chat.goal.status, "paused");
  assert.equal(approvedPlanning(chat.planning), true); assert.deepEqual(chat.plan.steps, []);
});

test("host independently blocks mutations, stale updates and late writes after Stop", async () => {
  const handle = hostMethod("  private async handleGoalRequest(", "async function run(conversationId, request)", { isPlanning, planningToolAllowed, revisePlanning, completePlanning });
  const chat = { planning: controlPlanningState("start", 0) };
  const host = { store: { getConversation: () => chat }, runtimes: new Map([["chat", { runAborted: false }]]), planningWrites: new Set(), async updateConversation(_id, patch) { Object.assign(chat, patch); } };
  for (const request of [{ action: "update_notebook", params: { append: "bad" } }, { action: "update_plan", params: { execution: "active" } }, { action: "browser", params: { action: "click" } }, { action: "create_goal", params: { objective: "bad" } }, { action: "manage_skills", params: { action: "delete" } }])
    await assert.rejects(handle.call(host, "chat", request), /запрещены/);
  await handle.call(host, "chat", { action: "update_implementation_plan", params: { content: "Plan", ready: true, expectedRevision: chat.planning.revision } });
  host.runtimes.get("chat").runAborted = true;
  await assert.rejects(handle.call(host, "chat", { action: "update_implementation_plan", params: { content: "bad", expectedRevision: chat.planning.revision } }), /отменено/);
});

test("host saves normal-mode plans without pausing authorized work or starting review", async () => {
  const handle = hostMethod("  private async handleGoalRequest(", "async function run(conversationId, request)", { isPlanning, planningToolAllowed, revisePlanning, completePlanning });
  const chat = { goal: { status: "active" }, plan: updatedPlan({ plan: [{ step: "Implement", status: "in_progress" }], execution: "active" }) };
  const host = { store: { getConversation: () => chat }, runtimes: new Map([["chat", { runAborted: false }]]), planningWrites: new Set(), async updateConversation(_id, patch) { Object.assign(chat, patch); } };
  await handle.call(host, "chat", { action: "update_implementation_plan", params: { content: "Approach and verification", ready: true, expectedRevision: 0 } });
  assert.equal(chat.planning.phase, "working");
  assert.equal(chat.goal.status, "active");
  assert.equal(chat.plan.execution, "active");
  assert.throws(() => completePlanning({ complete: true, expectedRevision: chat.planning.revision }, chat.planning, chat.plan), /незавершённые/);
  await assert.rejects(handle.call(host, "chat", { action: "update_implementation_plan", params: { append: "stale", expectedRevision: 0 } }), /изменился/);
  host.runtimes.get("chat").runAborted = true;
  await assert.rejects(handle.call(host, "chat", { action: "update_implementation_plan", params: { append: "late", expectedRevision: chat.planning.revision } }), /отменено/);
});

test("queue waits at review and active goals/checklists cannot start implementation without approval", async () => {
  const drain = hostMethod("  private async sendNextQueuedPrompt(", "async function run(conversationId)");
  let sends = 0; const chat = { planning: { phase: "review" } };
  const host = { planningTransitions: new Set(), store: { getConversation: () => chat, getQueuedPrompts: () => [{ id: "queued" }] }, async sendQueuedPrompt() { sends++; } };
  await drain.call(host, "chat"); assert.equal(sends, 0);
  chat.planning.phase = "draft"; await drain.call(host, "chat"); assert.equal(sends, 1);
  const start = source.indexOf("  private launchGoal("), begin = source.indexOf("): void {", start) + "): void {".length, end = source.indexOf("\n  }", begin);
  const code = stripTypeScriptTypes(`function run(conversationId, attachments = [], requestPlan = false, resumeBeforeQueue = false) {${source.slice(begin, end)}\n}`);
  const timers = [], calls = [];
  const launch = new Function("canContinuePlan", "isPlanning", "approvedPlanning", "setTimeout", `${code};return run;`)(canContinuePlan, isPlanning, approvedPlanning, callback => timers.push(callback));
  const task = { status: "idle", planning: controlPlanningState("start", 0), goal: { id: "old", status: "active" }, plan: updatedPlan({ plan: [{ step: "Work", status: "pending" }], execution: "active" }) };
  const runner = { planningTransitions: new Set(), goalLaunching: new Set(), goalContinuationRequested: new Set(), runtimes: new Map([["chat", { snapshot: { state: { isStreaming: false } } }]]),
    store: { getConversation: () => task, getQueuedPrompts: () => [] }, async sendPrompt(...args) { calls.push(args); } };
  launch.call(runner, "chat"); assert.equal(timers.length, 0);
  task.planning = review(task.planning); launch.call(runner, "chat"); assert.equal(timers.length, 0);
  task.planning = approve(task.planning); task.goal.status = "paused";
  launch.call(runner, "chat"); timers.shift()(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[0][4], undefined); assert.equal(calls[0][7], task.plan.revision);
});

test("live state survives restart, fails closed, and guards hidden model APIs and Lens mutations", () => {
  const folder = mkdtempSync("C:/AI_Temp/pi-plan-permissions-"), file = path.join(folder, "state.json");
  const previous = [process.env.PI_DESKTOP_GOAL_STATE_FILE, process.env.PI_DESKTOP_CONVERSATION_ID];
  try {
    let planning = review();
    const save = () => writeFileSync(file, JSON.stringify({ conversations: [{ id: "other", planning: { content: "wrong" } }, { id: "chat", planning }] }));
    save(); process.env.PI_DESKTOP_GOAL_STATE_FILE = file; process.env.PI_DESKTOP_CONVERSATION_ID = "chat";
    assert.deepEqual(readDesktopPlanning(), planning); assert.equal(desktopPlanningLocked(), true);
    assert.throws(() => assertPlanningModelAccess(), /PLAN mode/);
    let mutations = 0;
    const guarded = guardExtensionHandler("agent_settled", () => mutations++, "C:/app/node_modules/pi-lens/dist/index.js");
    guarded(); assert.equal(mutations, 0);
    planning = approve(planning); save(); assertPlanningModelAccess(); guarded(); assert.equal(mutations, 1);
    planning = revisePlanning({ append: "\nRefinement during work", expectedRevision: planning.revision }, planning); save();
    assert.equal(readDesktopPlanning().phase, "working");
    assert.equal(desktopPlanningLocked(), false); assertPlanningModelAccess();
    planning = completePlanning({ complete: true, expectedRevision: planning.revision }, planning); save();
    assert.equal(desktopPlanningLocked(), false); assertPlanningModelAccess();
    planning = controlPlanningState("revise", planning.revision, planning); save(); guarded(); assert.equal(mutations, 1);
    const staticPrompt = () => "static system policy";
    assert.equal(guardExtensionHandler("before_agent_start", staticPrompt, "/node_modules/pi-lens/index.js"), staticPrompt);
    writeFileSync(file, "bad JSON"); assert.throws(() => readDesktopPlanning()); assert.throws(() => guarded());
    unlinkSync(file); assert.throws(() => assertPlanningModelAccess());
  } finally {
    for (const [index, name] of ["PI_DESKTOP_GOAL_STATE_FILE", "PI_DESKTOP_CONVERSATION_ID"].entries()) {
      if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index];
    }
    removeTemporary(folder);
  }
});

test("native permission patches are idempotent, upgrade the old bridge and reject unknown versions", () => {
  const loader = readFileSync("node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js", "utf8");
  const patched = patchToolRouting(loader); assert.equal(patchToolRouting(patched), patched); assert.match(patched, /guardExtensionHandler\(event, handler, extension.path\)/);
  const code = readFileSync("node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/execute.js", "utf8");
  const checked = patchCodemodePlanning(code); assert.equal(patchCodemodePlanning(checked), checked);
  assert.match(checked, /const runModelCall = async[^\n]*\{\r?\n\s*assertPlanningModelAccess\(\)/);
  assert.throws(() => patchCodemodePlanning("unknown"), /anchor changed/);
});

test("actual Pi changes permissions in the SAME process without changing HTTP system/tools or rewriting the cached prefix", { timeout: 30000 }, async () => {
  const code = stripTypeScriptTypes(readFileSync("electron/pi-rpc-process.ts", "utf8"), { mode: "transform" });
  const { PiRpcProcess } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const folder = mkdtempSync("C:/AI_Temp/pi-plan-live-"), agentDir = path.join(folder, "agent"); mkdirSync(agentDir);
  const stateFile = path.join(folder, "state.json"), state = { conversations: [{ id: "chat" }] };
  const save = () => writeFileSync(stateFile, JSON.stringify(state)); save();
  const canary = path.join(folder, "lens-mutation.txt"), unsafe = path.join(folder, "unsafe.txt"), accepted = path.join(folder, "approved.txt");
  const lens = path.join(folder, "node_modules/pi-lens"); mkdirSync(lens, { recursive: true });
  writeFileSync(path.join(lens, "package.json"), JSON.stringify({ name: "pi-lens", version: "0.0.0", type: "module", pi: { extensions: ["./index.mjs"] } }));
  writeFileSync(path.join(lens, "index.mjs"), `import{writeFileSync}from"node:fs";export default function(pi){pi.on("agent_settled",()=>writeFileSync(${JSON.stringify(canary)},"mutated"));}`);
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [path.resolve("node_modules/pi-web-access"), lens] }));
  const overlay = path.join(folder, "sources.mjs");
  writeFileSync(overlay, `import{registerHooks}from"node:module";import{patchToolRouting,patchCodemodePlanning}from${JSON.stringify(new URL("../resources/tool-routing/patch.js", import.meta.url).href)};
registerHooks({resolve(s,c,n){return n(s.endsWith("desktop-tool-routing.js")?${JSON.stringify(new URL("../resources/tool-routing/index.js", import.meta.url).href)}:s.endsWith("desktop-service-context.js")?${JSON.stringify(new URL("../resources/pi-rpc-bridge/service-context.js", import.meta.url).href)}:s,c)},load(u,c,n){const r=n(u,c);const p=u.endsWith("/core/extensions/loader.js")?patchToolRouting:u.endsWith("/extensions/codemode/execute.js")?patchCodemodePlanning:undefined;return p?{...r,source:p(typeof r.source==="string"?r.source:Buffer.from(r.source).toString("utf8"))}:r}});`);
  const captured = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    captured.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const actions = captured.length === 2 ? [["write", { path: unsafe, content: "bad" }], ["bash", { command: "echo bad > unsafe.txt" }],
      ["codemode", { code: 'await tools.browser({action:"click",x:1,y:1})' }],
      ["codemode", { code: 'await models.generateImages({provider:"planning-test",id:"test"},{input:[{type:"text",text:"test"}]})' }],
      ["update_notebook", { content: "bad" }], ["update_implementation_plan", { content: "## Result\nFix the bug.\n## Verification\nRun tests.", ready: true }]]
      : captured.length === 4 ? [["write", { path: accepted, content: "approved" }]] : captured.length === 5 ? [["update_implementation_plan", { complete: true }]]
      : captured.length === 7 ? [["update_implementation_plan", { content: "Plan the next authorized task", ready: true }]]
      : captured.length === 8 ? [["write", { path: accepted, content: "normal-mode" }]]
      : captured.length === 9 ? [["update_implementation_plan", { complete: true }]] : [];
    const choice = actions.length ? { delta: { role: "assistant", tool_calls: actions.map(([name, args], index) => ({ index, id: `call-${captured.length}-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) }, finish_reason: "tool_calls" }
      : { delta: { role: "assistant", content: captured.length === 1 ? "Baseline." : "Done." }, finish_reason: "stop" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, ...choice }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "planning-test": { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "test-only",
    models: [{ id: "test", name: "test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }] } } }));
  const events = [], hostRequests = []; let settled;
  const rpc = new PiRpcProcess({ executablePath: process.execPath, cliPath: path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    cwd: folder, agentDir, sessionsDir: path.join(folder, "sessions"), sessionId: "chat", appRoot: process.cwd(), provider: "planning-test", model: "test", goalStatePath: stateFile,
    remoteEnvironment: { NODE_OPTIONS: `--import=${new URL(`file:///${overlay.replaceAll("\\", "/")}`).href}` }, planningExtensionPath: path.resolve("electron/planning-extension.ts"),
    goalExtensionPath: path.resolve("electron/goal-extension.ts"), planExtensionPath: path.resolve("electron/plan-extension.ts"), notebookExtensionPath: path.resolve("electron/notebook-extension.ts"), browserExtensionPath: path.resolve("electron/browser-extension.ts"),
    mcpEntryPath: "unused", mcpDirectTools: [], onEvent(event) { events.push(event); if (event.type === "agent_settled") settled?.(); }, onExtensionUi() {}, onExit() {},
    async onGoalRequest(request) { hostRequests.push(request.action); assert.equal(request.action, "update_implementation_plan");
      const current = state.conversations[0].planning;
      state.conversations[0].planning = request.params.complete !== undefined ? completePlanning(request.params, current) : revisePlanning(request.params, current); save(); return { planning: state.conversations[0].planning }; } });
  async function prompt(message) {
    const promise = new Promise(resolve => { settled = resolve; });
    const timer = setTimeout(() => settled?.(), 12000);
    try { await rpc.request("prompt", { message }, 15000); await promise; } finally { clearTimeout(timer); }
  }
  try {
    await rpc.start(); const pid = rpc.process.pid;
    const initial = await rpc.request("get_extension_state", {}, 15000);
    for (const name of ["read", "grep", "find", "ls", "bash", "write", "edit", "codemode", "update_implementation_plan"]) assert.ok(initial.activeTools.includes(name), name);
    await prompt("Baseline question."); assert.equal(existsSync(canary), true); unlinkSync(canary);
    state.conversations[0].planning = controlPlanningState("start", 0); save();
    const shell = await rpc.request("bash", { command: "echo bad > unsafe.txt", excludeFromContext: true }, 2000); assert.equal(shell.exitCode, 1);
    await prompt("Prepare a plan without modifying anything.");
    assert.equal(existsSync(unsafe), false); assert.equal(existsSync(canary), false);
    assert.equal(state.conversations[0].planning.phase, "review");
    assert.deepEqual(hostRequests, ["update_implementation_plan"]);
    assert.ok(captured[2].messages.filter(message => message.role === "tool").some(message => JSON.stringify(message.content).includes("PLAN mode")), "runtime permissions rejected unsafe tools");
    const modelCall = captured[2].messages.find(message => message.tool_call_id === "call-2-3");
    assert.match(JSON.stringify(modelCall?.content), /additional model generation is unavailable/, "hidden model API reaches the same runtime permission check");
    state.conversations[0].planning = approve(state.conversations[0].planning); save();
    await prompt("Implement the approved plan.");
    assert.equal(readFileSync(accepted, "utf8"), "approved"); assert.equal(existsSync(canary), true);
    assert.equal(state.conversations[0].planning.phase, "completed");
    assert.equal(rpc.process.pid, pid); assert.equal(captured.length, 6);
    await prompt("Do the next task; make a plan if useful and continue.");
    assert.equal(readFileSync(accepted, "utf8"), "normal-mode");
    assert.equal(state.conversations[0].planning.phase, "completed");
    assert.equal(state.conversations[0].planning.content, "Plan the next authorized task");
    assert.equal(rpc.process.pid, pid); assert.equal(captured.length, 10);
    const schemas = JSON.stringify(captured[0].tools), system = JSON.stringify(captured[0].messages.filter(message => message.role === "system"));
    for (const body of captured) { assert.equal(JSON.stringify(body.tools), schemas); assert.equal(JSON.stringify(body.messages.filter(message => message.role === "system")), system); }
    assert.deepEqual(captured[1].messages.slice(0, captured[0].messages.length), captured[0].messages, "entry into PLAN preserves the existing request prefix");
    assert.deepEqual(captured[3].messages.slice(0, captured[2].messages.length), captured[2].messages, "approval preserves the PLAN request prefix");
    assert.equal(events.filter(event => event.type === "extension_error").length, 0, JSON.stringify(events.filter(event => event.type === "extension_error")));
  } finally { await rpc.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); removeTemporary(folder); }
});
