import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patchToolResultImages } from "./tool-result-images-patch.mjs";
import { patchMcpIndex, patchMcpProxy } from "./mcp-config-patch.mjs";
import { patchLlamaStatsCancellation } from "./llama-stats-patch.mjs";
import { patchToolRouting } from "./tool-routing-patch.mjs";
import { applyContextCompatibility } from "../resources/pi-rpc-bridge/compatibility.js";
import { applyPiLensGrammarCache } from "../resources/pi-lens/grammar-cache-patch.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corePackagePath = path.join(
  root,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "package.json",
);
const corePackage = JSON.parse(await readFile(corePackagePath, "utf8"));

if (corePackage.version !== "1.0.4") {
  throw new Error(
    `Pi RPC bridge targets pi-coding-agent 1.0.4, found ${corePackage.version}. ` +
    "Review the bridge before changing the pinned core version.",
  );
}

const source = path.join(root, "resources", "pi-rpc-bridge", "rpc-mode.js");
const destination = path.join(
  root,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "modes",
  "rpc",
  "rpc-mode.js",
);

await mkdir(path.dirname(destination), { recursive: true });
await copyFile(source, destination);
process.stdout.write("Pi Desktop RPC compatibility bridge applied.\n");

await applyContextCompatibility(path.dirname(corePackagePath));
process.stdout.write("Pi Desktop service-context and compaction compatibility bridge applied.\n");

const loaderPath = path.join(path.dirname(corePackagePath), "dist", "core", "extensions", "loader.js");
const loaderSource = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(loaderPath));
const patchedLoader = patchToolRouting(loaderSource);
await copyFile(path.join(root, "resources", "tool-routing", "index.js"), path.join(path.dirname(loaderPath), "desktop-tool-routing.js"));
if (patchedLoader !== loaderSource) await writeFile(loaderPath, patchedLoader, "utf8");
process.stdout.write("Pi Desktop native tool-exposure policy applied.\n");

// Resolve from the agent package: development has nested dependencies whereas
// electron-builder hoists the same provider into the portable runtime.
const providerRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", pathToFileURL(corePackagePath).href));
const providerPackage = JSON.parse(await readFile(path.join(providerRoot, "package.json"), "utf8"));
if (providerPackage.version !== "1.0.4") {
  throw new Error(`Tool image bridge targets pi-ai 1.0.4, found ${providerPackage.version}.`);
}
const providerPath = path.join(providerRoot, "dist", "api", "openai-completions.js");
const providerBytes = await readFile(providerPath);
const providerSource = new TextDecoder("utf-8", { fatal: true }).decode(providerBytes);
const patchedProvider = patchToolResultImages(providerSource);
if (patchedProvider !== providerSource) await writeFile(providerPath, patchedProvider, "utf8");
process.stdout.write("Pi Desktop multimodal tool-result compatibility bridge applied.\n");

const adapterDir = path.join(root, "node_modules", "pi-mcp-adapter");
const adapterPackage = JSON.parse(await readFile(path.join(adapterDir, "package.json"), "utf8"));
if (adapterPackage.version !== "5.1.0") throw new Error(`MCP configuration bridge targets pi-mcp-adapter 5.1.0, found ${adapterPackage.version}`);
for (const [name, patch] of [["index.ts", patchMcpIndex], ["proxy-modes.ts", patchMcpProxy]]) {
  const file = path.join(adapterDir, name);
  const source = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file));
  const result = patch(source);
  if (result !== source) await writeFile(file, result, "utf8");
}
await copyFile(path.join(root, "resources", "pi-mcp", "desktop-config.js"), path.join(adapterDir, "desktop-config.js"));
process.stdout.write("Pi Desktop MCP configuration bridge applied.\n");

const statsDir = path.join(root, "node_modules", "pi-llama-cpp-stats");
const statsPackage = JSON.parse(await readFile(path.join(statsDir, "package.json"), "utf8"));
if (statsPackage.version !== "0.1.6") throw new Error(`Statistics cancellation bridge targets pi-llama-cpp-stats 0.1.6, found ${statsPackage.version}`);
const statsPath = path.join(statsDir, "index.ts");
const statsSource = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(statsPath));
const patchedStats = patchLlamaStatsCancellation(statsSource);
if (patchedStats !== statsSource) await writeFile(statsPath, patchedStats, "utf8");
process.stdout.write("Pi Desktop statistics cancellation compatibility bridge applied.\n");
await applyPiLensGrammarCache(path.join(root, "node_modules", "pi-lens"));
process.stdout.write("Pi Desktop Pi Lens portable grammar cache applied.\n");
