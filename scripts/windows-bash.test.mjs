import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { normalizeWindowsBash } from "../resources/pi-rpc-bridge/windows-bash.js";
import { patchWindowsBash } from "../resources/pi-rpc-bridge/windows-bash-patch.js";

const gitBash = path.join(process.env.ProgramFiles ?? "C:/Program Files", "Git", "bin", "bash.exe");
const shellModule = process.env.PI_DESKTOP_TEST_BASH_MODULE
  ? pathToFileURL(process.env.PI_DESKTOP_TEST_BASH_MODULE)
  : new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/bash.js", import.meta.url);

test("Windows Bash translates literal null-device redirects", async () => {
  for (const [command, expected] of [
    ["echo hidden >nul 2>NuL", "echo hidden >/dev/null 2>/dev/null"],
    ['echo hidden 2>>"NuL"', "echo hidden 2>>/dev/null"],
    ["echo hidden &>'NUL'", "echo hidden &>/dev/null"],
    ["echo hidden >$'nul'", "echo hidden >/dev/null"],
    ['echo 🦉; echo hidden >n"u"l', "echo 🦉; echo hidden >/dev/null"],
    ["echo >nu\\l", "echo >/dev/null"],
    ["echo >n\\\nul", "echo >/dev/null"],
    ["cat <NUL", "cat </dev/null"],
    ["echo >nul visible", "echo >/dev/null visible"],
    ['echo "$(echo hidden >nul)"', 'echo "$(echo hidden >/dev/null)"'],
  ]) {
    assert.equal(await normalizeWindowsBash(command, gitBash), expected, command);
  }
});

test("Windows Bash keeps other redirects and text intact", async () => {
  for (const command of [
    "echo visible >/dev/null",
    "echo visible >nul-output.txt",
    "echo >notes.txt nul",
    "echo 'text >nul' # another >nul",
    "cat <<'EOF'\n>nul\nEOF",
    'cmd.exe /c "echo hidden >nul"',
  ]) {
    assert.equal(await normalizeWindowsBash(command, gitBash), command);
  }
  assert.equal(await normalizeWindowsBash("echo hidden >nul", "C:/Windows/System32/cmd.exe"), "echo hidden >nul");
});

test("Windows Bash reports explicitly named output files using Windows device names", async () => {
  for (const command of ["echo >logs/nul.txt", "echo >./AUX", 'echo >"COM\u00b9.log"']) {
    await assert.rejects(normalizeWindowsBash(command, gitBash), /reserved Windows filename/);
  }
});

test("the compiled bridge is present and applying it again is harmless", async () => {
  const source = await readFile(shellModule, "utf8");
  assert.match(source, /await normalizeWindowsBash\(command, shellConfig\.shell\)/);
  assert.match(source, /Use \/dev\/null in Bash to discard output/);
  assert.equal(patchWindowsBash(source), source);
});

test("the built executor and Bash tool discard output on Git Bash without creating reserved files", {
  skip: process.platform !== "win32" || !existsSync(gitBash),
}, async t => {
  const tempRoot = await realpath(tmpdir());
  const cwd = await mkdtemp(path.join(tempRoot, "pi-windows-bash-"));
  t.after(async () => {
    const resolved = await realpath(cwd);
    assert.equal(path.dirname(resolved), tempRoot);
    assert.match(path.basename(resolved), /^pi-windows-bash-/);
    await rm(path.toNamespacedPath(resolved), { recursive: true, force: true });
  });

  const { createBashToolDefinition, createLocalBashOperations } = await import(shellModule.href);
  let output = "";
  const result = await createLocalBashOperations({ shellPath: gitBash }).exec(
    "printf hidden >nul; printf visible", cwd,
    { timeout: 5, onData: chunk => { output += chunk.toString(); } },
  );
  assert.equal(result.exitCode, 0, output);
  assert.equal(output, "visible");

  const tool = createBashToolDefinition(cwd, { shellPath: gitBash });
  const response = await tool.execute("test", {
    command: 'printf hidden >>"NuL"; printf visible >notes.txt',
  }, undefined, undefined, {
    cwd,
    sessionManager: { getSessionId: () => "windows-bash-test", getSessionFile: () => undefined },
  });
  assert.equal(response.isError, undefined);
  assert.deepEqual(await readdir(path.toNamespacedPath(cwd)), ["notes.txt"]);
  assert.equal(await readFile(path.join(cwd, "notes.txt"), "utf8"), "visible");
});
