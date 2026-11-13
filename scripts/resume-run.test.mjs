import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { canResumeRun, composerAction } from "../shared/run-state.ts";
import { projectDesktopServiceContext } from "../resources/pi-rpc-bridge/service-context.js";

test("composer offers Continue only for interrupted idle work with no new draft", () => {
  const failed = { startedAt: "start", completedAt: "end", interruption: {} };
  assert.equal(composerAction(false, false, failed), "resume");
  assert.equal(composerAction(true, false, failed), "queue");
  assert.equal(composerAction(true, true, failed), "queue");
  assert.equal(composerAction(false, true, failed), "send");
  assert.equal(composerAction(false, false, { startedAt: "start", completedAt: "end" }), "send");
  assert.equal(composerAction(false, false), "send");
  assert.equal(canResumeRun({ startedAt: "interrupted by process exit" }), true);
  assert.equal(canResumeRun(JSON.parse(JSON.stringify(failed))), true);
});

const bridge = readFileSync(new URL("../resources/pi-engine/protocol.js", import.meta.url), "utf8");
const anchor = '            case "desktop_run_resume": {';
const begin = bridge.indexOf(anchor) + anchor.length;
const end = bridge.indexOf('\n            }', begin);
assert.ok(begin >= anchor.length && end > begin);
const run = new Function("session", "command", "success", "error", `return (async () => { const id = command.id; ${bridge.slice(begin, end)} })();`);
const success = (id, type) => ({ id, type, success: true });
const error = (id, type, error) => ({ id, type, error, success: false });

test("resume RPC appends a hidden continuation, not an empty/new user task", async () => {
  const history = [
    { role: "user", content: "Continue building server in C:/server" },
    { role: "assistant", content: [{ type: "toolCall", id: "done", name: "read" }] },
    { role: "toolResult", toolCallId: "done", content: "Already verified" },
  ];
  const original = structuredClone(history);
  let options;
  const session = { isStreaming: false, async sendCustomMessage(message, config) { history.push({ ...message, role: "custom" }); options = config; } };
  assert.equal((await run(session, { id: "resume", type: "desktop_run_resume", message: "ignored payload" }, success, error)).success, true);
  assert.deepEqual(history.slice(0, 3), original);
  assert.equal(history.at(-1).customType, "desktop_run_continuation");
  assert.equal(history.at(-1).display, false);
  assert.match(history.at(-1).content, /last confirmed state/);
  assert.doesNotMatch(history.at(-1).content, /ignored payload/);
  assert.deepEqual(options, { triggerTurn: true });
  assert.equal(history.filter(message => message.role === "user").length, 1);
});

test("resume RPC rejects an active stream before changing history", async () => {
  const session = { isStreaming: true, async sendCustomMessage() { assert.fail("Must not append"); } };
  assert.equal((await run(session, { type: "desktop_run_resume" }, success, error)).success, false);
});

test("live plan/notebook metadata attaches to the resume request, not to an older tool result", () => {
  const history = [{ role: "toolResult", content: "Previous operation" },
    { role: "custom", customType: "desktop_run_continuation", display: false, content: "User resumed interrupted task" },
    { role: "custom", customType: "desktop_plan_state", display: false, content: "Current active plan" }];
  const projected = projectDesktopServiceContext(history);
  assert.deepEqual(projected[0], history[0]);
  assert.equal(projected.length, 2);
  assert.match(JSON.stringify(projected[1].content), /Current active plan/);
});

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
test("process-exit UI event clears busy state and retains the resumable run", () => {
  const anchor = "  const handlePiEvent = (event: JsonObject) => {";
  const begin = app.indexOf(anchor) + anchor.length;
  const end = app.indexOf("\n  };", begin);
  assert.ok(begin >= anchor.length && end > begin);
  let snapshot = { state: { isStreaming: true } }, working = true;
  const noop = () => {};
  const bindings = { setSnapshot: update => { snapshot = update(snapshot); }, setWorking: value => { working = value; },
    setWorkingMessage: noop, setStreamingMessage: noop, setTools: noop, setLastDuration: noop, setElapsed: noop, startedAtRef: {} };
  const source = stripTypeScriptTypes(`function handle(event) {${app.slice(begin, end)}\n}`);
  const handle = new Function(...Object.keys(bindings), `${source}; return handle;`)(...Object.values(bindings));
  handle({ type: "desktop_run_state", stopped: true, run: { startedAt: "start", completedAt: "end", interruption: {} } });
  assert.equal(working, false);
  assert.equal(snapshot.state.isStreaming, false);
  assert.equal(composerAction(working, false, snapshot.run), "resume");
});

test("Enter with an empty composer uses the same continuation action as the button", async () => {
  const anchor = "  const submit = async (explainQuote?: string) => {";
  const begin = app.indexOf(anchor) + anchor.length;
  const end = app.indexOf("\n  };", begin);
  assert.ok(begin >= anchor.length && end > begin);
  let resumes = 0;
  const body = stripTypeScriptTypes(`async function submit(explainQuote) {${app.slice(begin, end)}\n}`);
  const bindings = { loading: false, input: "", historyQuotes: [], attachments: [], primaryAction: "resume", quotedHistoryPrompt: text => text,
    resumeExecution: async () => { resumes++; } };
  const submit = new Function(...Object.keys(bindings), `${body}; return submit;`)(...Object.values(bindings));
  await submit();
  assert.equal(resumes, 1);
  assert.match(app, /aria-label=\{primaryAction === "resume" \? "Продолжить" : "Отправить"\}/);
  assert.match(app, /<span>Продолжить<\/span>/);
});
