import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { FAST_RELEASE_MANIFEST } from "./release-update-core.mjs";

const exec = promisify(execFile);
const prefix = "resources/pi-comfyui/";
export const activeComfyAddon = "data/agent/extensions/pi-comfyui";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function fileHash(filename) {
  try { return hash(await readFile(filename)); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}
async function exists(filename) {
  try { await stat(filename); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

// Version 1 recorded source hashes even when the active addon was not deployed.
// Only exact historical stock files are eligible for this one-time repair.
async function historicalHashes(projectRoot, filename) {
  try {
    const { stdout } = await exec("git", ["log", "-32", "--format=%H", "--", filename], { cwd: projectRoot, timeout: 10000, windowsHide: true });
    const hashes = new Set();
    for (const revision of stdout.trim().split(/\s+/).filter(value => /^[a-f0-9]{40}$/.test(value))) {
      try {
        const result = await exec("git", ["show", `${revision}:${filename}`], { cwd: projectRoot, timeout: 10000, windowsHide: true, encoding: "buffer", maxBuffer: 8 * 1024 * 1024 });
        hashes.add(hash(result.stdout));
      } catch { /* A deletion has no file at that revision. */ }
    }
    return hashes;
  } catch { return new Set(); }
}

export async function planComfyAddonUpdate(projectRoot, portableRoot, snapshot, options = {}) {
  let previous;
  try { previous = JSON.parse(await readFile(path.join(portableRoot, FAST_RELEASE_MANIFEST), "utf8")); }
  catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  const active = path.join(portableRoot, activeComfyAddon);
  const changes = [], preserved = [];
  // Keep deliberate removal and first-install seeding under the existing policy.
  if (!(await exists(active))) return { changes, preserved };
  const filenames = new Set([...Object.keys(previous?.files ?? {}), ...Object.keys(snapshot.files)].filter(name => name.startsWith(prefix)));
  for (const filename of filenames) {
    const relative = filename.slice(prefix.length);
    if (relative.split("/").some(part => !part || part === "." || part === "..") || path.isAbsolute(relative) || relative.includes("\\") || relative.includes(":")) {
      throw new Error(`Invalid addon manifest path: ${filename}`);
    }
    const target = path.join(active, relative);
    const currentHash = await fileHash(target);
    const desiredHash = snapshot.files[filename];
    if (currentHash === desiredHash) continue;
    if (currentHash === undefined) {
      // A missing formerly installed file is a user deletion, not an upgrade.
      if (previous?.files?.[filename] || await exists(path.join(portableRoot, "resources/app", filename))) preserved.push(relative);
      else changes.push({ relative, source: path.join(projectRoot, filename), previousHash: undefined, sourceHash: desiredHash });
      continue;
    }
    const templateHash = await fileHash(path.join(portableRoot, "resources/app", filename));
    let stock = currentHash === previous?.files?.[filename] || currentHash === templateHash;
    if (!stock && (!previous || previous.format === 1)) {
      stock = (await (options.historicalHashes ?? historicalHashes)(projectRoot, filename)).has(currentHash);
    }
    if (stock) changes.push({ relative, source: desiredHash === undefined ? undefined : path.join(projectRoot, filename), previousHash: currentHash, sourceHash: desiredHash });
    else preserved.push(relative);
  }
  return { changes, preserved };
}

export async function assertComfyAddonState(plan, portableRoot, installed = false) {
  for (const change of plan.changes) {
    const current = await fileHash(path.join(portableRoot, activeComfyAddon, change.relative));
    if (current !== (installed ? change.sourceHash : change.previousHash)) {
      throw new Error(`Active addon changed during the update: ${change.relative}. Run the update again.`);
    }
  }
}

export async function stageComfyAddonUpdate(transaction, plan, portableRoot) {
  for (const change of plan.changes) {
    const target = path.join(portableRoot, activeComfyAddon, change.relative);
    if (change.source) await transaction.replace(change.source, target);
    else await transaction.remove(target);
  }
}
