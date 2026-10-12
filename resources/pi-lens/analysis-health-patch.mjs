const marker = "// Pi Desktop: incomplete analysis is not successful coverage";
export function patchPiLensAnalysisHealth(source) {
  if (source.includes(marker)) return source;
  let result = source.replace(/\r\n/g, "\n");
  const notice = "function buildCoverageNotice(ctx, runnerLatencies) {";
  if (result.split(notice).length !== 2) throw new Error("Pi Lens coverage notice changed");
  result = result.replace(notice, `${notice}
    const incomplete = runnerLatencies.filter(r => ["timeout", "exception", "incomplete"].includes(r.failureKind));
    if (incomplete.length) return {
        id: "analysis-incomplete:" + ctx.filePath,
        message: "Analysis incomplete: " + incomplete.map(r => r.runnerId + " (" + r.failureKind + ")").join(", ") + ". Findings are partial; this is not a clean result.",
        filePath: ctx.filePath, severity: "warning", semantic: "warning", tool: "pi-lens"
    };`);
  const status = /status: result\.status,\n(\s*)diagnosticCount: result\.diagnostics\.length,/g;
  if (![...result.matchAll(status)].length) throw new Error("Pi Lens runner telemetry changed");
  result = result.replace(status, 'status: result.status,\n$1...(result.failureKind ? { failureKind: result.failureKind, failureMessage: result.failureMessage } : {}),\n$1diagnosticCount: result.diagnostics.length,');
  const returnAnchor = "...result,\n            diagnostics,\n            semantic: result.semantic ?? defaultSemantic,";
  const bundledReturn = "...result,\n      diagnostics,\n      semantic: result.semantic ?? defaultSemantic";
  const anchor = result.includes(returnAnchor) ? returnAnchor : bundledReturn;
  if (result.split(anchor).length !== 2) throw new Error("Pi Lens runner result changed");
  result = result.replace(anchor, anchor.replace("...result,", '...result,\n            ...(result.analysisIncomplete ? { failureKind: "incomplete", failureMessage: "Some structural rules could not be evaluated" } : {}),'));
  // Intentional Stop is not a failed quality check. It must not be described
  // as an exception or become a warning that encourages another agent run.
  const failure = 'status: "failed",\n            diagnostics: [],\n            semantic: defaultSemantic,\n            failureKind: message.includes("timed out") ? "timeout" : "exception",';
  const bundledFailure = 'status: "failed",\n      diagnostics: [],\n      semantic: defaultSemantic,\n      failureKind: message.includes("timed out") ? "timeout" : "exception",';
  const failed = result.includes(failure) ? failure : bundledFailure;
  if (result.split(failed).length !== 2) throw new Error("Pi Lens runner failure taxonomy changed");
  result = result.replace(failed, failed.replace('status: "failed"', 'status: error?.name === "AbortError" ? "skipped" : "failed"').replace('failureKind: message.includes', 'failureKind: error?.name === "AbortError" ? "cancelled" : message.includes'));
  return marker + "\n" + result;
}
