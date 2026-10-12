import { registerHooks } from "node:module";
import { readFile } from "node:fs/promises";
import { captureObservation, takeObservations } from "./analysis-observations.mjs";

// Capture the original modules' terminal/log sinks, not their analysis logic.
// Trust and grammar policy run unchanged, with the host's current trust state.
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  const sinks = url.endsWith("/clients/latency-logger.js") ? [["logLatency(entry)", "latency", "entry"]]
    : url.endsWith("/clients/tree-sitter-logger.js") ? [["logTreeSitter(entry)", "tree", "entry"]]
    : url.endsWith("/clients/user-notify.js") ? [["notifyUserDegradation(message, level = \"warning\", options)", "notify", "{ message, level, options }"]]
    : url.endsWith("/clients/degradation-ledger.js") ? [["recordDegradation(record)", "degradation", "record"], ["recordDegradationOnce(record)", "once", "record"], ["incrementDegradationCount(record)", "count", "record"]] : [];
  if (!sinks.length) return result;
  let source = String(result.source);
  for (const [signature, type, record] of sinks) {
    const anchor = `export function ${signature} {`;
    if (source.split(anchor).length !== 2) throw new Error(`Analysis observation sink changed: ${signature}`);
    source = source.replace(anchor, `${anchor}\n globalThis[Symbol.for("pi.desktop.analysis.observe")](${JSON.stringify(type)}, ${record}); return true;`);
  }
  return { ...result, source };
} });
globalThis[Symbol.for("pi.desktop.analysis.observe")] = captureObservation;

let lastGeneration;
const extractors = new Map();
const providers = {
  importFactProvider: "import-facts.js", functionFactProvider: "function-facts.js",
  commentFactProvider: "comment-facts.js", tryCatchFactProvider: "try-catch-facts.js",
};

async function symbolExtractor(languageId, client) {
  if (extractors.has(languageId)) return extractors.get(languageId);
  const { TreeSitterSymbolExtractor } = await import("../clients/tree-sitter-symbol-extractor.js");
  const extractor = new TreeSitterSymbolExtractor(languageId, client);
  if (!(await extractor.init())) throw new Error(`Symbol extraction unavailable for ${languageId}; analysis incomplete.`);
  extractors.set(languageId, extractor);
  return extractor;
}

function fileStore(input = []) {
  const facts = new Map(input), writes = new Map();
  return {
    writes,
    getFileFact: (_file, key) => facts.get(key),
    hasFileFact: (_file, key) => facts.has(key),
    setFileFact: (_file, key, value) => { facts.set(key, value); writes.set(key, value); },
  };
}

export async function runTreeOperation(payload) {
  const { method, args, context } = payload;
  if (context.cwd !== process.cwd()) process.chdir(context.cwd);
  const trust = await import("../clients/project-trust.js");
  trust.setProjectTrustState(context.trust);
  const shared = await import("../clients/tree-sitter-shared.js");
  const ledger = await import("../clients/degradation-ledger.js");
  if (lastGeneration !== context.generation) {
    ledger.resetDegradationLedger();
    shared.resetTreeSitterClientLoadState();
    lastGeneration = context.generation;
  }
  const client = shared.getSharedTreeSitterClient();
  if (!client) throw new Error("Tree-sitter runtime aborted; analysis incomplete.");
  client.ensureTreeCacheCapacity(context.capacity);
  let value, failure;
  try {
    switch (method) {
      case "init": value = await client.init(); break;
      case "supports": value = await client.isLanguageSupported(args.languageId); break;
      case "query":
      case "queries":
      case "search": {
        if (!(await client.isLanguageSupported(args.languageId))) throw new Error(`Grammar unavailable: ${args.languageId}; analysis incomplete.`);
        if (method === "query") value = await client.runQueryOnFile(args.queryDef, args.filePath, args.languageId, args.options, args.contentOverride);
        if (method === "queries") value = await client.runQueriesOnFile(args.queryDefs, args.filePath, args.languageId, args.options, args.contentOverride);
        if (method === "search") value = await client.structuralSearch(args.pattern, args.languageId, args.rootDir, args.options);
        const definitions = method === "queries" ? args.queryDefs : method === "query" ? [args.queryDef] : [];
        const unavailable = [];
        const batch = method === "queries" ? await client.compileQueryBatch(definitions, args.languageId) : undefined;
        for (const query of definitions) {
          const compiled = batch ? batch.entries.some(entry => entry.queryDef.id === query.id && entry.queryDef.query === query.query)
            : await client.compileRawQuery(query.id, query.query, query.metavars, args.languageId, query.post_filter, query.post_filter_params);
          if (!compiled) unavailable.push(query.id);
        }
        if (method === "search" && !(await client.compileQuery(args.pattern, args.languageId))) unavailable.push("search-pattern");
        if (unavailable.length) { value.analysisIncomplete = true; value.unavailableQueries = unavailable; }
        break;
      }
      case "symbols": {
        if (args.content === null) { value = { parsed: false }; break; }
        const extractor = await symbolExtractor(args.languageId, client);
        const content = args.content ?? await readFile(args.filePath, "utf8");
        value = await client.withParsedTree(args.filePath, args.languageId, content, tree => extractor.extract(tree, args.filePath, content));
        break;
      }
      case "module": {
        const { desktopExtractModuleFile } = await import("../clients/module-report.js");
        value = await desktopExtractModuleFile(args.absPath, args.languageId, args.content);
        break;
      }
      case "read": {
        const { tryExpandRead } = await import("../clients/read-expansion.js");
        value = await tryExpandRead(args.filePath, args.requestedOffset, args.requestedLimit, args.totalLines, client);
        break;
      }
      case "complexity": {
        const { ComplexityClient } = await import("../clients/complexity-client.js");
        value = await new ComplexityClient().analyzeFile(args.filePath);
        break;
      }
      case "forwardImports": {
        const { extractForwardImportPaths } = await import("../clients/blocker-freshness.js");
        value = await extractForwardImportPaths(args.cwd, args.filePath);
        break;
      }
      case "facts": {
        const file = providers[args.provider];
        if (!file) throw new Error("Unknown analysis fact provider");
        const provider = (await import("../clients/dispatch/facts/" + file))[args.provider];
        const store = fileStore(args.input);
        await provider.run(args.ctx, store);
        value = { writes: [...store.writes] };
        break;
      }
      case "graph": {
        const { captureReviewGraphStructuralIr } = await import("../clients/review-graph/builder.js");
        const store = fileStore(args.input);
        const result = await captureReviewGraphStructuralIr(args.filePath, args.cwd, args.content, store);
        value = { writes: [...store.writes], value: result };
        break;
      }
      default: throw new Error(`Unknown analysis operation: ${method}`);
    }
    if (shared.isTreeSitterWasmAborted()) throw new Error("Tree-sitter runtime aborted; analysis incomplete.");
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  const stats = { executorPid: process.pid, languages: [...client.languages.keys()], runtime: client.getRuntimeStats(), cache: client.getParseCacheStats() };
  const observations = takeObservations();
  if (failure || shared.isTreeSitterWasmAborted()) {
    // The heap might be corrupt. Parent will retire this worker after receiving
    // the explicit failure, and the next request gets a clean WASM runtime.
    return { error: failure, stats, observations, retire: shared.isTreeSitterWasmAborted() };
  }
  return { value, stats, observations };
}
