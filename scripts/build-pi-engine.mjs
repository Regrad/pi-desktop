import { spawn } from "node:child_process";
import { cp, readFile, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyUpstream, inventory } from "./pi-upstream-state.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upstream = await verifyUpstream(root);
const assetManifest = JSON.parse(await readFile(path.join(root, "vendor/pi-assets.json"), "utf8"));
if (assetManifest.version !== upstream.version) throw new Error("Pi source and release assets must have the same version");
const inputFiles = { ...upstream.files, assets: assetManifest.files };
for (const relative of ["package-lock.json", "scripts/build-pi-engine.mjs", "scripts/apply-rpc-bridge.mjs"]) {
  inputFiles[relative] = createHash("sha256").update(await readFile(path.join(root, relative))).digest("hex");
}
for (const relative of ["resources/pi-engine", "resources/pi-rpc-bridge", "resources/tool-routing", "resources/pi-mcp", "resources/pi-lens"]) {
  inputFiles[relative] = await inventory(path.join(root, relative));
}
const fingerprint = createHash("sha256").update(JSON.stringify(inputFiles)).digest("hex");
const marker = path.join(root, ".pi-engine-build.json");
async function outputs() {
  return Object.fromEntries(await Promise.all(upstream.packages.map(async name => [name, await inventory(path.join(root, "vendor/pi/packages", name, "dist"))])));
}
let cached;
try { cached = JSON.parse(await readFile(marker, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
if (cached?.fingerprint === fingerprint && JSON.stringify(cached.outputs) === JSON.stringify(await outputs())) {
  await import("./apply-rpc-bridge.mjs");
  console.log(`Embedded Pi ${upstream.version}: verified build is current.`);
} else {
  await cp(path.join(root, "vendor/pi-assets/ai-provider-data"), path.join(root, "vendor/pi/packages/ai/src/providers/data"), { recursive: true });
  await cp(path.join(root, "vendor/pi-assets/tui-win32-prebuilds"), path.join(root, "vendor/pi/packages/tui/native/win32/prebuilds"), { recursive: true });
  for (const name of upstream.packages) {
    console.log(`Compiling embedded Pi: ${name}`);
    // Every target is from our fixed, validated package list and confined to
    // generated dist output; removed upstream modules must not survive a build.
    if (!/^[a-z-]+$/.test(name)) throw new Error(`Invalid Pi package: ${name}`);
    await rm(path.join(root, "vendor/pi/packages", name, "dist"), { recursive: true, force: true });
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc"), "-p", path.join(root, "vendor/pi/packages", name, "tsconfig.build.json")], { cwd: root, stdio: "inherit", windowsHide: true });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Pi ${name} compilation failed (${code})`)));
    });
  }
  const coding = path.join(root, "vendor/pi/packages/coding-agent");
  for (const relative of ["modes/interactive/theme", "modes/interactive/assets", "core/export-html"]) {
    await cp(path.join(coding, "src", relative), path.join(coding, "dist", relative), { recursive: true, filter: file => !/\.(?:ts|tsx)$/.test(file) });
  }
  await cp(path.join(root, "vendor/pi-assets/ai-provider-data"), path.join(root, "vendor/pi/packages/ai/dist/providers/data"), { recursive: true });
  await import("./apply-rpc-bridge.mjs");
  await verifyUpstream(root);
  await writeFile(marker, JSON.stringify({ version: upstream.version, commit: upstream.commit, fingerprint, outputs: await outputs() }, null, 2) + "\n");
  console.log(`Embedded Pi ${upstream.version} built from ${upstream.commit}.`);
}
