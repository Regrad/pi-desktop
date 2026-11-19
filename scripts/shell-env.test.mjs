import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patchShellEnvironment } from "../resources/pi-rpc-bridge/shell-env-patch.js";
import { patchShellTimeout } from "../resources/pi-rpc-bridge/shell-timeout-patch.js";

const bashFile = fileURLToPath(new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js", import.meta.url));
const original = await readFile(bashFile, "utf8");

test("the shell-env bridge marks both environment paths, is idempotent and keeps newlines", () => {
  const patched = patchShellEnvironment(original);
  assert.equal(patchShellEnvironment(patched), patched);
  assert.equal(patchShellEnvironment(original.replace(/\r?\n/g, "\r\n")), patched.replace(/\r?\n/g, "\r\n"));
  assert.throws(() => patchShellEnvironment("unknown"), /no longer matches pinned Pi/);
  assert.match(patched, /const env = \{ \.\.\.getShellEnv\(\) \};\n\s*\/\/ Pi Desktop[\s\S]{0,90}delete env\.ELECTRON_RUN_AS_NODE;/);
  assert.match(patched, /env: env \?\? \(\(\) => \{ const shellEnv = getShellEnv\(\); delete shellEnv\.ELECTRON_RUN_AS_NODE;/);
});

// Load the patched executor in memory the way packaging applies both bridges to the same file.
async function executor() {
  const require = createRequire(bashFile);
  let source = patchShellEnvironment(patchShellTimeout(original));
  source = source.replace(/from "([^"]+)"/g, (match, specifier) => isBuiltin(specifier) ? match :
    `from ${JSON.stringify(pathToFileURL(specifier.startsWith(".")
      ? path.resolve(path.dirname(bashFile), specifier) : require.resolve(specifier)).href)}`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

test("commands no longer inherit the application binary marker", async () => {
  const marker = "ELECTRON_RUN_AS_NODE", control = "PI_DESKTOP_ENV_BRIDGE_CONTROL";
  process.env[marker] = "1";
  process.env[control] = "kept";
  const { createShellToolDefinition } = await executor();
  const seen = [];
  const tool = createShellToolDefinition(process.cwd(), { name: "bash", label: "bash", shellName: "bash", tempFilePrefix: "pi-env-test" }, {
    operations: { async exec(_command, _cwd, options) { seen.push(options.env); return { exitCode: 0 }; } },
  });
  await tool.execute("test", { command: "pwd" }, undefined, undefined,
    { cwd: process.cwd(), sessionManager: { getSessionId: () => "env-test", getSessionFile: () => undefined } });
  assert.equal(marker in seen[0], false, "the marker never reaches the command environment");
  assert.equal(seen[0][control], "kept", "ordinary variables stay visible");
  delete process.env[control];
});

test("a real command runs without the marker", async () => {
  process.env.ELECTRON_RUN_AS_NODE = "1";
  const { createLocalBashOperations } = await executor();
  let output = "";
  const result = await createLocalBashOperations().exec(
    'node -e "process.stdout.write(String(process.env.ELECTRON_RUN_AS_NODE))"', process.cwd(),
    { onData: chunk => { output += chunk.toString(); } });
  assert.equal(result.exitCode, 0, output);
  assert.equal(output.trim(), "undefined", "the launched process has no marker");
});
