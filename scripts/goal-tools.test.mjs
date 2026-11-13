import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { isPlanning, planningToolAllowed } from "../shared/planning.ts";

const source = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
const start = source.indexOf("  private async handleGoalRequest(");
const bodyStart = source.indexOf("): Promise<unknown> {", start) + "): Promise<unknown> {".length;
const bodyEnd = source.indexOf("\n  }", bodyStart);
assert.ok(start >= 0 && bodyStart > start && bodyEnd > bodyStart);
const body = stripTypeScriptTypes(`async function invoke(conversationId, request) {${source.slice(bodyStart, bodyEnd)}\n}`);
const run = new Function("randomUUID", "isPlanning", "planningToolAllowed", `${body}; return invoke;`)(randomUUID, isPlanning, planningToolAllowed);
function fixture(goal) {
  const conversation = { goal };
  const runtime = {};
  const ctx = { store: { getConversation() { return conversation; } }, runtimes: new Map([["chat", runtime]]),
    goalContinuationRequested: new Set(["chat"]),
    async updateConversation(_id, patch) { Object.assign(conversation, patch); } };
  return { conversation, runtime, ctx, request: request => run.call(ctx, "chat", request) };
}
test("host creates persistent goal during a turn and rejects unfinished replacement", async () => {
  const f = fixture();
  const result = await f.request({ action: "create_goal", params: { objective: " Fix it ", token_budget: 100 } });
  assert.equal(result.goal.objective, "Fix it");
  assert.equal(result.remainingTokens, 100);
  assert.equal(f.runtime.goalTurnId, result.goal.id);
  await assert.rejects(f.request({ action: "create_goal", params: { objective: "other" } }), /unfinished/);
  assert.equal((await f.request({ action: "get_goal" })).goal.id, result.goal.id);
});
test("host validates budgets and stale mutations; pause has no abort or launch", async () => {
  for (const token_budget of [0, -1, 1.5, "100", Infinity]) {
    await assert.rejects(fixture().request({ action: "create_goal", params: { objective: "Goal", token_budget } }), /budget/);
  }
  const f = fixture({ id: "new", status: "active" });
  await assert.rejects(f.request({ action: "update_goal", params: { goalId: "old", status: "complete" } }), /changed/);
  const result = await f.request({ action: "update_goal", params: { goalId: "new", status: "paused" } });
  assert.equal(result.goal.status, "paused");
  assert.equal(f.ctx.goalContinuationRequested.size, 0);
  await assert.rejects(f.request({ action: "update_goal", params: { goalId: "new", status: "active" } }), /Invalid/);
  await assert.rejects(f.request({ action: "update_goal", params: { goalId: "new", status: "complete" } }), /inactive/);
});
test("budget stop is distinct from completion and cannot be overridden by the model", async () => {
  const f = fixture({ id: "goal", status: "budget_limited", tokenBudget: 10, tokensUsed: 12 });
  assert.equal((await f.request({ action: "get_goal" })).remainingTokens, 0);
  for (const status of ["paused", "complete", "blocked"]) {
    await assert.rejects(f.request({ action: "update_goal", params: { goalId: "goal", status } }), /Budget limit/);
  }
});
test("goal extension IPC returns actual host state without stdout protocol changes", async () => {
  const url = new URL("../electron/goal-extension.ts", import.meta.url).href;
  const script = `import {registerHooks} from 'node:module';
    registerHooks({resolve(s,c,n){return n(s==='../shared/goal.js'?'../shared/goal.ts':s==='./state-context.js'?'./state-context.ts':s,c)}});
    const {requestGoal}=await import(${JSON.stringify(url)});
    const result=await requestGoal('get_goal',{});
    process.send({type:'test_result',result}); process.disconnect();`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true });
  let result, stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("message", message => {
    if (message.type === "desktop_goal_request") child.send({ type: "desktop_goal_response", id: message.id, data: { goal: { status: "paused" } } });
    if (message.type === "test_result") result = message.result;
  });
  await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(new Error(stderr))); });
  assert.equal(result.goal.status, "paused");
});

test("RPC continuation invokes the public custom-message API, never a user prompt", async () => {
  const bridge = readFileSync(new URL("../resources/pi-engine/protocol.js", import.meta.url), "utf8");
  const goalCase = bridge.indexOf('case "desktop_goal_continue":');
  assert.ok(goalCase >= 0);
  const start = bridge.indexOf('{', goalCase) + 1;
  const end = bridge.indexOf("\n            }", start);
  const run = new (Object.getPrototypeOf(async function () {}).constructor)("session", "command", "id", "success", "error", bridge.slice(start, end));
  const calls = [];
  const session = { isStreaming: false, async sendCustomMessage(message, options) { calls.push({ message, options }); } };
  const command = { type: "desktop_goal_continue", goalId: "current", message: "service" };
  const success = () => ({ success: true }), error = () => ({ success: false });
  assert.equal((await run(session, command, "id", success, error)).success, true);
  assert.equal(calls[0].message.customType, "desktop_goal_continuation");
  assert.equal(calls[0].message.display, false);
  assert.equal(calls[0].options.triggerTurn, true);
  session.isStreaming = true;
  assert.equal((await run(session, command, "id", success, error)).success, false);
  assert.equal(calls.length, 1);
});
