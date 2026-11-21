const marker = "// Pi Desktop: entry points for the supervised analysis worker";

export function patchPiLensAnalysisBindings(source) {
  if (source.includes(marker)) return source;
  // Pi Lens 4.5 publishes a single bundled extension. Initialize its lazy
  // modules before taking references and reuse the same algorithms in the worker.
  const modules = {
    init_ast_grep_napi2: ["loadSg", "getLang", "evaluateAstGrepRules", "astGrepNapiRunner", "desktopEvaluateAstGrepRules"],
    init_tree_sitter_client: ["TreeSitterClient"],
    init_tree_sitter_shared: ["getSharedTreeSitterClient", "isTreeSitterWasmAborted", "resetTreeSitterClientLoadState"],
    init_project_trust: ["setProjectTrustState"],
    init_degradation_ledger: ["resetDegradationLedger"],
    init_module_report: ["extractFile"],
    init_complexity_client: ["ComplexityClient"],
    init_complexity_baseline: ["measureFunctionTable"],
    init_blocker_freshness: ["extractForwardImports"],
    init_builder: ["captureReviewGraphStructuralIr", "extractTreeSitterSymbols"],
    init_import_facts: ["importFactProvider"],
    init_function_facts: ["functionFactProvider"],
    init_comment_facts: ["commentFactProvider"],
    init_try_catch_facts: ["tryCatchFactProvider"],
    init_web_tree_sitter: ["loadWebTreeSitter"],
    init_tree_sitter_query_loader: ["queryLoader", "queriesForLanguage"],
    init_tree_sitter: ["treeSitterRunner"],
    init_fact_store: ["FactStore"],
    init_dispatcher: ["createDispatchContext", "dispatchForFile", "RunnerRegistry", "clearCoverageNoticeState"],
    init_scanner: ["scanProjectDiagnostics"],
    init_read_guard_tool_lines: ["getTouchedLinesForGuard"],
  };
  for (const initializer of Object.keys(modules)) {
    if (!source.includes(`var ${initializer} = __esm(`)) throw new Error(`Pi Lens module initializer changed: ${initializer}`);
  }
  const sinks = {
    logLatency: "latency",
    logTreeSitter: "tree",
    recordDegradation: "degradation",
    recordDegradationOnce: "once",
    incrementDegradationCount: "count",
    notifyUserDegradation: "notify",
  };
  for (const [name, event] of Object.entries(sinks)) {
    const pattern = new RegExp(`function ${name}\\(([^)]*)\\) \\{`, "g");
    const [match, extra] = source.matchAll(pattern);
    if (!match || extra) throw new Error(`Pi Lens analysis observation sink changed: ${name}`);
    const record = event === "notify" ? "{ message, level, options }" : match[1];
    source = source.replace(match[0], `${match[0]}
  if (globalThis[Symbol.for("pi.desktop.analysis.worker")]) {
    globalThis[Symbol.for("pi.desktop.analysis.observe")](${JSON.stringify(event)}, ${record});
    return true;
  }`);
  }

  return source + `\n${marker}
export function getDesktopAnalysisBindings() {
  ${Object.keys(modules).map(name => name + "();").join("\n  ")}
  return { ${Object.values(modules).flat().join(", ")}, tryExpandRead };
}
`;
}
