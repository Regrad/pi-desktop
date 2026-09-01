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

for (const name of assetNames) {
  const source = path.resolve(projectRoot, name);
  const target = path.resolve(appRoot, name);
  const next = path.resolve(appRoot, `.${name}-new`);
  const previous = path.resolve(appRoot, `.${name}-old`);

  if (path.dirname(target) !== appRoot || path.dirname(next) !== appRoot || path.dirname(previous) !== appRoot) {
    throw new Error(`Refusing to update path outside packaged app: ${target}`);
  }
  if (!(await isDirectory(source))) {
    throw new Error(`Fresh build output is missing: ${source}`);
  }

  await rm(next, { recursive: true, force: true });
  await rm(previous, { recursive: true, force: true });
  await cp(source, next, { recursive: true });

  let movedPrevious = false;
  try {
    if (await isDirectory(target)) {
      await rename(target, previous);
      movedPrevious = true;
    }
    await rename(next, target);
    movedPrevious = false;
    await rm(previous, { recursive: true, force: true });
  } catch (error) {
    if (movedPrevious && !(await isDirectory(target)) && await isDirectory(previous)) {
      await rename(previous, target);
    }
    throw error;
  } finally {
    await rm(next, { recursive: true, force: true });
    await rm(previous, { recursive: true, force: true });
  }
}

for (const target of bridgeTargets) {
  const resolvedTarget = path.resolve(target);
  if (!resolvedTarget.startsWith(`${appRoot}${path.sep}`)) {
    throw new Error(`Refusing to update bridge outside packaged app: ${resolvedTarget}`);
  }
  await mkdir(path.dirname(resolvedTarget), { recursive: true });
  await cp(bridgeSource, resolvedTarget, { force: true });
}

process.stdout.write(`Packaged application code updated: ${appRoot}\n`);
