import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installedApplicationPath, isApplicationArchive, readApplicationFile } from "./portable-layout.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
export async function verifyPackagedEngine(binaryDirectory) {
  const app = await installedApplicationPath(binaryDirectory);
  const archived = isApplicationArchive(app);
  // A Windows temp folder can arrive in 8.3 form (ENGARD~1) while realpath returns
  // the long name for nested paths, so the containment check has to compare two
  // resolved paths or a correct build looks like it escapes the application.
  const appRoot = await realpath(app);
  const upstream = JSON.parse(await readFile(path.join(root, "vendor/pi.upstream.json"), "utf8"));
  const engineMetadata = archived
    ? path.join(binaryDirectory, "resources", "pi-engine")
    : path.join(app, "resources", "pi-engine");
  const bundled = JSON.parse(await readFile(path.join(engineMetadata, "upstream.json"), "utf8"));
  if (bundled.commit !== upstream.commit) throw new Error("Packaged engine source revision mismatch");
  if (await readFile(path.join(engineMetadata, "LICENSE"), "utf8") !== await readFile(path.join(root, "vendor/pi/LICENSE"), "utf8")) throw new Error("Missing or changed Pi MIT license");
  for (const name of upstream.packages) {
    const source = JSON.parse(await readFile(path.join(root, "vendor/pi/packages", name, "package.json"), "utf8"));
    const installed = path.join(app, "node_modules", source.name);
    if (!archived && !(await realpath(installed)).startsWith(appRoot + path.sep)) throw new Error(`Packaged engine points outside the application: ${name}`);
    const manifestBytes = await readApplicationFile(app, `node_modules/${source.name}/package.json`);
    if (!manifestBytes) throw new Error(`Packaged engine dependency not found: ${source.name}`);
    const manifest = JSON.parse(manifestBytes);
    if (manifest.version !== upstream.version) throw new Error(`Packaged engine version mismatch: ${name}`);
  }
  // Same real protocol/tools/media/cancellation contract as development, but
  // run with the packaged Electron executable and packaged extensions.
  const executable = path.join(binaryDirectory, "Pi Desktop.exe");
  const tests = ["scripts/pi-core-upgrade.test.mjs", "scripts/chat-title.test.mjs", "scripts/engine-customization.test.mjs"];
  if (archived) tests.push("scripts/packaged-addon-peers.test.mjs");
  await new Promise((resolve, reject) => {
    const child = spawn(archived ? executable : process.execPath, ["--test", ...tests], {
      cwd: root, windowsHide: true, stdio: "inherit",
      env: { ...process.env, ...(archived ? { ELECTRON_RUN_AS_NODE: "1" } : {}), PI_TEST_APP_ROOT: app, PI_TEST_EXECUTABLE: executable, PI_TEST_FORBID_PI_CLI: "1" },
    });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Packaged engine contract failed (${code}); release was not activated`)));
  });
}
