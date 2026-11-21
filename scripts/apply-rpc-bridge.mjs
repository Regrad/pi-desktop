import { copyFile, readFile, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patchToolResultImages } from "./tool-result-images-patch.mjs";
import { patchToolRouting } from "./tool-routing-patch.mjs";
import { applyAddonRequestCompatibility, applyContextCompatibility, applyRequestDiagnosticsCompatibility } from "../resources/pi-rpc-bridge/compatibility.js";
import { applyPiLensGrammarCache } from "../resources/pi-lens/grammar-cache-patch.mjs";
import { SUPPORTED_PI_VERSION } from "../resources/pi-engine/version.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readPackage(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    // Still fails closed: a missing or malformed manifest must stop the bridge.
    throw new Error(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const corePackagePath = path.join(
  root,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "package.json",
);
const corePackage = await readPackage(corePackagePath);

if (corePackage.version !== SUPPORTED_PI_VERSION) {
  throw new Error(
    `Pi SDK adapter targets pi-coding-agent ${SUPPORTED_PI_VERSION}, found ${corePackage.version}. ` +
    "Review the bridge before changing the pinned core version.",
  );
}

// Desktop owns its SDK bootstrap and protocol adapter. The upstream CLI/RPC
// entry is never replaced. Remaining transforms affect build output only.

await applyContextCompatibility(path.dirname(corePackagePath));
await applyRequestDiagnosticsCompatibility(path.dirname(corePackagePath));
process.stdout.write("Pi Desktop service-context and compaction compatibility bridge applied.\n");

const loaderPath = path.join(path.dirname(corePackagePath), "dist", "core", "extensions", "loader.js");
const loaderSource = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(loaderPath));
const patchedLoader = patchToolRouting(loaderSource);
await copyFile(path.join(root, "resources", "tool-routing", "index.js"), path.join(path.dirname(loaderPath), "desktop-tool-routing.js"));
await copyFile(path.join(root, "resources", "tool-routing", "desktop-planning-permissions.js"), path.join(path.dirname(loaderPath), "desktop-planning-permissions.js"));
if (patchedLoader !== loaderSource) await writeFile(loaderPath, patchedLoader, "utf8");
process.stdout.write("Pi Desktop native tool-exposure policy applied.\n");

// Resolve from the agent package: development has nested dependencies whereas
// electron-builder hoists the same provider into the portable runtime.
const providerRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", pathToFileURL(corePackagePath).href));
const providerPackage = await readPackage(path.join(providerRoot, "package.json"));
if (providerPackage.version !== SUPPORTED_PI_VERSION) {
  throw new Error(`Tool image bridge targets pi-ai ${SUPPORTED_PI_VERSION}, found ${providerPackage.version}.`);
}
const providerPath = path.join(providerRoot, "dist", "api", "openai-completions.js");
const providerBytes = await readFile(providerPath);
const providerSource = new TextDecoder("utf-8", { fatal: true }).decode(providerBytes);
const patchedProvider = patchToolResultImages(providerSource);
if (patchedProvider !== providerSource) await writeFile(providerPath, patchedProvider, "utf8");
process.stdout.write("Pi Desktop multimodal tool-result compatibility bridge applied.\n");

const adapterDir = path.join(root, "node_modules", "pi-mcp-adapter");
await applyAddonRequestCompatibility("pi-mcp-adapter", adapterDir);
process.stdout.write("Pi Desktop MCP configuration bridge applied.\n");

await applyPiLensGrammarCache(path.join(root, "node_modules", "pi-lens"));
process.stdout.write("Pi Desktop Pi Lens portable grammar cache applied.\n");
