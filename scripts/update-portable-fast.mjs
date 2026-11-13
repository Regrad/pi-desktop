import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  FAST_RELEASE_FORMAT,
  FAST_RELEASE_MANIFEST,
  changedReleaseInputs,
  classifyReleaseChanges,
  createFastReleaseManifest,
  assertReleaseInputsUnchanged,
  writeFastReleaseManifest,
} from "./release-update-core.mjs";
import { createReleaseTransaction } from "./release-transaction.mjs";
import { planComfyAddonUpdate, stageComfyAddonUpdate, assertComfyAddonState } from "./release-addon.mjs";
import { treeIsolationFiles } from "../resources/pi-lens/tree-isolation-patch.mjs";
import { portableBinaryDirectory, portableApplicationDirectory } from "./portable-layout.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = path.join(projectRoot, "release", "Pi Desktop");
const binaryDir = portableBinaryDirectory(targetDir);
const appDir = portableApplicationDirectory(targetDir);
const manifestPath = path.join(targetDir, FAST_RELEASE_MANIFEST);
const lockPath = path.join(projectRoot, "release", ".pi-desktop-package.lock");
const cacheDir = path.join(projectRoot, ".cache", "release-update");
await mkdir(path.join(projectRoot, "release"), { recursive: true });
const stagingRoot = await mkdtemp(path.join(projectRoot, "release", ".pi-desktop-build-"));
let packageLock;
let transaction;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: projectRoot, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal ?? code})`)));
  });
}

async function runPowerShell(script) {
  let output = "";
  await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`process query failed (${code})`)));
  });
  return output;
}

async function listTargetProcesses() {
  if (process.platform !== "win32") return [];
  const output = await runPowerShell('Get-CimInstance Win32_Process -Filter "Name=\'Pi Desktop.exe\'" | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }').catch(() => "");
  const prefix = targetDir.toLocaleLowerCase() + path.sep;
  return output.split(/\r?\n/).map((line) => {
    const separator = line.indexOf("|");
    if (separator < 1) return null;
    return { pid: Number(line.slice(0, separator)), exe: line.slice(separator + 1).trim() };
  }).filter((item) => item && Number.isFinite(item.pid) && item.exe.toLocaleLowerCase().startsWith(prefix));
}

function parsePids(text) {
  return new Set(text.split(/\r?\n/).map((line) => Number(line.trim())).filter(Number.isFinite));
}

async function ancestorPids() {
  if (process.platform !== "win32") return new Set();
  return parsePids(await runPowerShell('$id = $PID; while ($id) { Write-Output $id; $q = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue; if (-not $q) { break }; $id = $q.ParentProcessId }').catch(() => ""));
}

async function closeTargetProcesses() {
  const [processes, ancestors] = await Promise.all([listTargetProcesses(), ancestorPids()]);
  if (processes.length === 0) return;
  const parent = processes.find((item) => ancestors.has(item.pid));
  if (parent) {
    throw new Error("This update was started by the Pi Desktop instance being replaced. Close Pi Desktop and run build.bat from Explorer.");
  }
  process.stdout.write(`Closing ${processes.length} Pi Desktop process(es) before update...\n`);
  for (const item of processes) {
    await new Promise((resolve) => {
      const child = spawn("taskkill.exe", ["/F", "/PID", String(item.pid)], { windowsHide: true });
      child.once("error", resolve);
      child.once("exit", resolve);
    });
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await listTargetProcesses()).length === 0) return;
    await sleep(250);
  }
  throw new Error("Pi Desktop did not stop; release files remain locked.");
}

async function runFullBuild(reason) {
  process.stdout.write(`${reason} Running one full portable build.\n`);
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error("npm_execpath is unavailable; run npm run pack once.");
  // The full pack acquires the same lock before capturing inputs and compiling.
  await packageLock.close();
  await rm(lockPath);
  packageLock = undefined;
  await run(process.execPath, [npmCli, "run", "pack"]);
}

async function readManifest() {
  if (!(await exists(manifestPath))) return null;
  try {
    const value = JSON.parse(await readFile(manifestPath, "utf8"));
    return [1, FAST_RELEASE_FORMAT].includes(value?.format) && value.files ? value : null;
  } catch {
    return null;
  }
}

async function syncChangedFiles(paths, sourceRoot, targetRoot) {
  for (const relative of paths) {
    const source = path.join(sourceRoot, relative);
    const target = path.join(targetRoot, relative);
    if (await exists(source)) await transaction.replace(source, target);
    else await transaction.remove(target);
  }
}

async function prepareRenderer() {
  const output = path.join(stagingRoot, "dist");
  await mkdir(cacheDir, { recursive: true });
  await run(process.execPath, [path.join(projectRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json", "--noEmit", "--incremental", "--tsBuildInfoFile", path.join(cacheDir, "renderer.tsbuildinfo")]);
  await run(process.execPath, [path.join(projectRoot, "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", output, "--emptyOutDir"]);
  return output;
}

async function removeDeletedElectronOutputs(changedPaths, currentFiles) {
  for (const name of changedPaths) {
    if (currentFiles[name] || !(name.startsWith("electron/") || name.startsWith("shared/") || name.startsWith("resources/pi-comfyui/")) || !/\.(?:ts|cts)$/.test(name)) continue;
    const base = name.replace(/\.(?:ts|cts)$/, "");
    await rm(path.join(projectRoot, "dist-electron", `${base}.js`), { force: true });
    await rm(path.join(projectRoot, "dist-electron", `${base}.js.map`), { force: true });
  }
}

async function prepareElectron(changedPaths, currentFiles) {
  await mkdir(cacheDir, { recursive: true });
  await removeDeletedElectronOutputs(changedPaths, currentFiles);
  await run(process.execPath, [path.join(projectRoot, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.electron.json", "--incremental", "--tsBuildInfoFile", path.join(cacheDir, "electron.tsbuildinfo")]);
  const output = path.join(stagingRoot, "dist-electron");
  await cp(path.join(projectRoot, "dist-electron"), output, { recursive: true });
  return output;
}

async function findPackage(root, packageName) {
  const parts = packageName.split("/");
  const candidates = [
    path.join(root, "node_modules", ...parts),
    path.join(root, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", ...parts),
  ];
  for (const candidate of candidates) if (await exists(path.join(candidate, "package.json"))) return candidate;
  throw new Error(`Packaged dependency not found: ${packageName}`);
}

async function prepareBridgeOutputs() {
  await run(process.execPath, [path.join(projectRoot, "scripts", "apply-rpc-bridge.mjs")]);
}

async function syncBridgeOutputs() {
  const sourceCore = path.join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent");
  const targetCore = await findPackage(appDir, "@earendil-works/pi-coding-agent");
  const coreFiles = [
    "dist/modes/rpc/rpc-mode.js",
    "dist/core/desktop-service-context.js",
    "dist/core/messages.js",
    "dist/core/compaction/compaction.js",
    "dist/core/agent-session.js",
    "dist/core/tools/bash.js",
    "dist/extensions/codemode/tool.js",
    "dist/extensions/codemode/execute.js",
    "dist/core/extensions/loader.js",
    "dist/core/extensions/desktop-tool-routing.js",
    "dist/core/extensions/desktop-planning-permissions.js",
  ];
  await syncChangedFiles(coreFiles, sourceCore, targetCore);

  const sourceProvider = await findPackage(projectRoot, "@earendil-works/pi-ai");
  const targetProvider = await findPackage(appDir, "@earendil-works/pi-ai");
  await syncChangedFiles(["dist/api/openai-completions.js", "dist/utils/overflow.js", "dist/utils/retry.js"], sourceProvider, targetProvider);

  for (const [name, files] of [
    ["pi-mcp-adapter", ["index.ts", "proxy-modes.ts", "init.ts", "server-manager.ts", "desktop-config.js"]],
    ["pi-llama-cpp-stats", ["index.ts"]],
  ]) {
    await syncChangedFiles(files, await findPackage(projectRoot, name), await findPackage(appDir, name));
  }

  const lensFiles = [...new Set([
    "dist/index.js",
    "dist/clients/dispatch/runners/ast-grep-napi.js",
    "dist/clients/project-diagnostics/scanner.js",
    "dist/clients/dispatch/dispatcher.js",
    "dist/clients/tree-sitter-client.js",
    "dist/clients/read-guard-tool-lines.js",
    "dist/clients/lsp/launch.js",
    ...treeIsolationFiles,
    ...["analysis-host.mjs", "analysis-worker.mjs", "analysis-observations.mjs", "analysis-watchdog.mjs", "tree-operations.mjs", "analysis-context.mjs", "executable-path.mjs"].map((name) => `dist/desktop-analysis/${name}`),
  ])];
  await syncChangedFiles(lensFiles, await findPackage(projectRoot, "pi-lens"), await findPackage(appDir, "pi-lens"));
  process.stdout.write("Compatibility bridge files staged.\n");
}

async function prepareClientAgent() {
  const output = path.join(stagingRoot, "client-agent");
  await run("dotnet", ["publish", path.join(projectRoot, "client-agent", "PiDesktopAgent.csproj"), "-c", "Release", "-r", "win-x64", "-o", output]);
  return path.join(output, "Pi Desktop Agent.exe");
}

try {
  try { packageLock = await open(lockPath, "wx"); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another package operation owns ${lockPath}.`);
    throw error;
  }
  await packageLock.writeFile(JSON.stringify({ pid: process.pid, target: targetDir, startedAt: new Date().toISOString() }));
  const manifest = await readManifest();
  const snapshot = await createFastReleaseManifest(projectRoot);
  const currentFiles = snapshot.files;
  const currentFingerprint = snapshot.packagingFingerprint;
  if (!manifest || !(await exists(appDir))) {
    await runFullBuild("The release is not initialized for modular updates.");
    process.exitCode = 0;
  } else if (manifest.packagingFingerprint !== currentFingerprint) {
    await runFullBuild("Packaging or runtime dependencies changed.");
    process.exitCode = 0;
  } else {
    const changedPaths = changedReleaseInputs(manifest.files, currentFiles);
    const changes = classifyReleaseChanges(changedPaths);
    const addonPlan = await planComfyAddonUpdate(projectRoot, targetDir, snapshot);
    if (addonPlan.preserved.length) process.stdout.write(`Preserving local addon edits/deletions: ${addonPlan.preserved.join(", ")}\n`);
    if (changes.fullRequired) {
      await runFullBuild("package-lock.json changed.");
      process.exitCode = 0;
    } else if (changedPaths.length === 0 && addonPlan.changes.length === 0 && manifest.format === FAST_RELEASE_FORMAT) {
      process.stdout.write("Release is already current.\n");
    } else {
      // Finish compilation first so the running release is closed only for the
      // short replacement phase, and a failed build cannot damage it.
      const rendererOutput = changes.renderer ? await prepareRenderer() : null;
      const electronOutput = changes.electron ? await prepareElectron(changedPaths, currentFiles) : null;
      if (changes.bridge) await prepareBridgeOutputs();
      const clientAgentOutput = changes.clientAgent ? await prepareClientAgent() : null;
      await assertReleaseInputsUnchanged(projectRoot, snapshot);
      transaction = await createReleaseTransaction(path.join(projectRoot, "release"));

      if (rendererOutput) await transaction.replace(rendererOutput, path.join(appDir, "dist"));
      if (electronOutput) await transaction.replace(electronOutput, path.join(appDir, "dist-electron"));
      if (changes.resources.length) await syncChangedFiles(changes.resources, projectRoot, appDir);
      await stageComfyAddonUpdate(transaction, addonPlan, targetDir);
      if (changes.bridge) await syncBridgeOutputs();
      if (clientAgentOutput) {
        await transaction.replace(clientAgentOutput, path.join(appDir, "resources", "client-agent", "Pi Desktop Agent.exe"));
      }
      if (changes.packageMetadata) await transaction.replace(path.join(projectRoot, "package.json"), path.join(appDir, "package.json"));
      if (changes.rootFiles.length) await syncChangedFiles(changes.rootFiles, projectRoot, binaryDir);
      if (changes.resources.includes("resources/control-api/Invoke-PiDesktop.ps1")) await transaction.replace(path.join(projectRoot, "resources", "control-api", "Invoke-PiDesktop.ps1"), path.join(binaryDir, "Invoke-PiDesktop.ps1"));
      await writeFastReleaseManifest(projectRoot, stagingRoot, snapshot);
      await transaction.replace(path.join(stagingRoot, FAST_RELEASE_MANIFEST), manifestPath);
      await assertReleaseInputsUnchanged(projectRoot, snapshot);
      await closeTargetProcesses();
      await transaction.commit(async phase => {
        await assertReleaseInputsUnchanged(projectRoot, snapshot);
        await assertComfyAddonState(addonPlan, targetDir, phase === "after");
      });
      process.stdout.write(`Modular release update complete (${changedPaths.length} changed input file(s), ${addonPlan.changes.length} active addon file(s)).\n`);
    }
  }
} finally {
  await transaction?.dispose();
  if (packageLock) {
    await packageLock.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
  }
  await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
}
