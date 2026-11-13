const importLine = 'import { assertDesktopRequest, desktopRequestDiagnostics } from "./desktop-request-diagnostics.js";';
export function patchRequestDiagnostics(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  const edits = [
    ['    const normalizedContext = resolveTranscript(context, getCompat(model).supportsMidConvoSystemMessages);\n    (async () => {',
      '    const normalizedContext = resolveTranscript(context, getCompat(model).supportsMidConvoSystemMessages);\n    const desktopDiagnostic = desktopRequestDiagnostics(model, options);\n    desktopDiagnostic.run(async () => {'],
    ['            const requestOptions = {', '            assertDesktopRequest(params);\n            const requestOptions = {'],
    ['            stream.push({ type: "done", reason: output.stopReason, message: output });',
      '            await desktopDiagnostic.finish(output);\n            stream.push({ type: "done", reason: output.stopReason, message: output });'],
    ['            stream.push({ type: "error", reason: output.stopReason, error: output });',
      '            await desktopDiagnostic.finish(output);\n            stream.push({ type: "error", reason: output.stopReason, error: output });'],
    ['    })();\n    return stream;', '    }).catch(error => {\n        stream.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "error", errorMessage: `Pi Desktop request diagnostics: ${error.message}`, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });\n        stream.end();\n    });\n    return stream;'],
  ];
  if (normalized.includes(importLine)) {
    if (!edits.every(([, after]) => normalized.includes(after)))
      throw new Error("Pi request diagnostics patch is incomplete; review the provider before applying.");
    return source;
  }
  let result = normalized;
  for (const [before, after] of edits) {
    if (result.split(before).length !== 2) throw new Error("Pi request diagnostics patch no longer matches. Review the provider before applying.");
    result = result.replace(before, after);
  }
  result = importLine + "\n" + result;
  return source.includes("\r\n") ? result.replace(/\n/g, "\r\n") : result;
}
