import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { patchToolResultImages } from "./tool-result-images-patch.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const corePackagePath = path.join(
  root,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "package.json",
);
const corePackage = JSON.parse(await readFile(corePackagePath, "utf8"));

if (corePackage.version !== "0.84.2") {
  throw new Error(
    `Pi RPC bridge targets pi-coding-agent 0.84.2, found ${corePackage.version}. ` +
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

// Resolve from the agent package: development has nested dependencies whereas
// electron-builder hoists the same provider into the portable runtime.
const providerRoot = path.dirname(findPackageJSON("@earendil-works/pi-ai", pathToFileURL(corePackagePath).href));
const providerPackage = JSON.parse(await readFile(path.join(providerRoot, "package.json"), "utf8"));
if (providerPackage.version !== "0.84.2") {
  throw new Error(`Tool image bridge targets pi-ai 0.84.2, found ${providerPackage.version}.`);
}
const providerPath = path.join(providerRoot, "dist", "api", "openai-completions.js");
const providerBytes = await readFile(providerPath);
const providerSource = new TextDecoder("utf-8", { fatal: true }).decode(providerBytes);
const patchedProvider = patchToolResultImages(providerSource);
if (patchedProvider !== providerSource) await writeFile(providerPath, patchedProvider, "utf8");
process.stdout.write("Pi Desktop multimodal tool-result compatibility bridge applied.\n");
