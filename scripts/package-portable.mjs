import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, open, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ensurePiLensGrammars } from "../resources/pi-lens/grammars.mjs";
import { activatePortableBuild } from "./portable-swap.mjs";
import { writeFastReleaseManifest } from "./release-update-core.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const releaseRoot = path.join(projectRoot, "release");
// Optional alternative target (e.g. "release/Pi Desktop New") for test builds
// that must not touch the running installation: PI_PORTABLE_TARGET=... npm run pack
const canonicalTarget = path.join(releaseRoot, "Pi Desktop");
const targetDir = process.env.PI_PORTABLE_TARGET
  ? path.resolve(projectRoot, process.env.PI_PORTABLE_TARGET)
  : canonicalTarget;
const relativeTarget = path.relative(releaseRoot, targetDir);
if (!relativeTarget || relativeTarget.startsWith(`..${path.sep}`) || relativeTarget === ".." || path.isAbsolute(relativeTarget)) {
  throw new Error("Portable target must be a subdirectory of the release folder.");
}
// Independent attempts cannot delete each other's staging or recovery folders.
const swapId = randomUUID();
const nextDir = path.join(releaseRoot, `.pi-desktop-new-${swapId}`);
const previousDir = path.join(releaseRoot, `.pi-desktop-old-${swapId}`);
const lockPath = path.join(releaseRoot, ".pi-desktop-package.lock");
let packageLock;
const builderCli = path.join(
  projectRoot,
  "node_modules",
  "electron-builder",
  "out",
  "cli",
  "cli.js",
);
const stagingRoot = await mkdtemp(
  path.join(os.tmpdir(), "pi-desktop-package-"),
);
const builderOutput = path.join(stagingRoot, "output");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Windows transient locks (Defender, search indexer, file watchers of other
// running copies) show up as EPERM/EBUSY for a few seconds at a time. Retry
// with backoff instead of failing the swap on the first touch.
async function retry(label, fn, attempts = 10, delayMs = 1500) {
  for (let i = 1; ; i += 1) {
    try {
      return await fn();
    } catch (error) {
      const retriable = ["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"].includes(
        error?.code,
      );
      if (!retriable || i >= attempts) throw error;
      process.stdout.write(
        `${label}: ${error.code}, retry ${i}/${attempts - 1}...\n`,
      );
      await sleep(delayMs * i);
    }
  }
}

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
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal ?? code})`));
    });
  });
}

async function runPs(script) {
  let output = "";
  await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], {
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`process query failed (${code})`)),
    );
  });
  return output;
}

const LIST_DESKTOP_PS =
  "Get-CimInstance Win32_Process -Filter \"Name='Pi Desktop.exe'\" | Select-Object -ExpandProperty ProcessId";
const ANCESTORS_PS =
  '$id = $PID; while ($id) { Write-Output $id; $q = Get-CimInstance Win32_Process -Filter "ProcessId=$id" -ErrorAction SilentlyContinue; if (-not $q) { break }; $id = $q.ParentProcessId }';

const parsePids = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isFinite(pid));

// Close every running Pi Desktop instance instead of failing the swap. The
// current process tree is skipped so a build launched from a terminal inside
// the app does not kill the console that runs it.
// Only instances running FROM the folder being replaced can lock it. Copies
// elsewhere (other folders, test builds - e.g. Pi Desktop2) must never be
// touched: killing them can close an unrelated app window, and they cannot
// hold the target folder hostage. Current process tree is skipped too.
async function listDesktopProcesses() {
  const script =
    'Get-CimInstance Win32_Process -Filter "Name=\'Pi Desktop.exe\'" | ForEach-Object { "$($_.ProcessId)|$($_.ExecutablePath)" }';
  const output = await runPs(script).catch(() => "");
  return output
    .split(/\r?\n/)
    .map((line) => {
      const sep = line.indexOf("|");
      if (sep <= 0) return null;
      const pid = Number(line.slice(0, sep));
      const exe = line.slice(sep + 1).trim();
      return Number.isFinite(pid) ? { pid, exe } : null;
    })
    .filter((item) => item !== null);
}

async function closeDesktopInstances() {
  if (process.platform !== "win32") return;
  const [ancestorOutput, procs] = await Promise.all([
    runPs(ANCESTORS_PS).catch(() => ""),
    listDesktopProcesses(),
  ]);
  const ancestors = new Set(parsePids(ancestorOutput));
  const targetPrefix = targetDir.toLocaleLowerCase() + path.sep;
  const pids = procs
    .filter(
      (proc) =>
        proc.exe &&
        proc.exe.toLocaleLowerCase().startsWith(targetPrefix) &&
        !ancestors.has(proc.pid) &&
        proc.pid !== process.pid,
    )
    .map((proc) => proc.pid);
  if (pids.length === 0) return;
  process.stdout.write(
    `Closing ${pids.length} Pi Desktop process(es) running from the portable folder...\n`,
  );
  for (const pid of pids) {
    await new Promise((resolve) => {
      const child = spawn("taskkill.exe", ["/F", "/PID", String(pid)], {
        windowsHide: true,
      });
      child.once("error", () => resolve());
      child.once("exit", () => resolve());
    });
  }
  for (let i = 0; i < 20; i += 1) {
    const remaining = (await listDesktopProcesses()).filter(
      (proc) =>
        proc.exe &&
        proc.exe.toLocaleLowerCase().startsWith(targetPrefix) &&
        !ancestors.has(proc.pid),
    );
    if (remaining.length === 0) return;
    await sleep(1000);
  }
  throw new Error(
    "Processes from the portable folder refused to close and still lock it.",
  );
}

async function renameWithRecovery(from, to, label) {
  try {
    return await retry(label, () => rename(from, to), 4, 1000);
  } catch (error) {
    if (!["EPERM", "EBUSY"].includes(error?.code)) throw error;
    await closeDesktopInstances();
    return retry(`${label} after closing`, () => rename(from, to), 10, 1500);
  }
}

try {
  await mkdir(releaseRoot, { recursive: true });
  try { packageLock = await open(lockPath, "wx"); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another package operation owns ${lockPath}. If it crashed, verify that no build is running before removing this lock.`);
    throw error;
  }
  await packageLock.writeFile(JSON.stringify({ pid: process.pid, target: targetDir, startedAt: new Date().toISOString() }));
  const grammars = await ensurePiLensGrammars(path.join(projectRoot, "node_modules", "pi-lens"));
  process.stdout.write(`Pi Lens: ${grammars.count} grammars verified before packaging.\n`);
  // The portable distribution includes the standalone client helper automatically.
  // No runtime is required on client PCs; publishing runs only as part of an explicit pack.
  const helperOutput = path.join(stagingRoot, "client-agent");
  await run("dotnet", ["publish", path.join(projectRoot, "client-agent", "PiDesktopAgent.csproj"), "-c", "Release", "-r", "win-x64", "-o", helperOutput]);
  await mkdir(path.join(projectRoot, "resources", "client-agent"), { recursive: true });
  await cp(path.join(helperOutput, "Pi Desktop Agent.exe"), path.join(projectRoot, "resources", "client-agent", "Pi Desktop Agent.exe"));
  await closeDesktopInstances();
  await run(process.execPath, [
    builderCli,
    "--win",
    "dir",
    `--config.directories.output=${builderOutput}`,
  ]);
  const builtDir = path.join(builderOutput, "win-unpacked");
  if (!(await exists(path.join(builtDir, "Pi Desktop.exe")))) {
    throw new Error(
      "electron-builder did not create win-unpacked/Pi Desktop.exe",
    );
  }

  await mkdir(releaseRoot, { recursive: true });
  await retry("clean next", () =>
    rm(nextDir, { recursive: true, force: true }),
  );
  await retry("copy new build", () =>
    cp(builtDir, nextDir, { recursive: true }),
  );

  const portableData = path.join(targetDir, "data");
  let dataSource = (await exists(portableData)) ? portableData : null;
  if (!dataSource && targetDir !== canonicalTarget) {
    // Brand-new test copy: seed it with the canonical installation's data so
    // it opens with the same chats and settings.
    const seed = path.join(canonicalTarget, "data");
    if (await exists(seed)) dataSource = seed;
  }
  if (dataSource) {
    await retry("carry portable data", () =>
      cp(dataSource, path.join(nextDir, "data"), { recursive: true }),
    );
  }

  await writeFastReleaseManifest(projectRoot, nextDir);

  await activatePortableBuild({ target: targetDir, next: nextDir, previous: previousDir }, { exists, rename: renameWithRecovery });
  await retry("remove old build", () =>
    rm(previousDir, { recursive: true, force: true }),
  );
  process.stdout.write(`Full portable build updated: ${targetDir}\n`);
} catch (error) {
  if (["EPERM", "EBUSY"].includes(error?.code)) {
    process.stderr.write(
      "The portable build folder stayed locked. If this build was started from " +
        "a terminal inside Pi Desktop, close the app first and run build.bat " +
        "from Explorer - a build cannot kill the instance that launched it.\n",
    );
  }
  throw error;
} finally {
  await retry("finally clean next", () =>
    rm(nextDir, { recursive: true, force: true }),
  ).catch(() => {});
  // previousDir may be the only surviving copy if rollback failed.
  await retry("finally clean staging", () =>
    rm(stagingRoot, { recursive: true, force: true }),
  ).catch(() => {});
  if (packageLock) {
    await packageLock.close();
    await rm(lockPath, { force: true });
  }
}
