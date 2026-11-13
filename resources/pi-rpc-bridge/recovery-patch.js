// Extend Pi's native recovery classification; do not replay prompts or tools.
function insertOnce(source, anchor, addition) {
  if (source.includes(addition)) return source;
  if (source.split(anchor).length !== 2)
    throw new Error("Pi Desktop recovery bridge no longer matches pinned Pi; review before applying.");
  return source.replace(anchor, anchor + addition);
}

export function patchContextRecovery(source) {
  return insertOnce(source, "const OVERFLOW_PATTERNS = [", "\n    /context size has been exceeded/i, // llama.cpp shared KV exhaustion during decode");
}

export function patchTransportRecovery(source) {
  return insertOnce(source, "const RETRYABLE_PROVIDER_ERROR_PATTERN = buildProviderErrorPattern([",
    '\n    "\\\\b(?:ECONNRESET|ECONNREFUSED|EPIPE|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)\\\\b",');
}
