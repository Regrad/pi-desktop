import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
