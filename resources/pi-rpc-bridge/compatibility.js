import { copyFile, readFile, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patchServiceMessages, patchDesktopCompaction } from "./context-patch.js";
import { patchToolResultImages } from "./tool-result-images-patch.js";
import { patchLlamaStatsCancellation } from "./llama-stats-patch.js";
import { patchMcpIndex, patchMcpProxy } from "../pi-mcp/config-patch.js";
import { patchCodemodeDiscoveryDescription } from "../tool-routing/patch.js";
import { patchDesktopContinuation } from "./continuation-patch.js";
import { patchShellTimeout } from "./shell-timeout-patch.js";

const bridgeRoot = path.dirname(fileURLToPath(import.meta.url));
async function requireVersion(root, version) {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  if (pkg.version !== version) throw new Error(`Pi Desktop compatibility requires ${pkg.name} ${version}; found ${pkg.version}`);
}
async function patchFile(file, patch) {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file));
  const result = patch(source);
  if (result !== source) await writeFile(file, result, "utf8");
}

export async function applyContextCompatibility(coreRoot) {
  await requireVersion(coreRoot, "1.5.0");
  const directory = path.join(coreRoot, "dist", "core");
  await copyFile(path.join(bridgeRoot, "service-context.js"), path.join(directory, "desktop-service-context.js"));
  await patchFile(path.join(directory, "messages.js"), patchServiceMessages);
  await patchFile(path.join(directory, "compaction", "compaction.js"), patchDesktopCompaction);
  await patchFile(path.join(directory, "agent-session.js"), patchDesktopContinuation);
  await patchFile(path.join(directory, "tools", "bash.js"), patchShellTimeout);
  await patchFile(path.join(coreRoot, "dist", "extensions", "codemode", "tool.js"), patchCodemodeDiscoveryDescription);
}

export async function applyCoreRequestCompatibility(coreRoot) {
  await applyContextCompatibility(coreRoot);
  const providerRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", pathToFileURL(path.join(coreRoot, "package.json")).href));
  await requireVersion(providerRoot, "1.5.0");
  await patchFile(path.join(providerRoot, "dist", "api", "openai-completions.js"), patchToolResultImages);
}

export async function applyAddonRequestCompatibility(name, root) {
  if (name === "pi-llama-cpp-stats") {
    await requireVersion(root, "0.1.6");
    await patchFile(path.join(root, "index.ts"), patchLlamaStatsCancellation);
  } else if (name === "pi-mcp-adapter") {
    await requireVersion(root, "5.1.0");
    await patchFile(path.join(root, "index.ts"), patchMcpIndex);
    await patchFile(path.join(root, "proxy-modes.ts"), patchMcpProxy);
    await copyFile(path.join(bridgeRoot, "..", "pi-mcp", "desktop-config.js"), path.join(root, "desktop-config.js"));
  }
}
