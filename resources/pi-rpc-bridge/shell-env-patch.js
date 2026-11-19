// Pi Desktop starts its engine through the application binary, so the engine process carries
// ELECTRON_RUN_AS_NODE. Commands inherit it, and any Electron app they launch silently becomes a
// bare Node process instead of an application. Both shell paths take the environment from
// getShellEnv(): the tool path builds it per command, the operations path uses it directly.
// Applied to pinned Pi during packaging.
const commandEnv = "    const env = { ...getShellEnv() };\n";
const commandMarker = "\n    // Pi Desktop: the application binary marker must not reach user commands.\n    delete env.ELECTRON_RUN_AS_NODE;";
const operationsEnv = "                env: env ?? getShellEnv(),";
const operationsMarker = "env: env ?? (() => { const shellEnv = getShellEnv(); delete shellEnv.ELECTRON_RUN_AS_NODE; return shellEnv; })(),";

export function patchShellEnvironment(source) {
  const crlf = source.includes("\r\n");
  const normalized = crlf ? source.replace(/\r\n/g, "\n") : source;
  if (normalized.includes(commandMarker) || normalized.includes(operationsMarker)) return source;
  for (const anchor of [commandEnv, operationsEnv]) {
    if (normalized.split(anchor).length !== 2) {
      throw new Error("Pi Desktop shell-env bridge no longer matches pinned Pi; review before applying.");
    }
  }
  const patched = normalized.replace(commandEnv, `${commandEnv}${commandMarker}\n`).replace(operationsEnv, operationsMarker);
  return crlf ? patched.replace(/\n/g, "\r\n") : patched;
}
