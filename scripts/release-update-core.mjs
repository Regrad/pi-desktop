import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const FAST_RELEASE_MANIFEST = ".pi-desktop-fast-update.json";
export const FAST_RELEASE_FORMAT = 2;

const ROOT_FILES = [
  "index.html",
  "vite.config.ts",
  "tsconfig.json",
  "tsconfig.electron.json",
  "package.json",
  "package-lock.json",
  "README.md",
  "CONNECT_CODEX.md",
];
const SOURCE_DIRECTORIES = ["src", "shared", "electron", "resources", "client-agent"];
const BRIDGE_SCRIPTS = new Set([
  "scripts/update-portable-fast.mjs",
  "scripts/release-update-core.mjs",
  "scripts/portable-layout.mjs",
  "scripts/package-portable.mjs",
  "scripts/apply-rpc-bridge.mjs",
  "scripts/llama-stats-patch.mjs",
  "scripts/mcp-config-patch.mjs",
  "scripts/service-context-patch.mjs",
  "scripts/tool-result-images-patch.mjs",
  "scripts/tool-routing-patch.mjs",
]);
const BRIDGE_RESOURCE_PREFIXES = [
  "resources/pi-rpc-bridge/",
  "resources/pi-mcp/",
  "resources/tool-routing/",
  "resources/pi-lens/",
];

function normalized(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function ignored(relativePath) {
  const value = normalized(relativePath);
  return value.startsWith("client-agent/bin/") ||
    value.startsWith("client-agent/obj/") ||
    value === "resources/client-agent/Pi Desktop Agent.exe";
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

async function hashFile(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

async function collectDirectory(projectRoot, relativeDirectory, files) {
  const absolute = path.join(projectRoot, relativeDirectory);
  if (!(await exists(absolute))) return;
  const entries = await readdir(absolute, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const relative = normalized(path.join(relativeDirectory, entry.name));
    if (ignored(relative)) continue;
    if (entry.isDirectory()) await collectDirectory(projectRoot, relative, files);
    else if (entry.isFile()) files[relative] = await hashFile(path.join(projectRoot, relative));
  }
}

export async function collectReleaseInputs(projectRoot) {
  const files = {};
  for (const name of ROOT_FILES) {
    const absolute = path.join(projectRoot, name);
    if (await exists(absolute)) files[normalized(name)] = await hashFile(absolute);
  }
  for (const directory of SOURCE_DIRECTORIES) await collectDirectory(projectRoot, directory, files);
  for (const name of BRIDGE_SCRIPTS) {
    const absolute = path.join(projectRoot, name);
    if (await exists(absolute)) files[name] = await hashFile(absolute);
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

export function changedReleaseInputs(previous = {}, current = {}) {
  const names = new Set([...Object.keys(previous), ...Object.keys(current)]);
  return [...names].filter((name) => previous[name] !== current[name]).sort();
}

export function classifyReleaseChanges(changedPaths) {
  const result = {
    renderer: false,
    electron: false,
    resources: [],
    activeAddon: [],
    clientAgent: false,
    bridge: false,
    packageMetadata: false,
    rootFiles: [],
    fullRequired: false,
  };
  for (const name of changedPaths) {
    if (typeof name !== "string" || path.isAbsolute(name) || /[\\:]/.test(name)
      || name.split("/").some(part => !part || part === "." || part === "..")) {
      throw new Error(`Invalid release input path: ${name}`);
    }
    if (name === "package-lock.json") result.fullRequired = true;
    else if (name === "package.json") result.packageMetadata = true;
    else if (name === "index.html" || name === "vite.config.ts" || name === "tsconfig.json" || name.startsWith("src/")) result.renderer = true;
    else if (name === "tsconfig.electron.json" || name.startsWith("electron/")) result.electron = true;
    else if (name.startsWith("shared/")) {
      result.renderer = true;
      result.electron = true;
    } else if (name.startsWith("client-agent/")) result.clientAgent = true;
    else if (name.startsWith("resources/")) {
      result.resources.push(name);
      if (name.startsWith("resources/pi-comfyui/")) {
        result.activeAddon.push(name);
        result.electron = true;
      }
      if (BRIDGE_RESOURCE_PREFIXES.some((prefix) => name.startsWith(prefix))) result.bridge = true;
    } else if (BRIDGE_SCRIPTS.has(name)) result.bridge = true;
    else if (name === "README.md" || name === "CONNECT_CODEX.md") result.rootFiles.push(name);
  }
  return result;
}

export async function packagingFingerprint(projectRoot) {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const material = {
    dependencies: packageJson.dependencies ?? {},
    optionalDependencies: packageJson.optionalDependencies ?? {},
    electron: packageJson.devDependencies?.electron ?? null,
    build: packageJson.build ?? {},
  };
  return createHash("sha256").update(JSON.stringify(material)).digest("hex");
}

export async function createFastReleaseManifest(projectRoot) {
  return {
    format: FAST_RELEASE_FORMAT,
    updatedAt: new Date().toISOString(),
    packagingFingerprint: await packagingFingerprint(projectRoot),
    files: await collectReleaseInputs(projectRoot),
  };
}

export async function assertReleaseInputsUnchanged(projectRoot, snapshot) {
  const current = await createFastReleaseManifest(projectRoot);
  const changed = changedReleaseInputs(snapshot.files, current.files);
  if (changed.length || snapshot.packagingFingerprint !== current.packagingFingerprint) {
    throw new Error(`Sources changed during the build; release was not updated. Run the update again. Changed inputs: ${changed.join(", ") || "package metadata"}`);
  }
}

export async function writeFastReleaseManifest(projectRoot, portableRoot, snapshot) {
  if (!snapshot?.files || snapshot.format !== FAST_RELEASE_FORMAT) throw new Error("A captured build-input snapshot is required to write the release manifest.");
  const manifest = snapshot;
  const target = path.join(portableRoot, FAST_RELEASE_MANIFEST);
  const temporary = `${target}.tmp-${process.pid}`;
  const old = `${target}.old-${process.pid}`;
  await mkdir(portableRoot, { recursive: true });
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const hadTarget = await exists(target);
  if (hadTarget) await rename(target, old);
  try {
    try {
      await rename(temporary, target);
    } catch (error) {
      if (hadTarget) {
        try {
          await rename(old, target);
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `Manifest activation and rollback failed. Original manifest preserved at: ${old}`);
        }
      }
      throw error;
    }
    if (hadTarget) await rm(old, { force: true });
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
  return manifest;
}
