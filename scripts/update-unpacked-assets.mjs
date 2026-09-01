import { spawn } from "node:child_process";
import { cp, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = path.join(projectRoot, "release", "win-unpacked", "resources", "app");
const assetNames = ["dist", "dist-electron"];
const bridgeSource = path.join(projectRoot, "resources", "pi-rpc-bridge", "rpc-mode.js");
const bridgeTargets = [
  path.join(appRoot, "resources", "pi-rpc-bridge", "rpc-mode.js"),
  path.join(appRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "modes", "rpc", "rpc-mode.js"),
];

async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
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
    throw new Error("Close Pi Desktop before updating the portable application.");
  }
}

async function replaceDirectory(source, target) {
  const resolvedSource = path.resolve(source);
  const resolvedTarget = path.resolve(target);
  const targetParent = path.dirname(resolvedTarget);
  const targetName = path.basename(resolvedTarget);
  const next = path.join(targetParent, `.${targetName}-new`);
  const previous = path.join(targetParent, `.${targetName}-old`);

  if (!resolvedTarget.startsWith(`${appRoot}${path.sep}`)) {
    throw new Error(`Refusing to update directory outside packaged app: ${resolvedTarget}`);
  }
  if (!(await isDirectory(resolvedSource))) {
    throw new Error(`Source directory is missing: ${resolvedSource}`);
  }

  await mkdir(targetParent, { recursive: true });
  await rm(next, { recursive: true, force: true });
  await rm(previous, { recursive: true, force: true });
  await cp(resolvedSource, next, { recursive: true });

  let movedPrevious = false;
  try {
    if (await isDirectory(resolvedTarget)) {
      await rename(resolvedTarget, previous);
      movedPrevious = true;
    }
    await rename(next, resolvedTarget);
    movedPrevious = false;
    await rm(previous, { recursive: true, force: true });
  } catch (error) {
    if (movedPrevious && !(await isDirectory(resolvedTarget)) && await isDirectory(previous)) {
      await rename(previous, resolvedTarget);
    }
    throw error;
  } finally {
    await rm(next, { recursive: true, force: true });
    await rm(previous, { recursive: true, force: true });
  }
}

await assertDesktopIsClosed();

for (const name of assetNames) {
  const source = path.resolve(projectRoot, name);
  const target = path.resolve(appRoot, name);
  await replaceDirectory(source, target);
}

await replaceDirectory(
  path.join(projectRoot, "resources", "pi-loop-police"),
  path.join(appRoot, "resources", "pi-loop-police"),
);

for (const target of bridgeTargets) {
  const resolvedTarget = path.resolve(target);
  if (!resolvedTarget.startsWith(`${appRoot}${path.sep}`)) {
    throw new Error(`Refusing to update bridge outside packaged app: ${resolvedTarget}`);
  }
  await mkdir(path.dirname(resolvedTarget), { recursive: true });
  await cp(bridgeSource, resolvedTarget, { force: true });
}

const retiredLoopPolice = path.resolve(appRoot, "node_modules", "pi-loop-police");
if (!retiredLoopPolice.startsWith(`${path.resolve(appRoot, "node_modules")}${path.sep}`)) {
  throw new Error(`Refusing to remove package outside bundled node_modules: ${retiredLoopPolice}`);
}
await rm(retiredLoopPolice, { recursive: true, force: true });

process.stdout.write(`Packaged application code updated: ${appRoot}\n`);
