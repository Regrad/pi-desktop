import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
export async function verifyPackagedEngine(binaryDirectory) {
  const app = path.join(binaryDirectory, "resources/app");
  const upstream = JSON.parse(await readFile(path.join(root, "vendor/pi.upstream.json"), "utf8"));
  const bundled = JSON.parse(await readFile(path.join(app, "resources/pi-engine/upstream.json"), "utf8"));
  if (bundled.commit !== upstream.commit) throw new Error("Packaged engine source revision mismatch");
  if (await readFile(path.join(app, "resources/pi-engine/LICENSE"), "utf8") !== await readFile(path.join(root, "vendor/pi/LICENSE"), "utf8")) throw new Error("Missing or changed Pi MIT license");
  for (const name of upstream.packages) {
    const source = JSON.parse(await readFile(path.join(root, "vendor/pi/packages", name, "package.json"), "utf8"));
    const installed = path.join(app, "node_modules", source.name);
    if (!(await realpath(installed)).startsWith(path.resolve(app) + path.sep)) throw new Error(`Packaged engine points outside the application: ${name}`);
    if (JSON.parse(await readFile(path.join(installed, "package.json"), "utf8")).version !== upstream.version) throw new Error(`Packaged engine version mismatch: ${name}`);
  }
  // Same real protocol/tools/media/cancellation contract as development, but
  // run with the packaged Electron executable and packaged extensions.
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", "scripts/pi-core-upgrade.test.mjs", "scripts/chat-title.test.mjs", "scripts/engine-customization.test.mjs"], {
      cwd: root, windowsHide: true, stdio: "inherit",
      env: { ...process.env, PI_TEST_APP_ROOT: app, PI_TEST_EXECUTABLE: path.join(binaryDirectory, "Pi Desktop.exe"), PI_TEST_FORBID_PI_CLI: "1" },
    });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Packaged engine contract failed (${code}); release was not activated`)));
  });
}
