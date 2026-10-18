import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
function declaration(name) {
  const start = app.indexOf(`  const ${name} = `);
  const end = app.indexOf("\n  };", start);
  assert.ok(start >= 0 && end > start, name);
  return stripTypeScriptTypes(app.slice(start, end + 5));
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture({ working = false, goalMode = false, primaryAction = "send", input = "Задача", attachments = [] } = {}) {
  let pending = {}, messages = [], draft = input;
  const pendingRequestIdsRef = { current: new Set() };
  const activeIdRef = { current: "a" };
  const wait = deferred(), calls = [], notices = [];
  const noop = () => {};
  const bindings = {
    pendingRequestIdsRef,
    setPendingRequests: update => { pending = update(pending); },
    activeConversationId: "a", activeIdRef, working, input, attachments,
    historyQuotes: [], goalMode, planMode: false, primaryAction,
    autoScrollRef: { current: false },
    quotedHistoryPrompt: text => text,
    setInput: value => { draft = value; },
    setAttachments: noop, setHistoryQuotes: noop, setGoalMode: noop, setPlanMode: noop,
    setMessages: update => { messages = update(messages); },
    setQueuedPrompts: noop,
    addNotice: text => notices.push(text),
    window: { piDesktop: Object.fromEntries(["sendPrompt", "setGoal", "resumeConversation", "queuePrompt"].map(name => [name, (...args) => {
      calls.push({ name, args, pendingAtCall: { ...pending } });
      return wait.promise;
    }])) },
  };
  const functions = new Function(...Object.keys(bindings), `
    ${["beginRequest", "finishRequest", "resumeExecution", "submit"].map(declaration).join("\n")}
    return { beginRequest, finishRequest, resumeExecution, submit };
  `)(...Object.values(bindings));
  return { ...functions, wait, calls, notices, activeIdRef, get pending() { return pending; }, get messages() { return messages; }, get draft() { return draft; } };
}

test("preparation is visible before prompt IPC completes and duplicate sends are ignored", async () => {
  const f = fixture();
  const sending = f.submit();
  assert.deepEqual(f.pending, { a: true });
  assert.deepEqual(f.calls[0].pendingAtCall, { a: true });
  assert.equal(f.messages.length, 1);
  assert.equal(f.draft, "");
  await f.submit();
  assert.equal(f.calls.length, 1);
  f.wait.resolve();
  await sending;
  assert.deepEqual(f.pending, {});
});

test("preflight rejection clears preparation and restores the original draft", async () => {
  const f = fixture();
  const sending = f.submit();
  f.wait.reject(Error("Не удалось запустить сеанс"));
  await sending;
  assert.deepEqual(f.pending, {});
  assert.equal(f.messages.length, 0);
  assert.equal(f.draft, "Задача");
  assert.deepEqual(f.notices, ["Не удалось запустить сеанс"]);
  assert.equal(f.beginRequest("a"), true);
});

test("goals and attachment-only prompts use the same preparation lifecycle", async () => {
  for (const options of [{ goalMode: true }, { input: "", attachments: [{ name: "image", mimeType: "image/png", data: "AA==" }] }]) {
    const f = fixture(options);
    const sending = f.submit();
    assert.deepEqual(f.pending, { a: true });
    assert.equal(f.calls[0].name, options.goalMode ? "setGoal" : "sendPrompt");
    f.wait.resolve();
    await sending;
    assert.deepEqual(f.pending, {});
  }
});

test("Continue shows preparation immediately, rejects duplicates and recovers after failure", async () => {
  const f = fixture({ input: "", primaryAction: "resume" });
  const sending = f.submit();
  assert.deepEqual(f.pending, { a: true });
  assert.equal(f.calls[0].name, "resumeConversation");
  await f.submit();
  assert.equal(f.calls.length, 1);
  f.wait.reject(Error("Не удалось продолжить"));
  await sending;
  assert.deepEqual(f.pending, {});
  assert.deepEqual(f.notices, ["Не удалось продолжить"]);
});

test("preparation is isolated by chat; late failure does not restore another chat's draft", async () => {
  const f = fixture();
  const sending = f.submit();
  f.activeIdRef.current = "b";
  assert.equal(f.beginRequest("b"), true);
  assert.equal(f.beginRequest("b"), false);
  f.wait.reject(Error("Чат a не запустился"));
  await sending;
  assert.deepEqual(f.pending, { b: true });
  assert.equal(f.draft, "");
  f.finishRequest("b");
  assert.deepEqual(f.pending, {});
});

test("queueing during a real run does not start or clear preparation", async () => {
  const f = fixture({ working: true });
  f.beginRequest("a");
  const sending = f.submit();
  assert.equal(f.calls[0].name, "queuePrompt");
  f.wait.resolve([]);
  await sending;
  assert.deepEqual(f.pending, { a: true });
});

test("preparation UI is separate from real model work, timing and plan activity", () => {
  assert.match(app, /!working && requestPending && \(/);
  assert.match(app, /<WorkingIndicator \/>\s*<span className="working-message">Подготовка запроса…<\/span>/);
  assert.match(app, /!working && !requestPending && lastDuration !== undefined/);
  assert.match(app, /Boolean\(activeConversationId && pendingRequests\[activeConversationId\]\)/);
  assert.match(app, /disabled=\{requestPending \|\|/);
  assert.match(app, /planIsWorking\(snapshot.conversation.plan, working, snapshot.planWorkingRevision\)/);
  for (const name of ["beginRequest", "finishRequest", "submit", "resumeExecution"])
    assert.doesNotMatch(declaration(name), /setWorking\(|setStartedAt\(/);
});
