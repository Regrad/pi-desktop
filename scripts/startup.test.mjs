import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, unlink } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import os from "node:os";
import { StartupTasks } from "../electron/startup-tasks.ts";
import { lazyModule } from "../electron/lazy-module.ts";
import { sessionDirectoryStamp } from "../electron/session-index.ts";
import { afterFirstPaint } from "../src/after-first-paint.ts";

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("lazy import shares one load and retries only after a failure", async () => {
  let calls = 0;
  const wait = deferred();
  const load = lazyModule(async () => { calls++; await wait.promise; if (calls === 1) throw Error("failed import"); return "sdk"; });
  assert.equal(calls, 0);
  const a = load(), b = load();
  assert.equal(a, b);
  wait.resolve();
  await assert.rejects(a, /failed import/);
  assert.equal(await load(), "sdk");
  assert.equal(await load(), "sdk");
  assert.equal(calls, 2);
});

test("optional services start once, and failure does not prevent independent services", async () => {
  const tasks = new StartupTasks();
  let starts = 0, closes = 0;
  const load = async () => { starts++; return "web"; };
  const close = async () => { closes++; };
  assert.deepEqual(await Promise.all([tasks.start("web", load, close), tasks.start("web", load, close)]), ["web", "web"]);
  assert.equal(starts, 1);
  await assert.rejects(tasks.start("broken", async () => { throw Error("bind failed"); }), /bind failed/);
  assert.equal(await tasks.start("broken", async () => "recovered"), "recovered");
  assert.equal(await tasks.start("control", async () => "control"), "control");
  await Promise.all([tasks.close(), tasks.close()]);
  assert.equal(closes, 1);
  await assert.rejects(tasks.start("late", load), /closing/);
});

test("closing during initialization disposes the late service without leaking a server", async () => {
  const tasks = new StartupTasks(), wait = deferred();
  let closes = 0;
  const starting = tasks.start("web", async () => { await wait.promise; return "server"; }, async () => { closes++; });
  const rejected = assert.rejects(starting, /closing/);
  const closing = tasks.close();
  wait.resolve();
  await Promise.all([rejected, closing]);
  assert.equal(closes, 1);
});

test("a failed service cleanup does not prevent other cleanup", async () => {
  const tasks = new StartupTasks(); let closed = false;
  await tasks.start("bad", async () => 1, async () => { throw Error("cleanup failed"); });
  await tasks.start("good", async () => 2, async () => { closed = true; });
  await assert.rejects(tasks.close(), /cleanup failed/);
  assert.equal(closed, true);
});

test("restoring a chat waits for a painted frame and can be cancelled on navigation", () => {
  const callbacks = new Map(); let id = 0, restored = 0;
  const request = cb => { callbacks.set(++id, cb); return id; };
  const cancel = id => callbacks.delete(id);
  const frame = () => { const pending = [...callbacks.values()]; callbacks.clear(); for (const cb of pending) cb(0); };
  afterFirstPaint(() => { restored++; }, request, cancel);
  assert.equal(restored, 0);
  frame(); assert.equal(restored, 0);
  frame(); assert.equal(restored, 1);
  const stop = afterFirstPaint(() => { restored++; }, request, cancel);
  frame(); stop(); frame();
  assert.equal(restored, 1);
});

const storeSource = readFileSync(new URL("../electron/data-store.ts", import.meta.url), "utf8");
test("fast initialization persists restart pauses without scanning session history", async () => {
  const start = storeSource.indexOf("  async initialize(");
  const begin = storeSource.indexOf("): Promise<void> {", start) + "): Promise<void> {".length;
  const end = storeSource.indexOf("\n  }", begin);
  const parsed = { version: 4, projects: [], conversations: [{ id: "chat", title: "Saved", status: "working",
    goal: { id: "goal", status: "active" }, plan: { revision: 7, execution: "active", steps: [] } }], sessionIndex: { p: "[]" } };
  const bindings = { mkdir: async () => {}, readFile: async () => JSON.stringify(parsed), copyFile: async () => {}, constants: {}, path,
    migratePortableSessions: async (_dir, conversations) => ({ conversations, missing: [] }), resolveStandardSessionsDir: () => "unused",
    migrateChatFiles: async () => {},
    EMPTY_STATE: {}, normalizeQueuedPrompts: () => ({}), normalizeCompactions: () => ({}) };
  const code = stripTypeScriptTypes(`async function initialize(options = {}) {${storeSource.slice(begin, end)}\n}`);
  const initialize = new Function(...Object.keys(bindings), `${code}; return initialize;`)(...Object.values(bindings));
  let saved;
  const host = { dataDir: "test", async loadBuiltinModuleSettings() {}, async initializeAgentDirectory() {},
    async save() { saved = structuredClone(this.state); }, async refreshAllProjectSessions() { assert.fail("History read before first paint"); } };
  await initialize.call(host, { refreshSessions: false });
  assert.equal(saved.conversations[0].plan.execution, "paused");
  assert.equal(saved.conversations[0].goal.status, "paused");
  assert.equal(saved.conversations[0].plan.revision, 8);
  assert.equal(saved.conversations[0].title, "Saved");
  assert.deepEqual(saved.sessionIndex, { p: "[]" });
});
function storeMethod(name, args, getSessionManager) {
  const start = storeSource.indexOf(`  ${name === "refreshProjectSessionIndex" ? "private " : ""}async ${name}(`);
  const begin = storeSource.indexOf("> {", start) + 3;
  const end = storeSource.indexOf("\n  }", begin);
  assert.ok(start >= 0 && begin > start && end > begin);
  const body = stripTypeScriptTypes(`async function run(${args}) {${storeSource.slice(begin, end)}\n}`);
  return new Function("listSessions", "sessionDirectoryStamp", `${body}; return run;`)(async (cwd, dir, signal) => (await getSessionManager()).list(cwd, dir, undefined, signal), sessionDirectoryStamp);
}
async function fixture(t, sessions = [{ id: "listed", title: "Metadata", updatedAt: "now" }]) {
  const directory = await mkdtemp(path.join("C:/AI_Temp", "pi-startup-index-"));
  t.after(async () => {
    assert.ok(directory.startsWith(path.join("C:/AI_Temp", "pi-startup-index-")));
    await rm(directory, { recursive: true, force: true });
  });
  let imports = 0, scans = 0, saves = 0, duringScan;
  const host = { state: { projects: [{ id: "p", path: directory }], conversations: [], sessionIndex: {} }, sessionRefreshes: new Map(),
    getProject(id) { const project = this.state.projects.find(project => project.id === id); if (!project) throw Error("Deleted project"); return project; },
    getSessionDir: () => directory,
    async save() { saves++; }, mergeSession(_id, session) { this.state.conversations.push({ ...session, projectId: "p" }); } };
  const load = async () => { imports++; return { async list() { scans++; await duringScan?.(); return sessions; } }; };
  host.refreshProjectSessionIndex = storeMethod("refreshProjectSessionIndex", "projectId, signal", load).bind(host);
  host.refreshProjectSessions = storeMethod("refreshProjectSessions", "projectId, signal", load).bind(host);
  return { directory, host, get imports() { return imports; }, get scans() { return scans; }, get saves() { return saves; },
    set duringScan(value) { duringScan = value; } };
}

test("warm sidebar index never loads the SDK or reads a history for unchanged files", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "large.jsonl"), "Not parsed: it is an indexed history");
  f.host.state.sessionIndex.p = JSON.stringify([await sessionDirectoryStamp(f.directory)]);
  f.host.state.conversations.push({ id: "old", projectId: "p", title: "Saved chat", updatedAt: "now" });
  assert.equal((await f.host.refreshProjectSessions("p"))[0].title, "Saved chat");
  assert.equal(f.imports, 0);
  assert.equal(f.scans, 0);
  assert.equal(f.saves, 0);
});

test("empty/new directories need no SDK; adding or changing a history invalidates its index", async t => {
  const f = await fixture(t);
  await f.host.refreshProjectSessions("p");
  assert.equal(f.imports, 0);
  assert.equal(f.host.state.sessionIndex.p, JSON.stringify(["[]"]));
  const file = path.join(f.directory, "chat.jsonl");
  await writeFile(file, "first");
  await f.host.refreshProjectSessions("p");
  assert.equal(f.scans, 1);
  await f.host.refreshProjectSessions("p");
  assert.equal(f.scans, 1);
  await writeFile(file, "second revision");
  await f.host.refreshProjectSessions("p");
  assert.equal(f.scans, 2);
  await unlink(file);
  await f.host.refreshProjectSessions("p");
  assert.equal(f.host.state.sessionIndex.p, JSON.stringify(["[]"]));
});

test("concurrent sidebar discovery shares one scan instead of parsing the same files twice", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "chat.jsonl"), "history");
  const wait = deferred(), started = deferred();
  f.duringScan = async () => { started.resolve(); await wait.promise; };
  const first = f.host.refreshProjectSessions("p");
  await started.promise;
  const second = f.host.refreshProjectSessions("p");
  wait.resolve(); await Promise.all([first, second]);
  assert.equal(f.scans, 1);
  assert.equal(f.host.sessionRefreshes.size, 0);
});

test("a live history changing during discovery is not cached as up-to-date", async t => {
  const f = await fixture(t);
  const file = path.join(f.directory, "chat.jsonl");
  await writeFile(file, "history");
  f.duringScan = () => writeFile(file, "history with a concurrent response");
  await f.host.refreshProjectSessions("p");
  assert.equal(f.host.state.sessionIndex.p, undefined);
  assert.deepEqual(f.host.state.conversations, [], "A concurrent edit must not be replaced by stale discovery metadata");
  f.duringScan = undefined;
  await f.host.refreshProjectSessions("p");
  assert.equal(f.scans, 2);
});

test("project deletion during background discovery cannot resurrect its chats", async t => {
  const f = await fixture(t, [{ id: "chat", title: "Do not restore" }]);
  await writeFile(path.join(f.directory, "chat.jsonl"), "history");
  f.duringScan = async () => { f.host.state.projects = []; };
  await f.host.refreshProjectSessions("p");
  assert.deepEqual(f.host.state.conversations, []);
  assert.equal(f.saves, 0);
});

test("a failed index save permits a fresh scan on retry", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "chat.jsonl"), "history");
  const save = f.host.save;
  f.host.save = async () => { throw Error("disk locked"); };
  await assert.rejects(f.host.refreshProjectSessions("p"), /disk locked/);
  assert.equal(f.host.state.sessionIndex.p, undefined);
  f.host.save = save;
  await f.host.refreshProjectSessions("p");
  assert.equal(f.scans, 2);
});

test("an incomplete SDK scan cannot permanently cache a temporarily unreadable history", async t => {
  const f = await fixture(t, []);
  await writeFile(path.join(f.directory, "chat.jsonl"), "temporarily unreadable");
  await f.host.refreshProjectSessions("p");
  assert.equal(f.host.state.sessionIndex.p, undefined);
  await f.host.refreshProjectSessions("p");
  assert.equal(f.scans, 2);
});

test("closing the app aborts indexing without publishing or caching partial metadata", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.directory, "chat.jsonl"), "history");
  const controller = new AbortController();
  f.duringScan = async () => { controller.abort(); };
  await assert.rejects(f.host.refreshProjectSessions("p", controller.signal), { name: "AbortError" });
  assert.deepEqual(f.host.state.conversations, []);
  assert.equal(f.host.state.sessionIndex.p, undefined);
  assert.equal(f.saves, 0);
});

test("startup has no eager SDK import and waits for both native window and painted renderer", () => {
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  const manager = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
  const browser = readFileSync(new URL("../electron/browser-automation.ts", import.meta.url), "utf8");
  assert.doesNotMatch(storeSource, /import\s*\{[^}]*\bSessionManager\b[^}]*\}\s*from/);
  assert.doesNotMatch(manager, /import\s*\{\s*(?:SessionManager|SkillsStore)\s*\}\s*from/);
  assert.doesNotMatch(browser, /import\s*\{\s*chromium/);
  assert.match(main, /store\.initialize\(\{ refreshSessions: false \}\)/);
  assert.match(main, /!windowShown \|\| !rendererReady \|\| backgroundStarted/);
  assert.match(main, /event\.sender !== mainWindow\?\.webContents/);
  assert.match(main, /startupTasks\.close\(\)/);
});

test("actual background-start gate waits for both readiness events and starts once", async () => {
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  const begin = main.indexOf("function startBackgroundServices(): void {");
  const end = main.indexOf("\n}", begin) + 2;
  assert.ok(begin >= 0 && end > begin);
  const body = stripTypeScriptTypes(main.slice(begin, end));
  for (const first of ["window", "renderer"]) {
    const calls = [];
    const gate = new Function("calls", `let shuttingDown=false, mainWindow={}, windowShown=false, rendererReady=false, backgroundStarted=false;
      const refreshSessionIndex=async()=>{calls.push('index')}, ensureWebAccess=async()=>{calls.push('web')}, ensureControlApi=async()=>{calls.push('control')}, writeDiagnostic=async()=>{};
      ${body};return {start:startBackgroundServices,window(){windowShown=true},renderer(){rendererReady=true},close(){shuttingDown=true}};`)(calls);
    gate.start(); assert.equal(calls.length, 0);
    gate[first](); gate.start(); assert.equal(calls.length, 0);
    gate[first === "window" ? "renderer" : "window"](); gate.start(); gate.start();
    assert.deepEqual(calls, ["index", "web", "control"]);
    gate.close(); gate.start(); assert.equal(calls.length, 3);
  }
});

test("the complete owned main-process import graph keeps SDK, skills and Playwright lazy", () => {
  const root = new URL("../", import.meta.url), visited = new Set(), external = new Set();
  function visit(file) {
    if (visited.has(file.href)) return;
    visited.add(file.href);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^(?:import|export)\s+([^;]+?)\s+from\s+["']([^"']+)["']/gm)) {
      if (match[1].trim().startsWith("type ")) continue;
      const specifier = match[2];
      if (!specifier.startsWith(".")) { external.add(specifier); continue; }
      const target = new URL(specifier, file);
      const candidates = [target, new URL(target.href.replace(/\.js$/, ".ts")), new URL(`${target.href}.ts`)];
      const resolved = candidates.find(candidate => existsSync(candidate));
      assert.ok(resolved, `Missing ${specifier} from ${file.href}`);
      visit(resolved);
    }
  }
  visit(new URL("electron/main.ts", root));
  assert.equal(external.has("@earendil-works/pi-coding-agent"), false);
  assert.equal(external.has("playwright-core"), false);
  assert.equal([...visited].some(file => file.endsWith("/skills-store.ts")), false);
  assert.equal([...visited].some(file => file.endsWith("/web-backend.ts")), false);
});
