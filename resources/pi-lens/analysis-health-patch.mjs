const marker = "// Pi Desktop: incomplete analysis is not successful coverage";

export function patchPiLensAnalysisHealth(source) {
  if (source.includes(marker)) return source;
  function replace(anchor, text) {
    if (source.split(anchor).length !== 2) throw new Error("Pi Lens analysis health anchor changed: " + anchor);
    source = source.replace(anchor, text);
  }
  const notice = "function buildCoverageNotice(ctx, runnerLatencies, dedupe2) {";
  replace(notice, `${notice}
    const incomplete = runnerLatencies.filter(r => ["timeout", "exception", "incomplete"].includes(r.failureKind));
    if (incomplete.length) {
      const message = "Analysis incomplete: " + incomplete.map(r => r.runnerId + " (" + r.failureKind + ")").join(", ") + ". Findings are partial; this is not a clean result.";
      return {
        notice: { id: "analysis-incomplete:" + ctx.filePath, message, filePath: ctx.filePath, severity: "warning", semantic: "warning", tool: "pi-lens" },
        verdict: unchecked(message)
      };
    }`);
  const result = "...result,\n      diagnostics,\n      semantic: result.semantic ?? defaultSemantic";
  replace(result, result.replace("...result,", '...result,\n      ...(result.analysisIncomplete ? { inconclusive: true, failureKind: "incomplete", failureMessage: "Some structural rules could not be evaluated" } : {}),'));
  const failure = 'status: "failed",\n      diagnostics: [],\n      semantic: defaultSemantic,\n      failureKind: message.includes("timed out") ? "timeout" : "exception",';
  replace(failure, failure.replace('status: "failed"', 'status: error?.name === "AbortError" ? "skipped" : "failed"')
    .replace('failureKind: message.includes', 'failureKind: error?.name === "AbortError" ? "cancelled" : message.includes'));
  return marker + "\n" + source;
}
