import { captureObservation, takeObservations } from "./analysis-observations.mjs";

// The published extension bundle supplies the same analyzers to this process.
globalThis[Symbol.for("pi.desktop.analysis.observe")] = captureObservation;
let bindings;
export async function getAnalysisBindings() {
  bindings ??= import("../index.js").then(module => module.getDesktopAnalysisBindings());
  return bindings;
}

let lastGeneration;
const providers = new Set(["importFactProvider", "functionFactProvider", "commentFactProvider", "tryCatchFactProvider"]);

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
  const api = await getAnalysisBindings();
  api.setProjectTrustState(context.trust);
  if (lastGeneration !== context.generation) {
    api.resetDegradationLedger();
    api.resetTreeSitterClientLoadState();
    lastGeneration = context.generation;
  }
  const client = api.getSharedTreeSitterClient();
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
        value = await api.extractTreeSitterSymbols(args.filePath, args.languageId, args.content);
        break;
      }
      case "module": {
        value = await api.extractFile(args.absPath, args.languageId, args.content);
        break;
      }
      case "read": {
        value = await api.tryExpandRead(args.filePath, args.requestedOffset, args.requestedLimit, args.totalLines, client);
        break;
      }
      case "complexity": {
        value = await new api.ComplexityClient().analyzeFile(args.filePath);
        break;
      }
      case "complexityBaseline": {
        value = await api.measureFunctionTable(args.filePath, args.content, args.treeKey);
        break;
      }
      case "forwardImports": {
        value = await api.extractForwardImports(args.cwd, args.filePath);
        break;
      }
      case "facts": {
        if (!providers.has(args.provider)) throw new Error("Unknown analysis fact provider");
        const provider = api[args.provider];
        const store = fileStore(args.input);
        await provider.run(args.ctx, store);
        value = { writes: [...store.writes] };
        break;
      }
      case "graph": {
        const store = fileStore(args.input);
        const result = await api.captureReviewGraphStructuralIr(args.filePath, args.cwd, args.content, store);
        value = { writes: [...store.writes], value: result };
        break;
      }
      default: throw new Error(`Unknown analysis operation: ${method}`);
    }
    if (api.isTreeSitterWasmAborted()) throw new Error("Tree-sitter runtime aborted; analysis incomplete.");
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  const stats = { executorPid: process.pid, languages: [...client.languages.keys()], runtime: client.getRuntimeStats(), cache: client.getParseCacheStats() };
  const observations = takeObservations();
  if (failure || api.isTreeSitterWasmAborted()) {
    // The heap might be corrupt. Parent will retire this worker after receiving
    // the explicit failure, and the next request gets a clean WASM runtime.
    return { error: failure, stats, observations, retire: api.isTreeSitterWasmAborted() };
  }
  return { value, stats, observations };
}
