import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = path.join(projectRoot, "release");
const targetDir = path.join(releaseRoot, "win-unpacked");
const nextDir = path.join(releaseRoot, ".win-unpacked-new");
const previousDir = path.join(releaseRoot, ".win-unpacked-old");
const builderCli = path.join(projectRoot, "node_modules", "electron-builder", "out", "cli", "cli.js");
const stagingRoot = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-package-"));
const builderOutput = path.join(stagingRoot, "output");

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

async function assertDesktopIsClosed() {
  if (process.platform !== "win32") return;
  let output = "";
  await new Promise((resolve, reject) => {
    const child = spawn("tasklist.exe", ["/FI", "IMAGENAME eq Pi Desktop.exe", "/FO", "CSV", "/NH"], {
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`tasklist failed (${code})`)));
  });
  if (/"Pi Desktop\.exe"/i.test(output)) {
    throw new Error("Close Pi Desktop before replacing the portable build.");
  }
}

let targetMoved = false;
try {
  await assertDesktopIsClosed();
  await run(process.execPath, [builderCli, "--win", "dir", `--config.directories.output=${builderOutput}`]);

  const builtDir = path.join(builderOutput, "win-unpacked");
  if (!(await exists(path.join(builtDir, "Pi Desktop.exe")))) {
    throw new Error("electron-builder did not create win-unpacked/Pi Desktop.exe");
  }

  await mkdir(releaseRoot, { recursive: true });
  await rm(nextDir, { recursive: true, force: true });
  await rm(previousDir, { recursive: true, force: true });
  await cp(builtDir, nextDir, { recursive: true });

  const portableData = path.join(targetDir, "data");
  if (await exists(portableData)) {
    await cp(portableData, path.join(nextDir, "data"), { recursive: true });
  }

  if (await exists(targetDir)) {
    await rename(targetDir, previousDir);
    targetMoved = true;
  }
  await rename(nextDir, targetDir);
  targetMoved = false;
  await rm(previousDir, { recursive: true, force: true });
  process.stdout.write(`Portable build updated: ${targetDir}\n`);
} catch (error) {
  if (targetMoved && !(await exists(targetDir)) && await exists(previousDir)) {
    await rename(previousDir, targetDir);
  }
  throw error;
} finally {
  await rm(nextDir, { recursive: true, force: true });
  await rm(previousDir, { recursive: true, force: true });
  await rm(stagingRoot, { recursive: true, force: true });
}
