// Portable patch: pi-llama-cpp-stats 0.1.6 discards reader.cancel()'s promise.
// An already aborted HTTP stream rejects it, crashing Node on an unhandled rejection.
const original = "\t\tcancel(reason?: any) {\n\t\t\treader.cancel(reason);\n\t\t},";
const replacement = "\t\tcancel(reason?: any) {\n\t\t\treturn reader.cancel(reason);\n\t\t},";

export function patchLlamaStatsCancellation(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  if (normalized.includes(replacement)) return source;
  if (normalized.split(original).length !== 2) {
    throw new Error("llama.cpp statistics cancellation patch no longer matches; review the add-on.");
  }
  const patched = normalized.replace(original, replacement);
  return source.includes("\r\n") ? patched.replace(/\n/g, "\r\n") : patched;
}

// Portable patch: pi-llama-cpp-stats 0.1.6 restores the default working message
// only when prompt_progress reports exactly 100%. A server is free to stop the
// progress events as soon as generation starts, so a bar that stopped at 84%
// stayed on screen for the whole answer, and the stale state resurfaced on the
// next request that reused the KV cache and reported no progress at all.
// Prefilling now also ends on the first generated output of the own request.
const lines = (...items) => items.join("\n");

const prefillEdits = [
  {
    original: "function updateWorkingMessage(): void {",
    replacement: lines(
      "function resetPrefilling(): void {",
      "\thasReceivedPrefill = false;",
      "\tcurrentProgress = null;",
      "\tprevProcessed = 0;",
      "\tprevTimeMs = 0;",
      "\trateHistory.length = 0;",
      "}",
      "",
      "// Generated output means prompt processing is over, whatever the last",
      "// prompt_progress event happened to report.",
      "function hasGeneratedOutput(chunk: any): boolean {",
      "\tif (chunk?.usage) return true;",
      "\tif (!Array.isArray(chunk?.choices)) return false;",
      "\treturn chunk.choices.some((choice: any) => {",
      "\t\tif (choice?.finish_reason != null) return true;",
      "\t\tconst delta = choice?.delta;",
      "\t\treturn (typeof delta?.content === \"string\" && delta.content.length > 0)",
      "\t\t\t|| (typeof delta?.reasoning_content === \"string\" && delta.reasoning_content.length > 0)",
      "\t\t\t|| (Array.isArray(delta?.tool_calls) && delta.tool_calls.length > 0);",
      "\t});",
      "}",
      "",
      "function finishPrefilling(): void {",
      "\t// Without this guard every token would emit a redundant UI update.",
      "\tif (!hasReceivedPrefill && !currentProgress) return;",
      "\tresetPrefilling();",
      "\tif (uiRef && hasUIRef) uiRef.setWorkingMessage();",
      "}",
      "",
      "function updateWorkingMessage(): void {",
    ),
  },
  {
    original: lines(
      "\tif (currentProgress?.total && currentProgress.processed === currentProgress.total) {",
      "\t\tuiRef.setWorkingMessage();",
    ),
    replacement: lines(
      "\tif (currentProgress?.total && currentProgress.processed === currentProgress.total) {",
      "\t\tresetPrefilling();",
      "\t\tuiRef.setWorkingMessage();",
    ),
  },
  {
    original: lines(
      "function captureTimings(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {",
      "\tconst reader = body.getReader();",
    ),
    replacement: lines(
      "function captureTimings(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {",
      "\t// Progress of a previous request must never surface when this one needs no",
      "\t// prompt processing at all and therefore sends no prompt_progress event.",
      "\tresetPrefilling();",
      "\tconst reader = body.getReader();",
    ),
  },
  {
    original: "\t\t\t\t\tif (jsonStr === \"[DONE]\") continue;",
    replacement: lines(
      "\t\t\t\t\tif (jsonStr === \"[DONE]\") {",
      "\t\t\t\t\t\tfinishPrefilling();",
      "\t\t\t\t\t\tcontinue;",
      "\t\t\t\t\t}",
    ),
  },
  {
    original: lines("\t\t\t\t\t\tupdateWorkingMessage();", "\t\t\t\t\t} catch {"),
    replacement: lines(
      "\t\t\t\t\t\tif (hasGeneratedOutput(chunk)) finishPrefilling();",
      "\t\t\t\t\t\telse updateWorkingMessage();",
      "\t\t\t\t\t} catch {",
    ),
  },
];

export function patchLlamaStatsPrefillReset(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  let patched = normalized;
  for (const { original: from, replacement: to } of prefillEdits) {
    // Every edit is applied on its own, so a partially patched add-on heals and a
    // fully patched one is left byte-identical.
    if (patched.includes(to)) continue;
    if (patched.split(from).length !== 2) {
      throw new Error("llama.cpp statistics prefill reset patch no longer matches; review the add-on.");
    }
    patched = patched.replace(from, to);
  }
  if (patched === normalized) return source;
  return source.includes("\r\n") ? patched.replace(/\n/g, "\r\n") : patched;
}
