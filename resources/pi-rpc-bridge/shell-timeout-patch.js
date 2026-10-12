// Applied to pinned Pi during packaging and core updates, not to user commands.
export function patchShellTimeout(source) {
  const crlf = source.includes("\r\n");
  let result = source.replace(/\r\n/g, "\n");
  const replace = (before, after) => {
    if (result.includes(after)) return;
    if (result.split(before).length !== 2)
      throw new Error("Pi Desktop shell-timeout bridge no longer matches pinned Pi; review before applying.");
    result = result.replace(before, after);
  };
  replace("{ onData, signal, timeout, env }) => {", "{ onData, signal, timeout = 300, env }) => {");
  replace("async execute(_toolCallId, { command, timeout }, signal, onUpdate, ctx) {",
    "async execute(_toolCallId, { command, timeout = 300 }, signal, onUpdate, ctx) {");
  replace("Timeout in seconds (optional, no default timeout)", "Timeout in seconds (optional, defaults to 300)");
  replace("Optionally provide a timeout in seconds.", "Timeout defaults to 300 seconds; an explicit timeout overrides it.");
  replace("`Command timed out after ${timeoutSecs} seconds`",
    "`Command timed out after ${timeoutSecs} seconds. Execution may be partial.`");
  return crlf ? result.replace(/\n/g, "\r\n") : result;
}
