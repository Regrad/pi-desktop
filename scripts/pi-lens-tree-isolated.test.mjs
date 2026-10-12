import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { serialize, deserialize } from "node:v8";
import { TreeSitterClient } from "../node_modules/pi-lens/dist/clients/tree-sitter-client.js";
import { desktopExtractModuleFile } from "../node_modules/pi-lens/dist/clients/module-report.js";
import { captureReviewGraphStructuralIr } from "../node_modules/pi-lens/dist/clients/review-graph/builder.js";
import { tryExpandRead } from "../node_modules/pi-lens/dist/clients/read-expansion.js";
import { ComplexityClient } from "../node_modules/pi-lens/dist/clients/complexity-client.js";
import { FactStore } from "../node_modules/pi-lens/dist/clients/dispatch/fact-store.js";
import { importFactProvider } from "../node_modules/pi-lens/dist/clients/dispatch/facts/import-facts.js";
import { functionFactProvider } from "../node_modules/pi-lens/dist/clients/dispatch/facts/function-facts.js";
import { commentFactProvider } from "../node_modules/pi-lens/dist/clients/dispatch/facts/comment-facts.js";
import { tryCatchFactProvider } from "../node_modules/pi-lens/dist/clients/dispatch/facts/try-catch-facts.js";
import { loadWebTreeSitter } from "../node_modules/pi-lens/dist/clients/deps/web-tree-sitter.js";
import { withAnalysisScope } from "../node_modules/pi-lens/dist/desktop-analysis/analysis-context.mjs";
import { patchPiLensTreeIsolation, treeIsolationFiles } from "../resources/pi-lens/tree-isolation-patch.mjs";
import { queryLoader, queriesForLanguage } from "../node_modules/pi-lens/dist/clients/tree-sitter-query-loader.js";
import { createAnalysisHost } from "../resources/pi-lens/analysis-host.mjs";
import treeRunner from "../node_modules/pi-lens/dist/clients/dispatch/runners/tree-sitter.js";
import { getSharedTreeSitterClient, isTreeSitterWasmAborted } from "../node_modules/pi-lens/dist/clients/tree-sitter-shared.js";
import { createDispatchContext } from "../node_modules/pi-lens/dist/clients/dispatch/dispatcher.js";

const cancel = () => globalThis[Symbol.for("pi.desktop.cancel.native.analysis")]?.();

test("runner propagates Stop and a remote WASM fault cannot poison the parent", async t => {
  const { dir, file } = await fixture(t, content);
  const ctx = createDispatchContext(file, dir, { getFlag: () => false }, new FactStore(), false);
  const client = getSharedTreeSitterClient();
  await client.init();
  const original = client.runQueriesOnFile;
  t.after(() => { client.runQueriesOnFile = original; });
  client.runQueriesOnFile = async () => { throw new DOMException("Stop", "AbortError"); };
  await assert.rejects(treeRunner.run(ctx), { name: "AbortError" });
  client.runQueriesOnFile = async () => { throw new Error("Aborted(remote test fault)"); };
  assert.equal((await treeRunner.run(ctx)).analysisIncomplete, true);
  assert.equal(isTreeSitterWasmAborted(), false);
  client.runQueriesOnFile = original;
  assert.notEqual((await treeRunner.run(ctx)).analysisIncomplete, true);
});

test("cache measurement remains nonnegative across executor retirement", async t => {
  const { file } = await fixture(t, content);
  const client = new TreeSitterClient();
  const query = definition('(function_declaration name: (identifier) @NAME)');
  for (let i = 0; i < 3; i++) await client.runQueryOnFile(query, file, "typescript", {}, content);
  let measurement;
  await client.withParseCacheMeasurement(async () => {
    await cancel();
    return client.runQueryOnFile(query, file, "typescript", {}, content);
  }, stats => { measurement = stats; });
  for (const key of ["lookups", "hits", "misses", "parserInvocations"]) assert.ok(measurement[key] >= 0, key);
  assert.ok(measurement.parserInvocations > 0);
});
async function fixture(t, content, extension = ".ts") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lens-tree-isolated-"));
  t.after(async () => { await cancel(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const file = path.join(dir, "source" + extension);
  await writeFile(file, content, "utf8");
  return { dir, file };
}
function payload(method, args) {
  return { engine: "tree", method, args, context: { cwd: process.cwd(), trust: "unknown", generation: 0, capacity: 50 } };
}
function baseline(payloads) {
  const result = spawnSync(process.execPath, [path.resolve("scripts/fixtures/tree-analysis-baseline.mjs")], {
    input: serialize(payloads), windowsHide: true, timeout: 30_000, maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr.toString());
  return deserialize(result.stdout).map(row => row.value);
}
const definition = (query, language = "typescript") => ({ id: "parity", name: "parity", severity: "warning", category: "test", language, message: "test", query, metavars: ["NAME"], has_fix: false, filePath: "" });
const content = `import { readFile } from 'node:fs';
export { readFile as readText } from 'node:fs';
/** Документация 👋 */
export async function sample(value: number) {
  try {
    if (value > 0) return await fetch('/api/data');
    return readFile('source.txt', () => {});
  } catch (err) { console.log(err); throw err; }
}
export class Example { method() { return sample(1); } }
`;

test("all tree-sitter consumers are idempotently isolated, including the bundled extension", async () => {
  for (const file of ["dist/index.js", ...treeIsolationFiles]) {
    const source = await readFile(path.join("node_modules/pi-lens", file), "utf8");
    const patched = patchPiLensTreeIsolation(source, file);
    assert.equal(patchPiLensTreeIsolation(patched, file), patched, file);
    assert.equal(patched, source, `installed ${file} has current bridge`);
  }
  assert.throws(() => loadWebTreeSitter(), /supervised analysis executor/);
  await assert.rejects(new TreeSitterClient().withParsedTree("x.ts", "typescript", "", () => true), /Unregistered/);
});

test("real queries preserve captures, Unicode coordinates and warm parse/query caches", async t => {
  const { file } = await fixture(t, content);
  const client = new TreeSitterClient();
  const queries = [definition('(function_declaration name: (identifier) @NAME)'), definition('(class_declaration name: (type_identifier) @NAME)')];
  queries[1].id = "class-parity";
  const [expected] = baseline([payload("queries", { queryDefs: queries, filePath: file, languageId: "typescript", options: { maxResults: 10 }, contentOverride: content })]);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  t.after(() => clearInterval(timer));
  const actual = await client.runQueriesOnFile(queries, file, "typescript", { maxResults: 10 }, content);
  assert.deepEqual(actual, expected);
  assert.equal(actual.length, 2);
  assert.ok(ticks > 0);
  const before = client.getParseCacheStats();
  assert.deepEqual(await client.runQueriesOnFile(queries, file, "typescript", { maxResults: 10 }, content), expected);
  assert.ok(client.getParseCacheStats().hits > before.hits);
  assert.equal(client.getParseCacheStats().parserInvocations, before.parserInvocations);
  assert.equal(await readFile(file, "utf8"), content);
});

test("file facts, structural graph IR, module report and complexity match original algorithms", async t => {
  const { file, dir } = await fixture(t, content);
  const providers = { importFactProvider, functionFactProvider, commentFactProvider, tryCatchFactProvider };
  const input = [["file.content", content]];
  const expected = baseline([
    ...Object.keys(providers).map(provider => payload("facts", { provider, input, ctx: { filePath: file, cwd: dir, kind: "jsts" } })),
    payload("graph", { input, filePath: file, cwd: dir, content }),
    payload("module", { absPath: file, languageId: "typescript", content }),
    payload("complexity", { filePath: file }),
  ]);
  for (const [index, provider] of Object.values(providers).entries()) {
    const store = new FactStore();
    store.setFileFact(file, "file.content", content);
    await provider.run({ filePath: file, cwd: dir, kind: "jsts" }, store);
    for (const [key, value] of expected[index].writes) assert.deepEqual(store.getFileFact(file, key), value, key);
  }
  const store = new FactStore();
  store.setFileFact(file, "file.content", content);
  const graph = await captureReviewGraphStructuralIr(file, dir, content, store);
  assert.deepEqual(graph, expected[4].value);
  assert.equal(graph.complete, true);
  for (const [key, value] of expected[4].writes) assert.deepEqual(store.getFileFact(file, key), value);
  assert.deepEqual(await desktopExtractModuleFile(file, "typescript", content), expected[5]);
  assert.ok(expected[5].symbols.some(symbol => symbol.name === "sample"));
  assert.deepEqual(await new ComplexityClient().analyzeFile(file), expected[6]);
  assert.ok(expected[6].functionCount > 0);
});

test("read expansion keeps its original enclosing-symbol behavior", async t => {
  const source = 'function example() {\n' + Array.from({ length: 15 }, (_, i) => `  const n${i} = ${i};`).join('\n') + '\n}\n';
  const { file } = await fixture(t, source, ".js");
  const client = new TreeSitterClient();
  await client.isLanguageSupported("javascript");
  const [expected] = baseline([payload("supports", { languageId: "javascript" }), payload("read", { filePath: file, requestedOffset: 4, requestedLimit: 3, totalLines: 18 })]).slice(1);
  const actual = await tryExpandRead(file, 4, 3, 18, client);
  delete expected.durationMs; delete actual.durationMs;
  assert.deepEqual(actual, expected);
  assert.equal(actual.enclosingSymbol.name, "example");
});

test("scoped cancellation and expired dispatch deadline cannot return clean reports", async t => {
  const { file } = await fixture(t, content);
  const query = definition('(function_declaration name: (identifier) @NAME)');
  const client = new TreeSitterClient();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(withAnalysisScope({ signal: controller.signal }, () => client.runQueryOnFile(query, file, "typescript")), { name: "AbortError" });
  await assert.rejects(withAnalysisScope({ deadlineAt: Date.now() - 1 }, () => client.runQueryOnFile(query, file, "typescript")), /timed out; analysis incomplete/);
  await assert.rejects(client.runQueryOnFile(query, file, "nonexistent-grammar"), /Grammar unavailable/);
  assert.equal((await client.runQueryOnFile(query, file, "typescript")).length, 1);
});

test("Stop epoch prevents later analyzers in the same tool-result hook from starting", async t => {
  const { file } = await fixture(t, content);
  const client = new TreeSitterClient();
  const key = Symbol.for("pi.desktop.native.analysis.epoch");
  await withAnalysisScope({}, async () => {
    globalThis[key] = (globalThis[key] ?? 0) + 1;
    await assert.rejects(client.init(), { name: "AbortError" });
    await assert.rejects(client.runQueryOnFile(definition('(identifier) @NAME'), file, "typescript"), { name: "AbortError" });
  });
  assert.equal(await client.init(), true, "a genuinely new operation is still allowed");
});

test("uncompilable rules retain other findings but cannot masquerade as a complete check", async t => {
  const { file } = await fixture(t, content);
  const client = new TreeSitterClient();
  const valid = definition('(function_declaration name: (identifier) @NAME)');
  const bad = { ...definition('(unknown_broken_node) @NAME'), id: "fixable-query" };
  const partial = await client.runQueriesOnFile([valid, bad], file, "typescript");
  assert.equal(partial.length, 1);
  assert.equal(partial.analysisIncomplete, true);
  assert.deepEqual(partial.unavailableQueries, [bad.id]);
  const repaired = await client.runQueriesOnFile([valid, { ...bad, query: '(class_declaration name: (type_identifier) @NAME)' }], file, "typescript");
  assert.equal(repaired.length, 2);
  assert.equal(repaired.analysisIncomplete, undefined, "fixed rule is not poisoned by an old failure latch");
});

test("all shipped structural query sets retain original findings across supported grammars", async t => {
  const fixtures = [
    ["javascript", ".js", "const fs=require('fs'); function f(x){try {if(x==1) return eval(x); return fs.readFileSync(x)}catch(e){throw e}}"],
    ["typescript", ".ts", content],
    ["tsx", ".tsx", "export function Example(x: number){if(x == 1) return <div>{x}</div>; return null}"],
    ["python", ".py", "import os\ndef example(x):\n    try:\n        if x: return eval(x)\n        return os.system(x)\n    except Exception:\n        pass\n"],
    ["go", ".go", "package main\nimport \"fmt\"\nfunc example(x int) int { if x == 1 {fmt.Println(x)}; return x }"],
    ["rust", ".rs", "fn example(x: usize) -> usize { if x > 1 {return x;} let a = Some(x); a.unwrap() }"],
    ["php", ".php", "<?php function example($x){if($x == 1){eval($x);} echo $_GET['x']; return $x;}"],
    ["ruby", ".rb", "def example(x)\n  if x == 1\n    eval(x)\n  end\n  x\nend\n"],
    ["c", ".c", "#include <string.h>\nint example(char *x) {char b[10]; strcpy(b,x); return 1;}"],
    ["cpp", ".cpp", "#include <cstdlib>\nint example(int x) { if(x==1) return x; int *p=new int(x); return *p;}"],
    ["csharp", ".cs", "class Example { int Method(int x) { if(x==1) return x; return 0; } }"],
    ["css", ".css", ".example { color: red !important; display: block; }"],
  ];
  const { dir } = await fixture(t, "");
  const map = await queryLoader.loadQueries(dir);
  const payloads = [];
  for (const [languageId, extension, source] of fixtures) {
    const filePath = path.join(dir, languageId + extension); await writeFile(filePath, source, "utf8");
    payloads.push(payload("queries", { queryDefs: queriesForLanguage(map, languageId), filePath, languageId, contentOverride: source, options: { maxResults: 10 } }));
  }
  const expected = baseline(payloads);
  const client = new TreeSitterClient();
  let ruleCount = 0, findings = 0;
  for (const [index, item] of payloads.entries()) {
    const args = item.args;
    const actual = await client.runQueriesOnFile(args.queryDefs, args.filePath, args.languageId, args.options, args.contentOverride);
    assert.deepEqual(actual, expected[index], args.languageId);
    ruleCount += args.queryDefs.length; findings += actual.length;
  }
  assert.ok(ruleCount > 100); assert.ok(findings > 0);
  t.diagnostic(`${ruleCount} structural rule/grammar combinations compared; ${findings} positive findings`);
});

test("a blocked real TreeSitterClient does not block parent timers or Stop", async t => {
  const { file } = await fixture(t, content);
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const host = createAnalysisHost({ workerUrl: new URL("./fixtures/tree-fault-worker.mjs", import.meta.url), onStarted: () => started() });
  t.after(() => host.cancel());
  const job = assert.rejects(host.analyze(payload("queries", { queryDefs: [{ ...definition('(identifier) @NAME'), id: "inject-block" }], filePath: file, languageId: "typescript", contentOverride: content, options: {} })), { name: "AbortError" });
  await entered;
  await new Promise(resolve => setTimeout(resolve, 500));
  const before = Date.now(); await host.cancel(); await job;
  assert.ok(Date.now() - before < 1500);
});

test("a real WASM-abort path retires its heap and the next request works", async t => {
  const { file } = await fixture(t, content);
  const pids = [];
  const host = createAnalysisHost({ workerUrl: new URL("./fixtures/tree-fault-worker.mjs", import.meta.url), onStarted: (_, pid) => pids.push(pid) });
  t.after(() => host.cancel());
  const args = { queryDefs: [{ ...definition('(identifier) @NAME'), id: "inject-abort" }], filePath: file, languageId: "typescript", contentOverride: content, options: {} };
  const failed = await host.analyze(payload("queries", args));
  assert.match(failed.error, /Aborted/); assert.equal(failed.retire, true);
  const recovered = await host.analyze(payload("queries", { ...args, queryDefs: [definition('(function_declaration name: (identifier) @NAME)')] }));
  assert.equal(recovered.error, undefined); assert.equal(recovered.value.length, 1);
  assert.notEqual(pids[0], pids[1]);
});
