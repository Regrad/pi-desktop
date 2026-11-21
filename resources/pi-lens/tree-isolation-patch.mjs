const marker = "// Pi Desktop: supervised tree-sitter operations v1";
const treeIsolationFiles = [
  "dist/clients/tree-sitter-client.js", "dist/clients/deps/web-tree-sitter.js",
  "dist/clients/dispatch/runners/tree-sitter.js", "dist/clients/project-diagnostics/scanner.js",
  "dist/clients/dispatch/facts/import-facts.js", "dist/clients/dispatch/facts/function-facts.js",
  "dist/clients/dispatch/facts/try-catch-facts.js", "dist/clients/dispatch/facts/comment-facts.js",
  "dist/clients/read-expansion.js", "dist/clients/module-report.js",
  "dist/clients/review-graph/builder.js", "dist/clients/blocker-freshness.js",
  "dist/clients/complexity-client.js", "dist/clients/metrics/complexity-baseline.js",
  "dist/clients/runtime-tool-result.js", "dist/clients/dispatch/fact-runner.js",
];

function header() {
  return `${marker}
import { getAnalysisScope as desktopAnalysisScope, withAnalysisScope as desktopWithAnalysisScope } from "./desktop-analysis/analysis-context.mjs";
const desktopIsTreeWorker = () => globalThis[Symbol.for("pi.desktop.analysis.worker")] === true;
const desktopTreeStats = () => globalThis[Symbol.for("pi.desktop.tree.stats")] ?? { languages: [], runtime: {}, cache: {} };
async function desktopTreeCall(method, args, options = {}) {
    const epochKey = Symbol.for("pi.desktop.native.analysis.epoch");
    const scope = desktopAnalysisScope();
    const epoch = scope?.epoch ?? globalThis[epochKey] ?? 0;
    const deadlineAt = scope?.deadlineAt ?? Date.now() + Math.max(30_000, getRunnerTimeoutFloorMs());
    if ((globalThis[epochKey] ?? 0) !== epoch) throw new DOMException("Analysis cancelled", "AbortError");
    const { analyzeAst } = await import("./desktop-analysis/analysis-host.mjs");
    if ((globalThis[epochKey] ?? 0) !== epoch) throw new DOMException("Analysis cancelled", "AbortError");
    const result = await analyzeAst({ engine: "tree", method, args,
        context: { cwd: process.cwd(), trust: getProjectTrustState(),
            generation: getDegradationLedgerGeneration(),
            capacity: globalThis[Symbol.for("pi.desktop.tree.capacity")] ?? 50 }
    }, { ...scope, deadlineAt, ...options });
    if ((globalThis[epochKey] ?? 0) !== epoch) throw new DOMException("Analysis cancelled", "AbortError");
    if (result.stats) globalThis[Symbol.for("pi.desktop.tree.stats")] = result.stats;
    for (const observation of result.observations ?? []) {
        if (observation.type === "latency") logLatency(observation.record);
        else if (observation.type === "once") recordDegradationOnce(observation.record);
        else if (observation.type === "count") incrementDegradationCount(observation.record);
        else if (observation.type === "degradation") recordDegradation(observation.record);
        else if (observation.type === "tree") logTreeSitter(observation.record);
        else if (observation.type === "notify") notifyUserDegradation(observation.record.message, observation.record.level, observation.record.options);
    }
    if (result.error) throw new Error(result.error);
    return result.value;
}
async function desktopTreeFacts(method, args, store, ctx) {
    // Only the known file-local facts cross IPC. No session/UI/agent objects.
    const keys = ["file.content", "file.imports", "file.reexports", "file.importFactsCoverage", "file.functionSummaries", "file.functionFactsCoverage"];
    const input = keys.filter(key => store.hasFileFact(ctx.filePath, key)).map(key => [key, store.getFileFact(ctx.filePath, key)]);
    const expected = store.getFileFact(ctx.filePath, "file.content");
    const result = await desktopTreeCall(method, { ...args, input, ctx: { filePath: ctx.filePath, cwd: ctx.cwd, kind: ctx.kind } });
    if (store.getFileFact(ctx.filePath, "file.content") !== expected) throw new Error("Analysis source changed; stale facts discarded.");
    for (const [key, value] of result.writes) store.setFileFact(ctx.filePath, key, value);
    return result.value;
}
// End Pi Desktop tree-sitter bridge
`;
}

export function patchPiLensTreeIsolation(source) {
  if (source.includes(marker)) return source;
  const sections = source.replace(/\r\n/g, "\n").split(/(?=^\/\/ dist\/)/m);
  const seen = new Set();
  const changed = sections.map(section => {
    const name = section.match(/^\/\/ (dist\/[^\n]+)/)?.[1];
    if (!treeIsolationFiles.includes(name)) return section;
    if (name.endsWith("module-report.js") && !section.includes("async function extractFile(")) return section;
    if (name.endsWith("runtime-tool-result.js") && !section.includes("async function handleToolResult(")) return section;
    seen.add(name);
    return patchTreeConsumer(section, name);
  });
  if (seen.size !== treeIsolationFiles.length) throw new Error(`Pi Lens bundled tree consumers changed: ${[...seen]}`);
  return header() + changed.join("");
}

function patchTreeConsumer(source, file) {
  let result = source.replace(/\r\n/g, "\n");
  const applies = name => file.endsWith(name);
  function one(anchor, replacement) {
    if (result.split(anchor).length !== 2) throw new Error(`Pi Lens tree bridge anchor changed: ${file}: ${anchor.slice(0, 90)}`);
    result = result.replace(anchor, replacement);
  }
  function guard(anchor, statement) { one(anchor, `${anchor}\n        if (!desktopIsTreeWorker()) { ${statement} }`); }

  if (applies("tree-sitter-client.js")) {
    guard("async init() {", 'return desktopTreeCall("init", {});');
    guard("async isLanguageSupported(languageId) {", 'return desktopTreeCall("supports", { languageId });');
    guard("async structuralSearch(pattern, languageId, rootDir, options = {}) {", 'return desktopTreeCall("search", { pattern, languageId, rootDir, options });');
    guard("async runQueryOnFile(queryDef, filePath, languageId, options = {}, contentOverride) {", 'return desktopTreeCall("query", { queryDef, filePath, languageId, options, contentOverride });');
    guard("async runQueriesOnFile(queryDefs, filePath, languageId, options = {}, contentOverride) {", 'return desktopTreeCall("queries", { queryDefs, filePath, languageId, options, contentOverride });');
    guard("async parseFileAndUse(filePath, languageId, contentOverride, consume, caller) {", 'throw new Error("Unregistered tree-sitter consumer; analysis incomplete (no in-process fallback).");');
    guard("getRuntimeStats() {", 'return desktopTreeStats().runtime;');
    guard("getParseCacheStats() {", 'return desktopTreeStats().cache;');
    guard("ensureTreeCacheCapacity(fileCount) {", 'globalThis[Symbol.for("pi.desktop.tree.capacity")] = Math.max(globalThis[Symbol.for("pi.desktop.tree.capacity")] ?? 50, fileCount); return;');
    guard("getLanguage(languageId) {", 'throw new Error("WASM language objects belong to the analysis executor.");');
    // Real matching exceptions must not be transformed into a clean empty list.
    one('this.dbg(`Batched query matching error: ${err}`);', 'this.dbg(`Batched query matching error: ${err}`); throw err;');
    one('this.dbg(`Query matching error: ${err}`);', 'this.dbg(`Query matching error: ${err}`); throw err;');
    one('this.dbg(`Parse error: ${err}`);', 'this.dbg(`Parse error: ${err}`); throw err;');
    // Remote operations record their own measured deltas; parent scans keep
    // the existing measurement callback, with the real executor counters.
    guard("async withParseCacheMeasurement(work, onComplete) {", `
        const executorPid = desktopTreeStats().executorPid;
        const before = { ...desktopTreeStats().cache };
        try { return await work(); } finally {
            const after = { ...desktopTreeStats().cache };
            const stats = { ...after };
            for (const key of [...Object.keys(createTreeCacheCounters()), ...Object.keys(createParserCounters())]) stats[key] = Math.max(0, (after[key] ?? 0) - (desktopTreeStats().executorPid === executorPid ? (before[key] ?? 0) : 0));
            stats.misses = stats.lookups - stats.hits;
            try { onComplete(stats); } catch { /* observational only */ }
        }`);
  }
  if (applies("deps/web-tree-sitter.js")) {
    guard("function loadWebTreeSitter() {", 'throw new Error("WASM may only load in the supervised analysis executor.");');
  }
  if (applies("dispatch/runners/tree-sitter.js")) {
    one("!client.getLanguage(languageId)", '(desktopIsTreeWorker() ? !client.getLanguage(languageId) : !desktopTreeStats().languages.includes(languageId))');
    one("if (!isTreeSitterWasmAborted() && ", "if (!queryRunFailed && !isTreeSitterWasmAborted() && ");
    guard("async run(ctx) {", 'if (!desktopAnalysisScope()) return desktopWithAnalysisScope({ deadlineAt: ctx.desktopAnalysisDeadlineAt }, () => this.run(ctx));');
    one("queryRunFailed = true;", 'if (err?.name === "AbortError") throw err;\n          queryRunFailed = true;');
    one('if (classifyTreeSitterWasmError(err) === "abort") {', 'if (desktopIsTreeWorker() && classifyTreeSitterWasmError(err) === "abort") {');
    one("...queryRunFailed && { inconclusive: true }", "...queryRunFailed && { inconclusive: true, analysisIncomplete: true }");
    const foundLoop = result.match(/for \(const \{ queryDef: query, match(?:: match\d+)? \} of found\) \{/)?.[0];
    if (!foundLoop) throw new Error("Pi Lens structural results loop changed");
    one(foundLoop, 'if (found.analysisIncomplete) queryRunFailed = true;\n            ' + foundLoop);
  }
  for (const [name, provider] of [["import-facts.js", "importFactProvider"], ["function-facts.js", "functionFactProvider"], ["comment-facts.js", "commentFactProvider"], ["try-catch-facts.js", "tryCatchFactProvider"]]) {
    if (!applies("dispatch/facts/" + name)) continue;
    const start = result.indexOf(`${provider} = {`);
    if (start < 0) throw new Error(`Pi Lens provider changed: ${provider}`);
    const index = result.indexOf("async run(ctx, store) {", start);
    if (index < 0) throw new Error(`Pi Lens provider run changed: ${provider}`);
    const end = index + "async run(ctx, store) {".length;
    result = result.slice(0, end) + `\n        if (!desktopIsTreeWorker()) return desktopTreeFacts("facts", { provider: ${JSON.stringify(provider)} }, store, ctx);` + result.slice(end);
  }
  if (applies("module-report.js")) {
    guard("async function extractFile(absPath, languageId, content) {", 'return desktopTreeCall("module", { absPath, languageId, content });');
  }
  if (applies("read-expansion.js")) {
    guard("async function tryExpandRead(filePath, requestedOffset, requestedLimit, totalLines, tsClient) {", 'return desktopTreeCall("read", { filePath, requestedOffset, requestedLimit, totalLines });');
  }
  if (applies("complexity-client.js")) {
    guard("async analyzeFile(filePath) {", 'return desktopTreeCall("complexity", { filePath });');
  }
  if (applies("review-graph/builder.js")) {
    guard("async function extractTreeSitterSymbols(filePath, languageId, contentOverride) {", 'return desktopTreeCall("symbols", { filePath, languageId, content: contentOverride });');
    guard("async function captureReviewGraphStructuralIr(filePath, cwd, content, borrowed) {", 'return desktopTreeFacts("graph", { filePath, cwd, content }, borrowed, { filePath, cwd });');
  }
  if (applies("blocker-freshness.js")) {
    guard("async function extractForwardImports(cwd, filePath) {", 'return desktopTreeCall("forwardImports", { cwd, filePath });');
  }
  if (applies("complexity-baseline.js")) {
    guard("async function measureFunctionTable(filePath, content, treeKey = filePath) {", 'return desktopTreeCall("complexityBaseline", { filePath, content, treeKey });');
  }
  if (applies("runtime-tool-result.js")) {
    guard("async function handleToolResult(deps) {", 'if (!desktopAnalysisScope()) return desktopWithAnalysisScope({}, () => handleToolResult(deps));');
  }
  if (applies("dispatch/fact-runner.js")) {
    guard("async function runProviders(ctx) {", 'if (!desktopAnalysisScope()) return desktopWithAnalysisScope({}, () => runProviders(ctx));');
  }
  if (applies("project-diagnostics/scanner.js")) {
    guard("async function scanProjectDiagnostics(options) {", 'if (!desktopAnalysisScope()) return desktopWithAnalysisScope({ signal: options.signal }, () => scanProjectDiagnostics(options));');
    one("const treeSitter = [];", "const treeSitter = []; let desktopStructuralIncomplete = false;");
    const foundLoop = result.match(/for \(const \{ queryDef: query, match(?:: match\d+)? \} of found\) \{/)?.[0];
    if (!foundLoop) throw new Error("Pi Lens scan results loop changed");
    one(foundLoop, "if (found.analysisIncomplete) desktopStructuralIncomplete = true;\n            " + foundLoop);
    for (const [startAnchor, endAnchor] of [["const scanTreeSitterFile", "const scanFactRulesFile"], ["const scanFactRulesFile", "const scanAstGrepFile"]]) {
      const start = result.indexOf(startAnchor), end = result.indexOf(endAnchor, start);
      if (start < 0 || end < 0) throw new Error("Pi Lens scan stages changed");
      const section = result.slice(start, end);
      if (section.split("catch {").length !== 2) throw new Error("Pi Lens scan error handling changed");
      result = result.slice(0, start) + section.replace("catch {", "catch { desktopStructuralIncomplete = true;") + result.slice(end);
    }
    result = result.replace(/wasmAborted, astGrepFailed,/g, "wasmAborted, astGrepFailed, desktopStructuralIncomplete,");
    one("nativeAnalysisIncomplete = scanned.astGrepFailed;", "nativeAnalysisIncomplete = scanned.astGrepFailed || scanned.desktopStructuralIncomplete;");
  }
  return result;
}
