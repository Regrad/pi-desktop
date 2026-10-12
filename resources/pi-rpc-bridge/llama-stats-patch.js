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
