import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyCoreRequestCompatibility, applyAddonRequestCompatibility } from "../resources/pi-rpc-bridge/compatibility.js";
import { patchDesktopContinuation } from "../resources/pi-rpc-bridge/continuation-patch.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const core = path.join(root, "node_modules/@earendil-works/pi-coding-agent");
const provider = path.dirname(findPackageJSON("@earendil-works/pi-ai", pathToFileURL(path.join(core, "package.json")).href));

test("continuation patch rejects unknown Pi source and preserves newline style", async () => {
  const source = await readFile(path.join(core, "dist/core/agent-session.js"), "utf8");
  const patched = patchDesktopContinuation(source);
  assert.equal(patchDesktopContinuation(patched), patched);
  assert.equal(patchDesktopContinuation(source.replace(/\r?\n/g, "\r\n")), patched.replace(/\r?\n/g, "\r\n"));
  assert.throws(() => patchDesktopContinuation("unknown"), /no longer matches pinned Pi/);
});

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-compatibility-"));
  t.after(async () => {
    assert.ok(directory.startsWith(path.join(tmpdir(), "pi-compatibility-")));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}
async function put(root, name, content) {
  const file = path.join(root, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
}

test("embedded build installs request, summary and media bridges idempotently", async t => {
  const directory = await fixture(t);
  const target = path.join(directory, "node_modules/@earendil-works/pi-coding-agent");
  const targetProvider = path.join(target, "node_modules/@earendil-works/pi-ai");
  await put(target, "package.json", JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.5.2", type: "module" }));
  await put(targetProvider, "package.json", JSON.stringify({ name: "@earendil-works/pi-ai", version: "1.5.2", type: "module", main: "index.js" }));
  await put(targetProvider, "index.js", "export {};\n");
  for (const file of ["dist/core/messages.js", "dist/core/compaction/compaction.js", "dist/extensions/codemode/tool.js", "dist/extensions/codemode/execute.js", "dist/core/agent-session.js", "dist/core/tools/bash.js"])
    await put(target, file, await readFile(path.join(core, file), "utf8"));
  await put(targetProvider, "dist/api/openai-completions.js", await readFile(path.join(provider, "dist/api/openai-completions.js"), "utf8"));
  for (const file of ["dist/utils/overflow.js", "dist/utils/retry.js"])
    await put(targetProvider, file, await readFile(path.join(provider, file), "utf8"));
  await applyCoreRequestCompatibility(target);
  const paths = [path.join(target, "dist/core/messages.js"), path.join(target, "dist/core/compaction/compaction.js"),
    path.join(target, "dist/core/desktop-service-context.js"), path.join(targetProvider, "dist/api/openai-completions.js"), path.join(target, "dist/extensions/codemode/tool.js"), path.join(target, "dist/core/agent-session.js"), path.join(target, "dist/core/tools/bash.js")];
  const before = await Promise.all(paths.map(file => readFile(file, "utf8")));
  await applyCoreRequestCompatibility(target);
  assert.deepEqual(await Promise.all(paths.map(file => readFile(file, "utf8"))), before);
  assert.match(before[0], /projectDesktopServiceContext/);
  assert.match(before[1], /serializeDesktopSummary/);
  assert.match(before[3], /toolResultMsg\.content = \[/);
  assert.match(before[4], /text\(await searchTools/);
  assert.match(before[5], /messages = await this\._prepareRun\(trigger\)/);
  assert.match(before[5], /messageType: "custom", message: appMessage/);
  assert.match(before[6], /timeout = defaultShellTimeout\(command\)/);
  assert.match(before[6], /Execution may be partial/);
  assert.match(await readFile(path.join(targetProvider, "dist/utils/overflow.js"), "utf8"), /context size has been exceeded/);
  assert.match(await readFile(path.join(targetProvider, "dist/utils/retry.js"), "utf8"), /UND_ERR_SOCKET/);
  await put(target, "package.json", JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "9.0.0" }));
  await assert.rejects(applyCoreRequestCompatibility(target), /requires.*1\.5\.2/);
});

test("addon updates retain MCP configuration and statistics cancellation fixes", async t => {
  const directory = await fixture(t);
  for (const [name, version, files] of [["pi-mcp-adapter", "5.1.0", ["index.ts", "proxy-modes.ts", "init.ts", "server-manager.ts"]],
    ["pi-llama-cpp-stats", "0.1.6", ["index.ts"]]]) {
    const target = path.join(directory, name);
    await put(target, "package.json", JSON.stringify({ name, version }));
    for (const file of files) await put(target, file, await readFile(path.join(root, "node_modules", name, file), "utf8"));
    await applyAddonRequestCompatibility(name, target);
    const before = await Promise.all(files.map(file => readFile(path.join(target, file), "utf8")));
    await applyAddonRequestCompatibility(name, target);
    assert.deepEqual(await Promise.all(files.map(file => readFile(path.join(target, file), "utf8"))), before);
    if (name === "pi-mcp-adapter") await access(path.join(target, "desktop-config.js"));
    else assert.match(before[0], /return reader\.cancel\(reason\)/);
  }
});

test("updater reapplies request compatibility on installation and rollback", () => {
  const source = readFileSyncCompat();
  assert.equal((source.match(/await this\.applyAddonCompatibility\(definition\.packageName\)/g) ?? []).length, 2);
  assert.doesNotMatch(source, /applyRpcBridge|applyCoreRequestCompatibility/);
  assert.match(source, /if \(id === 'pi-core'\) throw/);
});
function readFileSyncCompat() {
  // Loaded asynchronously below so the test does not need an additional fs API.
  return updaterSource;
}
const updaterSource = await readFile(path.join(root, "electron/update-manager.ts"), "utf8");
