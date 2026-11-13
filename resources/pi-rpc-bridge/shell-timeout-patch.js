import { defaultShellTimeout } from "./shell-timeout-policy.js";

// Applied to pinned Pi during packaging and core updates, not to user commands.
export function patchShellTimeout(source) {
  const crlf = source.includes("\r\n");
  let result = source.replace(/\r\n/g, "\n");
  const replace = (before, after) => {
    if (result.includes(after)) return;
    if (result.split(before).length !== 2)
      throw new Error("Pi Desktop shell-timeout bridge no longer matches pinned Pi; review before applying.");
    result = result.replace(before, () => after);
  };
  // Accept both pristine Pi and the previous fixed five-minute default.
  result = result.replace("{ onData, signal, timeout = 300, env }) => {", "{ onData, signal, timeout, env }) => {")
    .replace("async execute(_toolCallId, { command, timeout = 300 }, signal, onUpdate, ctx) {", "async execute(_toolCallId, { command, timeout }, signal, onUpdate, ctx) {")
    .replace("Timeout in seconds (optional, defaults to 300)", "Timeout in seconds (optional, no default timeout)")
    .replace("Timeout defaults to 300 seconds; an explicit timeout overrides it.", "Optionally provide a timeout in seconds.");
  // Upgrade the previously embedded command-dependent policy, too.
  result = result.replace(/\/\/ Pi Desktop command timeout policy\.\nfunction defaultShellTimeout\([^]*?\n}\n\n(?=const MAX_TIMEOUT_MS)/, "")
    .replace("Timeout in seconds (optional: 60 for simple inspections, 3600 for other commands)", "Timeout in seconds (optional, no default timeout)")
    .replace("Timeout defaults to 60 seconds for simple inspections and 3600 seconds for other commands, including builds and scripts. An explicit timeout overrides the default.", "Optionally provide a timeout in seconds.");
  const policy = `// Pi Desktop command timeout policy.\n${defaultShellTimeout.toString()}\n`;
  replace("const MAX_TIMEOUT_MS = 2_147_483_647;", `${policy}\nconst MAX_TIMEOUT_MS = 2_147_483_647;`);
  replace("{ onData, signal, timeout, env }) => {", "{ onData, signal, timeout = defaultShellTimeout(command), env }) => {");
  const spawnContext = "            const spawnContext = resolveSpawnContext(resolvedCommand, ctx?.cwd || cwd, spawnHook, exposeSessionEnvironment, ctx);";
  replace(spawnContext, `${spawnContext}\n            if (timeout === undefined) timeout = defaultShellTimeout(spawnContext.command);`);
  replace("Timeout in seconds (optional, no default timeout)", "Timeout in seconds (optional, defaults to 300)");
  replace("Optionally provide a timeout in seconds.", "Timeout defaults to 300 seconds; an explicit timeout overrides it.");
  // Send the resolved limit and start time; keep them in completed history, too.
  replace("            if (onUpdate) {\n                onUpdate({ content: [], details: undefined });\n            }",
    "            const shellTiming = { timeoutSeconds: timeout, startedAt: Date.now() };\n            if (onUpdate) {\n                onUpdate({ content: [], details: { shellTiming } });\n            }");
  replace("                    details: {\n                        truncation:", "                    details: {\n                        shellTiming,\n                        truncation:");
  replace("                let details;", "                let details = { shellTiming };");
  replace("details = { truncation, fullOutputPath: snapshot.fullOutputPath };", "details = { shellTiming, truncation, fullOutputPath: snapshot.fullOutputPath };");
  replace("`Command timed out after ${timeoutSecs} seconds`",
    "`Command timed out after ${timeoutSecs} seconds. Execution may be partial.`");
  return crlf ? result.replace(/\n/g, "\r\n") : result;
}
