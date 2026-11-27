import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { isPlanning, approvedPlanning, completePlanning, settlePlanning, controlPlanningState, revisePlanning, planningToolAllowed, planningContext, planningTick, normalPlanningContext, planImplementationPrompt, planningPolicy, planningLimit } from "../shared/planning.ts";
import { updatedPlan, canContinuePlan } from "../shared/plan.ts";
import { accessLocked, closeAccess, defaultAccess } from "../shared/access.ts";
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
  bindings = { accessLocked, closeAccess, defaultAccess, ...bindings };
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
  assert.throws(() => revisePlanning({ content: "Refined approach", expectedRevision: accepted.revision }, accepted), /только в режиме/);
  const revised = controlPlanningState("revise", accepted.revision, accepted);
  assert.equal(revised.approvedRevision, undefined);
  assert.equal(isPlanning(revised), true);
  assert.equal(isPlanning({ ...accepted, approvedRevision: undefined }), true);
  assert.equal(isPlanning({ phase: "unknown" }), true);
  const cancelled = controlPlanningState("cancel", revised.revision, revised);
  assert.equal(cancelled.content, accepted.content);
  assert.equal(cancelled.phase, "inactive");
  assert.match(planningContext(cancelled), /Plan mode is OFF/);
});

test("the detailed document is blocked outside Plan mode, including reads and direct execution", async () => {
  const f = fixture(); f.state = undefined;
  const tool = f.tools.get("update_implementation_plan");
  for (const params of [{}, { content: "Investigate and implement", ready: true }, { complete: true }]) {
    assert.equal(f.handlers.get("tool_call")({ toolName: tool.name, input: params }).block, true);
    await assert.rejects(tool.execute("outside", params), /только в режиме/);
  }
  assert.equal(f.state, undefined);
  assert.equal(f.handlers.get("tool_call")({ toolName: "write", input: {} }), undefined);
  assert.equal(f.handlers.get("user_bash")(), undefined);
});

test("only the user entering Plan mode makes a saved document editable", () => {
  for (const state of [undefined, { content: "old", phase: "inactive", revision: 5 }, { content: "old", phase: "completed", revision: 5 }]) {
    assert.throws(() => revisePlanning({ content: "Current task", expectedRevision: state?.revision ?? 0 }, state), /только в режиме/);
    const active = controlPlanningState("start", state?.revision ?? 0, state);
    const next = revisePlanning({ content: "Current task", expectedRevision: active.revision }, active);
    assert.equal(next.phase, "draft");
    assert.throws(() => controlPlanningState("approve", next.revision, next), /готового плана/);
    assert.throws(() => revisePlanning({ content: "", ready: true, expectedRevision: next.revision }, next), /пустой план/);
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
  assert.match(planningContext(done), /Plan mode is OFF/);
  assert.doesNotMatch(planningContext(done), /Plan mode: implementation is forbidden/);
  assert.equal(completePlanning({ complete: true, expectedRevision: done.revision }, done), done);
  assert.equal(controlPlanningState("revise", done.revision, done).phase, "draft");
  assert.equal(completePlanning({ complete: true, expectedRevision: state.revision }, state).phase, "completed", "a checklist is optional");
  for (const current of [undefined, controlPlanningState("start", 0), review()])
    assert.throws(() => completePlanning({ complete: true, expectedRevision: current?.revision ?? 0 }, current), /согласованный/);
  assert.throws(() => completePlanning({ complete: true, expectedRevision: state.revision - 1 }, state), /изменился/);
  for (const params of [{ complete: false }, { complete: true, content: "changed" }, { complete: true, ready: true }])
    assert.throws(() => completePlanning({ expectedRevision: state.revision, ...params }, state), /только complete/);
});

test("the app closes an approved document after verified checklist completion, not through a normal-mode tool call", async () => {
  const f = fixture(); f.state = approve(review(f.state));
  await assert.rejects(f.tools.get("update_implementation_plan").execute("complete", { complete: true }), /только в режиме/);
  const open = updatedPlan({ plan: [{ step: "Implement", status: "in_progress" }], execution: "active" });
  assert.equal(settlePlanning(f.state, open, true), f.state);
  assert.equal(settlePlanning(f.state, undefined, true), f.state);
  const done = updatedPlan({ plan: [{ step: "Implement", status: "completed" }] }, open);
  assert.equal(settlePlanning(f.state, done, false), f.state, "errors and aborts cannot complete the document");
  const closed = settlePlanning(f.state, done, true);
  assert.equal(closed.phase, "completed"); assert.equal(closed.content, f.state.content);
  assert.equal(closed.revision, f.state.revision + 1);
  assert.equal(settlePlanning(closed, done, true), closed);
});

test("normal tools remain discoverable; direct and nested execution obey the live permission", () => {
  const f = fixture(), guard = f.handlers.get("tool_call");
  for (const name of ["read", "grep", "find", "ls", "codemode", "web_search"]) assert.equal(planningToolAllowed(name), true);
  for (const name of ["write", "edit", "bash", "powershell", "apply_patch", "manage_skills", "create_goal", "update_goal", "comfyui_run_workflow", "unknown_readonly_hint"]) {
    assert.equal(planningToolAllowed(name), false);
    for (const parentToolCallId of [undefined, "outer/1"]) assert.equal(guard({ toolName: name, input: {}, parentToolCallId }).block, true);
  }
  for (const name of ["update_notebook", "update_checklist"]) {
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

test("plan mode allows built-in web searches and direct reads with the same parameters", () => {
  const guard = fixture().handlers.get("tool_call");
  for (const input of [{ query: "tool documentation" }, { url: "https://example.org" }]) {
    const original = { ...input };
    assert.equal(guard({ toolName: "web_search", input }), undefined);
    assert.deepEqual(input, original);
  }
  assert.equal(guard({ toolName: "fetch_content", input: { url: "https://example.org" } }).block, true);
});

test("system prompt and tool contracts do not depend on the current mode", () => {
  const f = fixture();
  f.handlers.get("session_start")({}, { cwd: "C:/AI_Temp" });
  assert.deepEqual([...f.tools.keys()].sort(), ["find", "grep", "ls", "request_changes", "update_implementation_plan"]);
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
  assert.match(next.at(-1).content, /Document: review/);
  assert.doesNotMatch(next.at(-1).content, /Detailed specification/);
  assert.deepEqual(context(next), next);
  const read = await f.tools.get("update_implementation_plan").execute("read", {});
  assert.equal(JSON.parse(read.content[0].text).planning.content, f.state.content);
  const restored = context([{ role: "compactionSummary", summary: "Earlier work" }, ack]);
  assert.ok(restored.at(-1).content.includes(f.state.content.replaceAll("\n", "\\n")), "compact acknowledgement cannot replace the document after compaction");
  f.state = approve(f.state); history = context(next);
  assert.match(history.at(-1).content, /Plan mode is OFF/);
  assert.doesNotMatch(history.at(-1).content, /Detailed specification/);
  assert.ok(planImplementationPrompt(f.state).includes(f.state.content), "the app hands the approved scope to implementation once");
  f.state = completePlanning({ complete: true, expectedRevision: f.state.revision }, f.state);
  next = context(history); assert.deepEqual(next, history, "completion does not reintroduce the document in ordinary work");
  next.push({ role: "user", content: "Another task" }); assert.deepEqual(context(next), next);
});

test("only Plan mode receives document reminders; leaving it appends a small closing state without rewriting history", () => {
  const f = fixture(), context = messages => f.handlers.get("context")({ messages }).messages;
  f.state = { content: "Specification for the current task", phase: "draft", revision: 4, updatedAt: new Date().toISOString() };
  const first = context([{ role: "user", content: "Plan the work" }]);
  assert.match(first.at(-1).content, /Specification for the current task/);
  const next = [...first, { role: "user", content: "Clarification" }];
  const reminder = context(next);
  assert.match(reminder.at(-1).content, /required detailed document/);
  assert.doesNotMatch(reminder.at(-1).content, /Specification for the current task/);
  f.state = approve(review(f.state));
  const normal = context(reminder);
  assert.deepEqual(normal.slice(0, reminder.length), reminder, "keep the cached prefix intact");
  assert.match(normal.at(-1).content, /Plan mode is OFF/);
  assert.doesNotMatch(normal.at(-1).content, /Specification for the current task/);
  const after = [...normal, { role: "user", content: "Continue ordinary work" }];
  assert.deepEqual(context(after), after, "normal work does not repeat document reminders");
});

test("the saved plan can be removed in any phase and removal starts nothing", async () => {
  for (const phase of ["draft", "review", "working", "implementation", "completed", "inactive"])
    assert.equal(controlPlanningState("remove", 2, { content: "Plan", phase, revision: 2, updatedAt: "" }), undefined, phase);
  assert.throws(() => controlPlanningState("remove", 1, { content: "Plan", phase: "completed", revision: 2, updatedAt: "" }), /изменился/);
  assert.throws(() => controlPlanningState("remove", 0), /План ещё не создан/);
  const control = hostMethod("  async controlPlanning(", "async function run(conversationId, action, expectedRevision)", { controlPlanningState, updatedPlan, planImplementationPrompt });
  const checklist = updatedPlan({ plan: [{ step: "Done", status: "completed" }], execution: "paused" });
  const chat = { status: "idle", planning: { content: "Done plan", phase: "completed", revision: 4, updatedAt: "" }, goal: { id: "g1", status: "paused" }, plan: checklist };
  const events = [];
  const host = { planningTransitions: new Set(), planningWrites: new Set(), goalContinuationRequested: new Set(), startingRuntimes: new Map(), runtimes: new Map(),
    store: { getConversation: () => chat, getQueuedPrompts: () => [] }, async updateConversation(_id, patch) { Object.assign(chat, patch); events.push("persist"); }, async sendPrompt() { events.push("prompt"); } };
  await control.call(host, "chat", "remove", chat.planning.revision);
  assert.equal(chat.planning, undefined, "the document is gone");
  assert.equal(chat.goal.status, "paused", "removal leaves an unrelated paused goal alone");
  assert.equal(chat.plan, checklist, "removal leaves the checklist alone");
  assert.deepEqual(events, ["persist"], "removal never starts a model turn");
});

test("the planning panel exposes removal in every phase and the app wires it", () => {
  const panel = readFileSync(new URL("../src/PlanningPanel.tsx", import.meta.url), "utf8");
  const footer = panel.slice(panel.indexOf("<footer"));
  assert.match(footer, /action\("remove"\)/);
  assert.match(footer, /window\.confirm\(t\("Убрать план из этого чата\?/);
  const removeLine = footer.split("\n").find(line => line.includes('className="planning-remove"'));
  assert.ok(removeLine && !removeLine.trim().startsWith("{"), "removal is rendered in every phase");
  assert.ok(footer.indexOf("planning-remove") > footer.indexOf("planning-exit"), "removal follows the phase-specific actions");
  const ui = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  assert.match(ui, /"start" \| "revise" \| "approve" \| "cancel" \| "remove"/);
  assert.match(ui, /action !== "approve" && action !== "cancel" && action !== "remove"/, "the panel closes after removal");
});

test("approval starts the work as an application step, never as a message from the user", () => {
  assert.doesNotMatch(source, /sendPrompt\(conversationId, "Реализуй/);
  assert.match(source, /planImplementationPrompt\(approved\), \[\], "implement"/);
  assert.match(source, /rpc\.request\("desktop_plan_implement"/);
  const bridge = readFileSync(new URL("../resources/pi-engine/protocol.js", import.meta.url), "utf8");
  const from = bridge.indexOf('case "desktop_plan_implement"');
  const block = bridge.slice(from, from + 1600);
  assert.match(block, /desktop_plan_implement: "desktop_plan_implementation"/);
  assert.match(block, /customType: continuationType/);
  assert.match(block, /display: false/);
  assert.match(block, /triggerTurn: true/);
  const message = planImplementationPrompt(approve(review()));
  assert.ok(message.startsWith('<pi_desktop_service_context source="approved-work">'));
  assert.match(message, /revision \d+/);
  assert.match(message, /update_checklist[\s\S]{0,200}execution/);
  assert.match(message, /not a new request from the user/);
  assert.doesNotMatch(message, /goal controller/);
});

test("the plan is approved with the interface control, not with a word in the chat", () => {
  const ready = review();
  assert.match(planningContext(ready), /Начать реализацию/);
  assert.match(planningContext(ready), /a word in the chat is not approval/);
  assert.match(planningTick(ready), /Начать реализацию/);
  assert.match(planningTick(ready), /a word in chat does not approve it/);
  assert.match(planningPolicy, /«Начать реализацию»/);
  assert.match(planningPolicy, /never treat one as approval/);
});

test("review/approval is version-checked and never stops or replaces the Pi process", async () => {
  const control = hostMethod("  async controlPlanning(", "async function run(conversationId, action, expectedRevision)", { controlPlanningState, updatedPlan, planImplementationPrompt });
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
  for (const request of [{ action: "update_notebook", params: { append: "bad" } }, { action: "update_checklist", params: { execution: "active" } }, { action: "browser", params: { action: "click" } }, { action: "create_goal", params: { objective: "bad" } }, { action: "manage_skills", params: { action: "delete" } }])
    await assert.rejects(handle.call(host, "chat", request), /запрещены/);
  await handle.call(host, "chat", { action: "update_implementation_plan", params: { content: "Plan", ready: true, expectedRevision: chat.planning.revision } });
  host.runtimes.get("chat").runAborted = true;
  await assert.rejects(handle.call(host, "chat", { action: "update_implementation_plan", params: { content: "bad", expectedRevision: chat.planning.revision } }), /отменено/);
});

test("host rejects detailed-document requests outside Plan mode without touching normal work", async () => {
  const handle = hostMethod("  private async handleGoalRequest(", "async function run(conversationId, request)", { isPlanning, planningToolAllowed, revisePlanning, completePlanning });
  const chat = { goal: { status: "active" }, plan: updatedPlan({ plan: [{ step: "Implement", status: "in_progress" }], execution: "active" }) };
  const host = { store: { getConversation: () => chat }, runtimes: new Map(), planningWrites: new Set(), async updateConversation() { assert.fail("must not mutate state"); } };
  for (const params of [{}, { content: "Plan", ready: true }, { complete: true }]) await assert.rejects(handle.call(host, "chat", { action: "update_implementation_plan", params }), /только в режиме/);
  assert.equal(chat.goal.status, "active"); assert.equal(chat.plan.execution, "active"); assert.equal(chat.planning, undefined);
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
  const launch = new Function("canContinuePlan", "isPlanning", "approvedPlanning", "accessLocked", "setTimeout", `${code};return run;`)(canContinuePlan, isPlanning, approvedPlanning, accessLocked, callback => timers.push(callback));
  const task = { access: { mode: "full" }, status: "idle", planning: controlPlanningState("start", 0), goal: { id: "old", status: "active" }, plan: updatedPlan({ plan: [{ step: "Work", status: "pending" }], execution: "active" }) };
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
    const save = () => writeFileSync(file, JSON.stringify({ conversations: [{ id: "other", planning: { content: "wrong" } }, { id: "chat", planning, access: { mode: "full" } }] }));
    save(); process.env.PI_DESKTOP_GOAL_STATE_FILE = file; process.env.PI_DESKTOP_CONVERSATION_ID = "chat";
    assert.deepEqual(readDesktopPlanning(), planning); assert.equal(desktopPlanningLocked(), true);
    assert.throws(() => assertPlanningModelAccess(), /Plan mode/);
    let mutations = 0;
    const guarded = guardExtensionHandler("agent_settled", () => mutations++, "C:/app/node_modules/pi-lens/dist/index.js");
    guarded(); assert.equal(mutations, 0);
    planning = approve(planning); save(); assertPlanningModelAccess(); guarded(); assert.equal(mutations, 1);
    assert.throws(() => revisePlanning({ append: "Refinement during work", expectedRevision: planning.revision }, planning), /только в режиме/);
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
  const stateFile = path.join(folder, "state.json"), state = { conversations: [{ id: "chat", access: { mode: "full" } }] };
  const save = () => writeFileSync(stateFile, JSON.stringify(state)); save();
  const canary = path.join(folder, "lens-mutation.txt"), unsafe = path.join(folder, "unsafe.txt"), accepted = path.join(folder, "approved.txt");
  const lens = path.join(folder, "node_modules/pi-lens"); mkdirSync(lens, { recursive: true });
  writeFileSync(path.join(lens, "package.json"), JSON.stringify({ name: "pi-lens", version: "0.0.0", type: "module", pi: { extensions: ["./index.mjs"] } }));
  writeFileSync(path.join(lens, "index.mjs"), `import{writeFileSync}from"node:fs";export default function(pi){pi.on("agent_settled",()=>writeFileSync(${JSON.stringify(canary)},"mutated"));}`);
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [lens] }));
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
      : captured.length === 7 ? [["update_implementation_plan", { content: "Plan the next authorized task", ready: true }], ["codemode", { code: "text(await tools.update_implementation_plan({}));" }]]
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
  const rpc = new PiRpcProcess({ executablePath: process.execPath, enginePath: path.resolve("resources/pi-engine/worker.mjs"),
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
    for (const name of ["read", "grep", "find", "ls", "bash", "write", "edit", "codemode", "update_implementation_plan", "web_search"]) assert.ok(initial.activeTools.includes(name), name);
    await prompt("Baseline question."); assert.equal(existsSync(canary), true); unlinkSync(canary);
    state.conversations[0].planning = controlPlanningState("start", 0); save();
    const shell = await rpc.request("bash", { command: "echo bad > unsafe.txt", excludeFromContext: true }, 2000); assert.equal(shell.exitCode, 1);
    await prompt("Prepare a plan without modifying anything.");
    assert.equal(existsSync(unsafe), false); assert.equal(existsSync(canary), false);
    assert.equal(state.conversations[0].planning.phase, "review");
    assert.deepEqual(hostRequests, ["update_implementation_plan"]);
    assert.ok(captured[2].messages.filter(message => message.role === "tool").some(message => JSON.stringify(message.content).includes("Plan mode")), "runtime permissions rejected unsafe tools");
    const modelCall = captured[2].messages.find(message => message.tool_call_id === "call-2-3");
    assert.match(JSON.stringify(modelCall?.content), /additional model generation is unavailable/, "hidden model API reaches the same runtime permission check");
    state.conversations[0].planning = approve(state.conversations[0].planning); save();
    await prompt("Implement the approved plan.");
    assert.equal(readFileSync(accepted, "utf8"), "approved"); assert.equal(existsSync(canary), true);
    assert.equal(state.conversations[0].planning.phase, "implementation", "the normal-mode document tool is blocked");
    state.conversations[0].plan = updatedPlan({ plan: [{ step: "Implement and verify", status: "completed" }] });
    state.conversations[0].planning = settlePlanning(state.conversations[0].planning, state.conversations[0].plan, true); save();
    assert.equal(rpc.process.pid, pid); assert.equal(captured.length, 6);
    await prompt("Do the next task; make a plan if useful and continue.");
    assert.equal(readFileSync(accepted, "utf8"), "normal-mode");
    assert.equal(state.conversations[0].planning.phase, "completed");
    assert.match(state.conversations[0].planning.content, /Fix the bug/);
    assert.deepEqual(hostRequests, ["update_implementation_plan"], "outside-mode reads and writes cannot reach the host");
    assert.ok(captured[7].messages.some(message => message.role === "tool" && String(message.content).includes("only in Plan mode")));
    assert.equal(rpc.process.pid, pid); assert.equal(captured.length, 10);
    const schemas = JSON.stringify(captured[0].tools), system = JSON.stringify(captured[0].messages.filter(message => message.role === "system"));
    for (const body of captured) { assert.equal(JSON.stringify(body.tools), schemas); assert.equal(JSON.stringify(body.messages.filter(message => message.role === "system")), system); }
    assert.deepEqual(captured[1].messages.slice(0, captured[0].messages.length), captured[0].messages, "entry into PLAN preserves the existing request prefix");
    assert.deepEqual(captured[3].messages.slice(0, captured[2].messages.length), captured[2].messages, "approval preserves the PLAN request prefix");
    assert.equal(events.filter(event => event.type === "extension_error").length, 0, JSON.stringify(events.filter(event => event.type === "extension_error")));
  } finally { await rpc.stop(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); removeTemporary(folder); }
});

test("planning mode chip in the composer exposes an explicit exit control", () => {
  const ui = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const chip = ui.match(/\{planMode && <span className="plan-mode-chip">[\s\S]*?<\/span>\}/);
  assert.ok(chip, "plan mode renders a chip container in the composer toolbar");
  assert.match(chip[0], /className="goal-mode-chip"[\s\S]*setPlanningOpen\(true\)/, "the label still opens the planning panel");
  assert.match(chip[0], /className="plan-mode-close"[\s\S]*aria-label=\{t\("Выйти из режима планирования"\)\}/, "the exit control is announced to screen readers");
  assert.match(chip[0], /changePlanning\("cancel", planning\?\.revision \?\? 0\)/, "the cross cancels planning at the current revision");
  assert.match(chip[0], /disabled=\{working \|\| requestPending\}/, "mode switching stays blocked while the model works, as controlPlanning requires");
});

test("a chat without a planning document is told Plan mode is off, and only once", () => {
  const f = fixture(); f.state = undefined;
  const context = messages => f.handlers.get("context")({ messages }).messages;
  const first = context([{ role: "user", content: "Fix the bug" }]);
  assert.match(first.at(-1).content, /Plan mode is OFF[\s\S]*access permissions are controlled separately/);
  assert.match(first.at(-1).content, /detailed document tool is unavailable/);
  assert.equal(f.messages.length, 1);
  assert.equal(context(first).length, first.length);
  assert.equal(f.messages.length, 1);
});

test("removing the document clears the read-only statement instead of leaving it behind", () => {
  const f = fixture(); f.state = review();
  const context = messages => f.handlers.get("context")({ messages }).messages;
  const gated = context([{ role: "user", content: "Plan it" }]);
  assert.match(gated.at(-1).content, /Plan mode is ON[\s\S]*read only/);
  assert.match(gated.at(-1).content, /"revision":2/);
  f.state = undefined;
  const cleared = context(gated);
  assert.match(cleared.at(-1).content, /Plan mode is OFF/);
  assert.match(cleared.at(-1).content, /historical data/);
  assert.equal(f.messages.length, 2);
  assert.equal(context(cleared).length, cleared.length);
});

test("normal mode never injects a saved or legacy document as a working instruction", () => {
  for (const phase of ["working", "inactive", "completed"]) {
    const saved = { content: "PRIVATE SAVED SPECIFICATION", phase, revision: 4 };
    assert.match(planningContext(saved), /Plan mode is OFF/);
    assert.doesNotMatch(planningContext(saved), /PRIVATE SAVED SPECIFICATION/);
    assert.equal(planningTick(saved), "");
  }
  assert.match(planningContext(controlPlanningState("start", 0)), /Plan mode is ON/);
  assert.match(normalPlanningContext(), /working checklist and notebook/);
});

test("Plan mode always requires a detailed document and waits at interface review", () => {
  const draft = controlPlanningState("start", 0), ready = review(draft), active = approve(ready);
  assert.match(planningTick(draft), /required detailed document[\s\S]*ready=true/);
  assert.match(planningTick(ready), /awaiting approval[\s\S]*Начать реализацию[\s\S]*end the turn/);
  assert.equal(planningTick(active), "");
  assert.match(planningContext(draft), /detailed document is mandatory/);
  assert.match(planningContext(draft), /checklist is not a substitute/);
});

test("the current mode separates mandatory documentation from ordinary checklist work", () => {
  const gated = planningContext(controlPlanningState("start", 0));
  assert.match(gated, /Plan mode is ON for this chat: read only/);
  assert.match(gated, /working checklist and the notebook stay read-only/);
  const free = normalPlanningContext();
  assert.match(free, /Plan mode is OFF/);
  assert.match(free, /detailed document tool is unavailable/);
  assert.match(free, /working checklist and notebook/);
});

test("the static policy requires the document in Plan mode and forbids it outside", () => {
  assert.match(planningPolicy, /When OFF, do not call update_implementation_plan/);
  assert.match(planningPolicy, /When ON, the detailed planning document is mandatory/);
  assert.match(planningPolicy, /latest implementation-plan state/);
  assert.match(planningPolicy, /Only the user switches Plan mode/);
});

test("the executed gate and the instructions agree on what counts as Plan mode", () => {
  const folder = mkdtempSync("C:/AI_Temp/pi-plan-parity-"), file = path.join(folder, "state.json");
  const previous = [process.env.PI_DESKTOP_GOAL_STATE_FILE, process.env.PI_DESKTOP_CONVERSATION_ID];
  try {
    const ready = review(), active = approve(ready);
    const states = [undefined, controlPlanningState("start", 0), ready, active,
      controlPlanningState("cancel", ready.revision, ready),
      completePlanning({ complete: true, expectedRevision: active.revision }, active),
      { content: "", phase: "implementation", revision: 3, approvedRevision: 2, updatedAt: new Date().toISOString() }];
    process.env.PI_DESKTOP_CONVERSATION_ID = "chat"; process.env.PI_DESKTOP_GOAL_STATE_FILE = file;
    for (const planning of states) {
      writeFileSync(file, JSON.stringify({ conversations: [{ id: "chat", planning, access: { mode: "full" } }] }));
      assert.equal(desktopPlanningLocked(), isPlanning(planning), `phase ${planning?.phase ?? "none"}`);
    }
  } finally {
    [process.env.PI_DESKTOP_GOAL_STATE_FILE, process.env.PI_DESKTOP_CONVERSATION_ID] = previous;
    rmSync(folder, { recursive: true, force: true });
  }
});
