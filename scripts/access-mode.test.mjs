import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import * as access from "../shared/access.ts";
import { isPlanning, planningToolAllowed, revisePlanning, completePlanning, controlPlanningState } from "../shared/planning.ts";
import { desktopPlanningLocked, assertPlanningModelAccess, guardExtensionHandler } from "../resources/tool-routing/desktop-planning-permissions.js";
import { discardDelayedStateSnapshots, projectDesktopServiceContext } from "../resources/pi-rpc-bridge/service-context.js";

const hook = registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
    const file = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
    try { readFileSync(file); return next(file.href, context); } catch {}
  }
  return next(specifier, context);
} });
const { default: planningExtension } = await import("../electron/planning-extension.ts");
hook.deregister();
const proposal = { description: "Draw the agreed skeleton sprite", targets: ["sprite.aseprite"], risks: "" };
const full = { mode: "full", phase: "idle", revision: 0 };

test("default access is read only; only a versioned UI approval grants a task", () => {
  assert.equal(access.accessLocked(), true);
  const review = access.proposeAccess(proposal);
  assert.equal(access.accessLocked(review), true);
  assert.throws(() => access.proposeAccess({ ...proposal, phase: "approved" }, review), /только пользователь/);
  assert.throws(() => access.controlAccess("approve", 0, review), /изменилось/);
  const approved = access.controlAccess("approve", review.revision, review);
  assert.equal(access.accessLocked(approved), false);
  assert.equal(access.accessLocked(access.closeAccess(approved)), true);
  assert.equal(access.accessLocked(access.controlAccess("full", 0)), false);
  assert.equal(access.accessLocked(access.controlAccess("confirm", 0, full)), true);
});

test("clarifying a pending proposal invalidates its old approval button", () => {
  const pending = access.proposeAccess(proposal);
  const clarified = access.closeAccess(pending);
  assert.equal(access.accessLocked(clarified), true);
  assert.throws(() => access.controlAccess("approve", pending.revision, clarified), /изменилось/);
  assert.equal(clarified.proposal, undefined);
});

function fixture(initial = access.defaultAccess(), planning) {
  let current = initial;
  const handlers = new Map(), tools = new Map(), messages = [];
  planningExtension({ on(name, fn) { handlers.set(name, fn); }, registerTool(tool) { tools.set(tool.name, tool); }, sendMessage(m) { messages.push(m); } },
    () => planning, async (name, params) => { assert.equal(name, "request_changes"); current = access.proposeAccess(params, current); return { access: current }; }, () => current);
  return { handlers, tools, messages, get state() { return current; }, set state(next) { current = next; } };
}

test("the same gate protects direct and nested writes; plan mode remains independent", async () => {
  const f = fixture();
  const call = (name, input = {}) => f.handlers.get("tool_call")({ toolName: name, input });
  for (const name of ["read", "grep", "find", "ls", "web_search", "codemode", "request_changes"]) assert.equal(call(name), undefined, name);
  for (const name of ["write", "edit", "bash", "powershell", "mcp", "media_generate_3d", "update_checklist", "create_goal"]) {
    assert.equal(call(name, name === "update_checklist" ? { execution: "active" } : {}).block, true, name);
  }
  await f.tools.get("request_changes").execute("id", proposal);
  assert.equal(call("write").block, true, "the proposal cannot approve itself");
  f.state = access.controlAccess("approve", f.state.revision, f.state);
  assert.equal(call("write"), undefined);
  const planned = fixture(full, controlPlanningState("start", 0));
  assert.equal(planned.handlers.get("tool_call")({ toolName: "write", input: {} }).block, true);
  assert.equal(planned.handlers.get("tool_call")({ toolName: "request_changes", input: proposal }).block, true);
});

test("approval changes context without changing the system prompt or tool catalog", () => {
  const f = fixture();
  const system = () => f.handlers.get("before_agent_start")({ systemPrompt: "base" }).systemPrompt;
  const before = system(), schemas = JSON.stringify([...f.tools.values()]);
  const history = [{ role: "user", content: "make a sprite", timestamp: 1 }];
  const first = f.handlers.get("context")({ messages: history }).messages;
  assert.match(first.at(-1).content, /Agree first: read-only/);
  const same = f.handlers.get("context")({ messages: first }).messages;
  assert.equal(same.length, first.length, "unchanged state does not repeat after every tool");
  f.state = access.controlAccess("approve", 1, access.proposeAccess(proposal));
  const next = f.handlers.get("context")({ messages: first }).messages;
  assert.match(next.at(-1).content, /user granted permission/);
  assert.match(next.at(-1).content, /has not sent a message to begin/);
  assert.equal(system(), before);
  assert.equal(JSON.stringify([...f.tools.values()]), schemas);
  assert.equal(projectDesktopServiceContext(next).filter(x => x.role === "user").length, 1);
});

test("live persisted access protects hidden model calls and Lens hooks across restarts", () => {
  mkdirSync("C:/AI_Temp", { recursive: true });
  const dir = mkdtempSync("C:/AI_Temp/pi-access-"), file = path.join(dir, "state.json");
  const previous = [process.env.PI_DESKTOP_CONVERSATION_ID, process.env.PI_DESKTOP_GOAL_STATE_FILE];
  process.env.PI_DESKTOP_CONVERSATION_ID = "chat"; process.env.PI_DESKTOP_GOAL_STATE_FILE = file;
  try {
    const save = current => writeFileSync(file, JSON.stringify({ conversations: [{ id: "chat", access: current }] }));
    save(undefined); assert.equal(desktopPlanningLocked(), true); assert.throws(() => assertPlanningModelAccess());
    let mutations = 0;
    const handler = guardExtensionHandler("agent_settled", () => mutations++, "/node_modules/pi-lens/index.js");
    handler(); assert.equal(mutations, 0);
    const approved = access.controlAccess("approve", 1, access.proposeAccess(proposal)); save(approved);
    assert.equal(desktopPlanningLocked(), false); assertPlanningModelAccess(); handler(); assert.equal(mutations, 1);
    save(access.closeAccess(approved)); handler(); assert.equal(mutations, 1);
    writeFileSync(file, "broken"); assert.throws(() => desktopPlanningLocked());
  } finally {
    for (const [key, value] of [["PI_DESKTOP_CONVERSATION_ID", previous[0]], ["PI_DESKTOP_GOAL_STATE_FILE", previous[1]]])
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

test("unfinished work retains task approval, while completion closes its scope", () => {
  assert.equal(access.accessTaskOpen({}), false);
  assert.equal(access.accessTaskOpen({ plan: { steps: [{ step: "work", status: "in_progress" }] } }), true);
  assert.equal(access.accessTaskOpen({ plan: { steps: [{ step: "work", status: "completed" }] } }), false);
  assert.equal(access.accessTaskOpen({ goal: { status: "active" } }), true);
});

const source = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
function hostMethod(name, signature) {
  const start = source.indexOf(name), body = source.indexOf(" {", source.indexOf("): Promise<", start)) + 2, end = source.indexOf("\n  }", body);
  const bindings = { ...access, controlAccessState: access.controlAccess, isPlanning, planningToolAllowed, revisePlanning, completePlanning };
  return new Function(...Object.keys(bindings), `${stripTypeScriptTypes(`${signature} {${source.slice(body, end)}\n}`)}; return run;`)(...Object.values(bindings));
}

test("host checks the exact proposal, busy state and queued clarifications before approving", async () => {
  const control = hostMethod("  async controlAccess(", "async function run(conversationId, action, expectedRevision)");
  const conversation = { access: access.proposeAccess(proposal), status: "idle" };
  let queued = [], calls = 0;
  const host = { planningTransitions: new Set(), runtimes: new Map(), startingRuntimes: new Map(), store: { getConversation: () => conversation, getQueuedPrompts: () => queued },
    async updateConversation(_id, changes) { Object.assign(conversation, changes); }, async sendPrompt() { calls++; } };
  queued = [{ id: "clarification" }];
  await assert.rejects(control.call(host, "chat", "approve", 1), /уточнения/);
  assert.equal(access.accessLocked(conversation.access), true);
  queued = [];
  await control.call(host, "chat", "approve", 1);
  assert.equal(access.accessLocked(conversation.access), false); assert.equal(calls, 0, "approval must not dispatch generation");
  assert.equal(conversation.access.started, false);
  await assert.rejects(control.call(host, "chat", "approve", 1), /изменилось/);
});

test("permission can be revoked while a tool runs, locking access before abort completes", async () => {
  const control = hostMethod("  async controlAccess(", "async function run(conversationId, action, expectedRevision)");
  const conversation = { access: access.controlAccess("approve", 1, access.proposeAccess(proposal)) };
  let aborted = 0;
  const host = { planningTransitions: new Set(), runtimes: new Map([["chat", { snapshot: { state: { isStreaming: true } } }]]),
    store: { getConversation: () => conversation }, async updateConversation(_id, changes) { Object.assign(conversation, changes); },
    async abort() { assert.equal(access.accessLocked(conversation.access), true); aborted++; } };
  await control.call(host, "chat", "cancel", conversation.access.revision);
  assert.equal(aborted, 1); assert.equal(access.accessLocked(conversation.access), true);
});

test("host never accepts a checklist as approval, even if an extension calls it directly", async () => {
  const handle = hostMethod("  private async handleGoalRequest(", "async function run(conversationId, request)");
  const conversation = {};
  const host = { store: { getConversation: () => conversation }, runtimes: new Map(), planningTransitions: new Set(), async updateConversation(_id, changes) { Object.assign(conversation, changes); } };
  await assert.rejects(handle.call(host, "chat", { action: "update_checklist", params: { execution: "active", plan: [] } }), /запрещены/);
  const result = await handle.call(host, "chat", { action: "request_changes", params: proposal });
  assert.equal(result.access.phase, "review"); assert.equal(access.accessLocked(result.access), true);
});

test("real Pi blocks direct and nested changes before UI approval, then executes in the same runtime", { timeout: 30000 }, async () => {
  const code = stripTypeScriptTypes(readFileSync("electron/pi-rpc-process.ts", "utf8"), { mode: "transform" });
  const { PiRpcProcess } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const dir = mkdtempSync("C:/AI_Temp/pi-access-live-"), agentDir = path.join(dir, "agent"); mkdirSync(agentDir);
  const stateFile = path.join(dir, "state.json"), conversation = { id: "chat", access: access.defaultAccess() };
  const save = () => writeFileSync(stateFile, JSON.stringify({ conversations: [conversation] })); save();
  const direct = path.join(dir, "direct.txt"), nested = path.join(dir, "nested.txt");
  let round = 0;
  const captured = [];
  const server = http.createServer(async (req, res) => {
    const bytes = []; for await (const chunk of req) bytes.push(chunk);
    captured.push(JSON.parse(Buffer.concat(bytes).toString("utf8")));
    const actions = [["write", { path: direct, content: "approved" }], ["codemode", { code: `text(await tools.write({path:${JSON.stringify(nested)},content:"approved"}));` }]];
    const choice = round++ === 0 ? { delta: { role: "assistant", tool_calls: actions.map(([name, args], index) => ({ index, id: `call-${index}-${captured.length}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) }, finish_reason: "tool_calls" }
      : { delta: { role: "assistant", content: "Done." }, finish_reason: "stop" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, ...choice }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "access-test": { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "test-only",
    models: [{ id: "test", name: "test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }] } } }));
  let settled;
  const rpc = new PiRpcProcess({ executablePath: process.execPath, enginePath: path.resolve("resources/pi-engine/worker.mjs"), cwd: dir, agentDir, sessionsDir: path.join(dir, "sessions"),
    sessionId: "chat", appRoot: process.cwd(), provider: "access-test", model: "test", goalStatePath: stateFile, planningExtensionPath: path.resolve("electron/planning-extension.ts"),
    mcpEntryPath: "unused", mcpDirectTools: [], onEvent(event) { if (event.type === "agent_settled") settled?.(); }, onExtensionUi() {}, onExit() {} });
  const prompt = async () => {
    round = 0;
    const finished = new Promise(resolve => { settled = resolve; });
    await rpc.request("prompt", { message: "Perform the test writes." }, 15000);
    await finished;
  };
  try {
    await rpc.start(); const pid = rpc.process.pid;
    await prompt();
    assert.throws(() => readFileSync(direct)); assert.throws(() => readFileSync(nested));
    const schemas = captured[0].tools, system = captured[0].messages.filter(m => m.role === "system");
    conversation.access = access.controlAccess("approve", 1, access.proposeAccess(proposal)); save();
    await prompt();
    assert.equal(readFileSync(direct, "utf8"), "approved"); assert.equal(readFileSync(nested, "utf8"), "approved");
    assert.equal(rpc.process.pid, pid);
    assert.deepEqual(captured[2].tools, schemas); assert.deepEqual(captured[2].messages.filter(m => m.role === "system"), system);
  } finally { await rpc.stop(); await new Promise(resolve => server.close(resolve)); }
});
