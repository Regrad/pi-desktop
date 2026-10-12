import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as sg from "@ast-grep/napi";
import { desktopEvaluateAstGrepRules, evaluateAstGrepRules } from "../node_modules/pi-lens/dist/clients/dispatch/runners/ast-grep-napi.js";
import { scanProjectDiagnostics } from "../node_modules/pi-lens/dist/clients/project-diagnostics/scanner.js";
import { createAnalysisHost } from "../resources/pi-lens/analysis-host.mjs";

const cancel = () => globalThis[Symbol.for("pi.desktop.cancel.native.analysis")]?.();

test("a rejected native rule retains other findings but marks coverage incomplete", async t => {
  const content = "// INJECT_RULE_FAULT\nimport session from 'express-session';\nconst opts={secret:'unsafe'}; app.use(session(opts));\nvar jwt=require('express-jwt'); app.use(jwt({secret:'unsafe'}));\n";
  const { dir, file } = await fixture(t, content);
  const host = createAnalysisHost({ workerUrl: new URL("./fixtures/native-rule-fault-worker.mjs", import.meta.url) });
  t.after(() => host.cancel());
  const result = await host.analyze({ filePath: file, content, cwd: dir, kind: "jsts", unsupportedLanguages: [], options: {} });
  assert.equal(result.diagnostics.analysisIncomplete, true);
  assert.ok(result.logs.some(message => message.includes("rejected by native engine")));
  assert.ok(result.diagnostics.length > 0, "other rules still contribute genuine findings");
  assert.ok(!result.diagnostics.some(d => d.rule === "express-jwt-hardcoded-secret-javascript"));
});
async function fixture(t, content, suffix = ".js") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lens-isolated-"));
  t.after(async () => { await cancel(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const file = path.join(dir, "source" + suffix);
  await writeFile(file, content, "utf8");
  return { dir, file };
}

test("real isolated matcher retains full diagnostics and does not change source", async t => {
  const content = "import session from 'express-session';\nconst opts={secret:'unsafe'}; app.use(session(opts));\nvar jwt = require('express-jwt'); app.use(jwt({secret:'unsafe'}));\n";
  const { dir, file } = await fixture(t, content);
  const expected = evaluateAstGrepRules(file, sg.parse(sg.Lang.JavaScript, content).root(), dir, "jsts", { content, sgModule: sg });
  const unsupportedLanguageLog = new Set();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  t.after(() => clearInterval(timer));
  const actual = await desktopEvaluateAstGrepRules(file, content, dir, "jsts", { unsupportedLanguageLog });
  assert.deepEqual(actual, expected);
  assert.ok(actual.some(d => d.rule === "express-jwt-hardcoded-secret-javascript"));
  assert.ok(unsupportedLanguageLog.size > 0, "telemetry dedupe is returned to the parent session");
  assert.ok(ticks > 0, "parent event loop remains responsive during native loading/matching");
  assert.equal(await readFile(file, "utf8"), content);
});

test("HTML script injections retain file coordinates and Unicode handling", async t => {
  const content = '<div>Привет 👋</div>\n<script>\nvar jwt=require("express-jwt"); app.use(jwt({secret:"unsafe"}));\n</script>';
  const { dir, file } = await fixture(t, content, ".html");
  const expected = evaluateAstGrepRules(file, sg.parse(sg.Lang.Html, content).root(), dir, "html", { content, sgModule: sg });
  assert.deepEqual(await desktopEvaluateAstGrepRules(file, content, dir, "html"), expected);
});

test("stale source never receives a successful empty/incorrect report", async t => {
  const { dir, file } = await fixture(t, "const current = 1;");
  await assert.rejects(desktopEvaluateAstGrepRules(file, "const old = 2;", dir, "jsts"), /stale findings discarded/);
  assert.equal(await readFile(file, "utf8"), "const current = 1;");
});

test("cancelling real native analysis does not publish findings or continue the job", async t => {
  const rows = Array.from({ length: 8000 }, (_, i) => `k${i}:{value:${i},text:'item ${i}'}`).join(",");
  const content = "import session from 'express-session';\nconst large={" + rows + "};\nconst opts={secret:'unsafe'}; app.use(session(opts));";
  const { dir, file } = await fixture(t, content);
  const abort = new AbortController();
  const result = assert.rejects(desktopEvaluateAstGrepRules(file, content, dir, "jsts", {}, abort.signal), { name: "AbortError" });
  const timer = setTimeout(() => abort.abort(), 150);
  t.after(() => clearTimeout(timer));
  await result;
  await cancel();
  assert.equal(await readFile(file, "utf8"), content);
});

test("Stop before the executor module finishes loading cannot start a late analysis", async t => {
  const { dir, file } = await fixture(t, "const value = 1;");
  const epochKey = Symbol.for("pi.desktop.native.analysis.epoch");
  const pending = assert.rejects(desktopEvaluateAstGrepRules(file, "const value = 1;", dir, "jsts"), { name: "AbortError" });
  globalThis[epochKey] = (globalThis[epochKey] ?? 0) + 1;
  await cancel();
  await pending;
});

test("real project scan includes the isolated AST findings", async t => {
  const content = "var jwt = require('express-jwt'); app.use(jwt({secret:'unsafe'}));";
  const { dir, file } = await fixture(t, content);
  const snapshot = await scanProjectDiagnostics({ cwd: dir, tier: "cheap", files: [file], maxFiles: 1 });
  assert.ok(snapshot.runners.includes("ast-grep-napi"));
  assert.ok(snapshot.diagnostics.some(d => d.rule === "express-jwt-hardcoded-secret-javascript"));
  assert.notEqual(snapshot.astGrepStatus, "incomplete");
  assert.equal(await readFile(file, "utf8"), content);
});
