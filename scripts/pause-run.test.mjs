import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { patchDesktopContinuation } from "../resources/pi-rpc-bridge/continuation-patch.js";
import { createRunPause } from "../resources/pi-engine/pause.js";
import { omitHistoryEntries } from "../shared/chat-history.ts";

const appRoot = process.env.PI_TEST_APP_ROOT || process.cwd();
const { PiRpcProcess } = await import(pathToFileURL(path.join(appRoot, "dist-electron/electron/pi-rpc-process.js")));
const { updatedPlan } = await import(pathToFileURL(path.join(appRoot, "dist-electron/shared/plan.js")));
const { isPlanning } = await import(pathToFileURL(path.join(appRoot, "dist-electron/shared/planning.js")));
const { SessionManager } = await import(pathToFileURL(path.join(appRoot, "node_modules/@earendil-works/pi-coding-agent/dist/index.js")));
const { sessionTranscript } = await import(pathToFileURL(path.join(appRoot, "dist-electron/electron/session-transcript.js")));
const managerSource = await readFile(path.join(appRoot, "dist-electron/electron/pi-manager.js"), "utf8");
const managerMethod = name => {
  const start = managerSource.search(new RegExp(`^    (async )?${name}\\(`, "m"));
  const end = managerSource.indexOf("\n    }", start);
  assert.ok(start >= 0 && end > start, name);
  return new Function("updatedPlan", "isPlanning", `return class {${managerSource.slice(start, end + 6)}}.prototype.${name}`)(updatedPlan, isPlanning);
};
const tempRoot = process.platform === "win32" ? "C:/AI_Temp" : process.env.TMPDIR || "/tmp";

test("discarded entries leave cached history and cannot return in a late page", () => {
  const page = { rows: [
    { id: "user", position: 10, message: { role: "user" } },
    { id: "discarded", position: 11, message: { role: "assistant" } },
    { id: "answer", position: 12, message: { role: "assistant" } },
  ], before: "user", after: "answer", total: 20, marks: [{ id: "user", position: 10, timestamp: 1 }] };
  const omitted = new Set(["discarded"]);
  const visible = omitHistoryEntries(page, omitted);
  assert.deepEqual(visible.rows.map(row => row.id), ["user", "answer"]);
  assert.equal(visible.rows[1].position, 11);
  assert.equal(visible.total, 19);
  assert.equal(page.rows.length, 3);
  assert.deepEqual(omitHistoryEntries(structuredClone(page), omitted), visible);
  assert.equal(omitHistoryEntries(visible, omitted), visible);
  assert.equal(omitHistoryEntries(undefined, omitted), undefined);
});

test("discarding a page boundary keeps paging anchored to a retained message", () => {
  const page = { rows: [{ id: "discarded", position: 0 }, { id: "kept", position: 1 }], before: "discarded", after: "kept", total: 2, marks: [] };
  assert.equal(omitHistoryEntries(page, new Set(["discarded"])).before, "kept");
  assert.equal(omitHistoryEntries(page, new Set(["kept"])).after, "discarded");
  assert.equal(omitHistoryEntries(page, new Set(["discarded", "kept"])), undefined);
});

test("a late pause click cannot turn a completed answer into suspended work", () => {
  const events = [];
  const session = { isStreaming: true, abort() { assert.fail("Completed answer must remain complete"); } };
  const pause = createRunPause(session, event => events.push(event));
  pause.observe({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" } });
  pause.request();
  assert.equal(pause.state, undefined);
  assert.deepEqual(events.at(-1), { type: "desktop_pause_state", pause: null });
});

test("the pinned SDK continuation patch is idempotent and rejects incompatible upstream code", async () => {
  const source = await readFile(path.join(appRoot, "node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js"), "utf8");
  assert.equal(patchDesktopContinuation(source), source);
  assert.throws(() => patchDesktopContinuation("class UnknownSession {}"), /no longer matches/);
});

test("new input during a pending pause uses Send now instead of remaining queued", async () => {
  let sent;
  const host = {
    runtimes: new Map([["chat", { activeRun: { pause: "requested" } }]]),
    store: { getQueuedPrompts: () => [] },
    async sendPrompt(...args) { sent = args; },
  };
  assert.deepEqual(await managerMethod("queuePrompt").call(host, "chat", "New direction", [], false), []);
  assert.deepEqual(sent, ["chat", "New direction", [], "steer", undefined, false, false]);
});

test("resuming restores only the goal and checklist paused by this run", () => {
  const conversation = { plan: { revision: 4, execution: "paused", steps: [{ step: "Work", status: "in_progress" }] },
    goal: { id: "goal", status: "paused" } };
  const host = { store: { getConversation: () => conversation } };
  const run = { pause: "paused", interruption: { planRevision: 4, goalId: "goal" } };
  const changes = managerMethod("pausedWorkChanges").call(host, "chat", run);
  assert.equal(changes.plan.execution, "active");
  assert.equal(changes.goal.status, "active");
  conversation.plan.revision++;
  conversation.goal.id = "other";
  assert.deepEqual(managerMethod("pausedWorkChanges").call(host, "chat", run), {});
});

test("a rejected pause request restores the active button instead of leaving a pending pause", async () => {
  const runtime = { activeRun: { startedAt: "start" }, snapshot: {}, rpc: { request: async () => { throw new Error("Unavailable"); } } };
  const events = [];
  const host = { runtimes: new Map([["chat", runtime]]), publish: (channel, payload) => events.push(payload.event) };
  await assert.rejects(managerMethod("pauseConversation").call(host, "chat"), /Unavailable/);
  assert.equal(runtime.activeRun.pause, undefined);
  assert.equal(events.at(-1).run.pause, undefined);
});

async function fixture(t, mode) {
  const folder = await mkdtemp(path.join(tempRoot, "pi-pause-test-"));
  const agentDir = path.join(folder, "agent");
  await mkdir(agentDir);
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [], compaction: { enabled: false }, retry: { enabled: false } }));
  const log = path.join(folder, "tool.log");
  const release = path.join(folder, "release");
  const extension = path.join(folder, "tool.mjs");
  await writeFile(extension, `import { appendFile, access } from 'node:fs/promises';
    export default function(pi) {
      ${mode === "thinking-with-state" ? `pi.on("turn_end", () => {
        pi.sendMessage({ customType: "fixture_state", content: "STATE_AFTER_ABORT", display: false }, { triggerTurn: false });
      });` : ""}
      pi.registerTool({ name: 'pause_fixture', label: 'Pause fixture', description: 'Controlled test operation',
        parameters: { type: 'object', properties: {} },
        async execute(id, args, signal) {
          await appendFile(${JSON.stringify(log)}, 'started\\n');
          while (true) {
            signal?.throwIfAborted();
            try { await access(${JSON.stringify(release)}); break; } catch {}
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          await appendFile(${JSON.stringify(log)}, 'completed\\n');
          return { content: [{ type: 'text', text: 'Confirmed fixture result' }] };
        }
      });
    }`);
  const captured = [];
  const events = [];
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const data of req) chunks.push(data);
    captured.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (captured.length === 1 && mode.startsWith("thinking")) {
      res.write(chunk({ role: "assistant", reasoning_content: "UNFINISHED_THOUGHT" }));
    } else if (captured.length === 1) {
      const tool_calls = Array.from({ length: mode === "batch" ? 2 : 1 }, (_, index) => ({
        index, id: `fixture-call-${index}`, type: "function", function: { name: "pause_fixture", arguments: "{}" },
      }));
      res.end(chunk({ role: "assistant", tool_calls }) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
    } else {
      res.end(chunk({ role: "assistant", content: "Completed after resume" }, "stop") + "data: [DONE]\n\n");
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "fixture",
    models: [{ id: "fixture", name: "fixture", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 256 }],
  } } }));
  const rpc = new PiRpcProcess({
    executablePath: process.env.PI_TEST_EXECUTABLE || process.execPath,
    enginePath: path.join(appRoot, "resources/pi-engine/worker.mjs"),
    cwd: folder, agentDir, sessionsDir: path.join(folder, "sessions"), sessionId: "pause-fixture",
    provider: "fixture", model: "fixture", thinkingLevel: "medium", isolatedExtensions: [extension],
    mcpEntryPath: "unused", mcpDirectTools: [], onExtensionUi() {}, onExit() {},
    onEvent(event) { events.push(event); },
  });
  t.after(async () => {
    await rpc.stop();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    assert.ok(path.resolve(folder).startsWith(path.resolve(tempRoot) + path.sep));
    await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const wait = async predicate => {
    const deadline = Date.now() + 8000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for fixture: " + JSON.stringify(events.slice(-5)));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  await rpc.start();
  await rpc.request("prompt", { message: "Perform the fixture task" });
  return { rpc, captured, events, wait, log, release };
}

test("pause cancels thinking immediately and resumes the existing task without adding text", { timeout: 20000 }, async t => {
  const f = await fixture(t, "thinking");
  await f.wait(() => f.events.some(event => event.assistantMessageEvent?.type === "thinking_delta"));
  await f.rpc.request("desktop_pause");
  await f.wait(() => f.events.some(event => event.pause === "paused"));
  assert.equal(f.captured.length, 1);
  const pausedHistory = await f.rpc.request("get_messages");
  assert.doesNotMatch(JSON.stringify(pausedHistory.messages), /UNFINISHED_THOUGHT/);
  const state = await f.rpc.request("get_state");
  const reopened = SessionManager.open(state.sessionFile, path.dirname(state.sessionFile), path.dirname(path.dirname(state.sessionFile)));
  assert.doesNotMatch(JSON.stringify(sessionTranscript(reopened.getBranch()).rows), /UNFINISHED_THOUGHT/);
  const omission = f.events.findIndex(event => event.type === "entry_appended" && event.entry?.type === "context_edit" && event.entry.replacement === null);
  assert.ok(omission >= 0 && omission < f.events.findIndex(event => event.type === "agent_settled"));
  const resumed = f.rpc.request("desktop_pause_resume");
  await resumed;
  assert.equal(f.captured.length, 2);
  assert.equal(f.captured[1].messages.filter(message => message.role === "user").length, 1);
  assert.doesNotMatch(JSON.stringify(f.captured[1]), /UNFINISHED_THOUGHT|user clicked Continue|Resume the interrupted task/);
  assert.equal(f.events.filter(event => event.type === "agent_settled").length, 2);
});

test("pause lets a running tool finish and preserves its result without replay", { timeout: 20000 }, async t => {
  const f = await fixture(t, "tool");
  await f.wait(() => f.events.some(event => event.type === "tool_execution_start"));
  await f.rpc.request("desktop_pause");
  assert.equal(f.events.some(event => event.type === "agent_settled"), false);
  await writeFile(f.release, "finish");
  await f.wait(() => f.events.some(event => event.pause === "paused"));
  assert.equal(f.captured.length, 1);
  await f.rpc.request("desktop_pause_resume");
  assert.match(JSON.stringify(f.captured[1].messages), /Confirmed fixture result/);
  assert.equal((await readFile(f.log, "utf8")), "started\ncompleted\n");
  assert.equal(f.captured[1].messages.filter(message => message.role === "user").length, 1);
});

test("pause removes the interrupted response even when an extension appends service state", { timeout: 20000 }, async t => {
  const f = await fixture(t, "thinking-with-state");
  await f.wait(() => f.events.some(event => event.assistantMessageEvent?.type === "thinking_delta"));
  await f.rpc.request("desktop_pause");
  await f.wait(() => f.events.some(event => event.pause === "paused"));
  const history = await f.rpc.request("get_messages");
  assert.doesNotMatch(JSON.stringify(history.messages), /UNFINISHED_THOUGHT/);
  assert.match(JSON.stringify(history.messages), /STATE_AFTER_ABORT/);
  await f.rpc.request("desktop_pause_resume");
  assert.equal(f.captured.length, 2);
});

test("pausing parallel tools records every result before stopping the next model request", { timeout: 20000 }, async t => {
  const f = await fixture(t, "batch");
  await f.wait(() => f.events.filter(event => event.type === "tool_execution_start").length === 2);
  await f.rpc.request("desktop_pause");
  await writeFile(f.release, "finish");
  await f.wait(() => f.events.some(event => event.pause === "paused"));
  assert.equal(f.captured.length, 1);
  await f.rpc.request("desktop_pause_resume");
  assert.equal(f.captured[1].messages.filter(message => message.role === "tool").length, 2);
  assert.equal((await readFile(f.log, "utf8")).match(/completed/g).length, 2);
});

test("new input on a fully paused chat starts from the saved history", { timeout: 20000 }, async t => {
  const f = await fixture(t, "thinking");
  await f.wait(() => f.events.some(event => event.assistantMessageEvent?.type === "thinking_delta"));
  await f.rpc.request("desktop_pause");
  await f.wait(() => f.events.some(event => event.pause === "paused"));
  await f.rpc.request("prompt", { message: "NEW_DIRECTION" });
  await f.wait(() => f.events.filter(event => event.type === "agent_settled").length === 2);
  assert.equal(f.captured.length, 2);
  assert.match(JSON.stringify(f.captured[1].messages.at(-1)), /NEW_DIRECTION/);
  assert.doesNotMatch(JSON.stringify(f.captured[1]), /UNFINISHED_THOUGHT/);
});

test("a message arriving during cancellation starts after settlement instead of becoming stranded", { timeout: 20000 }, async t => {
  const f = await fixture(t, "thinking");
  await f.wait(() => f.events.some(event => event.assistantMessageEvent?.type === "thinking_delta"));
  await Promise.all([
    f.rpc.request("desktop_pause"),
    f.rpc.request("steer", { message: "NEW_DIRECTION_DURING_CANCELLATION" }),
  ]);
  await f.wait(() => f.events.filter(event => event.type === "agent_settled").length === 2);
  assert.equal(f.captured.length, 2);
  assert.match(JSON.stringify(f.captured[1].messages), /NEW_DIRECTION_DURING_CANCELLATION/);
  assert.equal((await f.rpc.request("get_state")).pendingMessageCount, 0);
});

test("a new message while pause is pending steers after the tool and cancels the pause", { timeout: 20000 }, async t => {
  const f = await fixture(t, "tool");
  await f.wait(() => f.events.some(event => event.type === "tool_execution_start"));
  await f.rpc.request("desktop_pause");
  await f.rpc.request("steer", { message: "NEW_DIRECTION" });
  await writeFile(f.release, "finish");
  await f.wait(() => f.events.some(event => event.type === "agent_settled"));
  assert.equal(f.captured.length, 2);
  const messages = f.captured[1].messages;
  const result = messages.findIndex(message => message.role === "tool");
  const direction = messages.findIndex(message => JSON.stringify(message).includes("NEW_DIRECTION"));
  assert.ok(result >= 0 && direction > result);
  assert.equal(f.events.some(event => event.pause === "paused"), false);
});

test("Stop during a pending pause cancels the tool and leaves work resumable", { timeout: 20000 }, async t => {
  const f = await fixture(t, "tool");
  await f.wait(() => f.events.some(event => event.type === "tool_execution_start"));
  await f.rpc.request("desktop_pause");
  await f.rpc.request("abort");
  await f.wait(() => f.events.some(event => event.pause === "paused"));
  assert.equal(f.captured.length, 1);
  assert.equal(await readFile(f.log, "utf8"), "started\n");
  await f.rpc.request("desktop_pause_resume");
  assert.equal(f.captured.length, 2);
});
