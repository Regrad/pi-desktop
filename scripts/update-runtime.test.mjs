import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(new URL("../electron/update-manager.ts", import.meta.url), "utf8");
const method = source.slice(source.indexOf("  private async smokeTestRuntime()"), source.indexOf("  private async hasNpm()"));
const body = method.slice(method.indexOf("{") + 1, method.lastIndexOf("}"))
  .replace("let exitError: Error | undefined;", "let exitError;");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const smoke = new AsyncFunction("mkdtemp", "path", "tmpdir", "PiRpcProcess", "randomUUID", "rm", body);

for (const appRoot of ["F:\\Pi_Desktop\\resources\\app.asar", "F:\\Pi Desktop\\resources\\app.asar"]) {
  test(`update smoke passes the portable dependency root: ${appRoot}`, async () => {
    const calls = [];
    let stopped = false;
    let cleaned = false;
    const store = {
      dataDir: "F:\\Pi Desktop\\data", agentDir: "F:\\Pi Desktop\\data\\agent",
      getEngineEntryPath: () => "F:\\Pi Desktop\\data\\runtime\\node_modules\\pi\\cli.js",
      getMcpDirectToolSelectors: async () => [],
    };
    class Rpc {
      constructor(options) {
        assert.equal(options.appRoot, appRoot);
        assert.equal(options.enginePath, store.getEngineEntryPath());
        assert.equal(options.agentDir, store.agentDir);
      }
      async start() {}
      async request(command) { calls.push(command); return {}; }
      async stop() { stopped = true; }
    }
    await smoke.call({ appRoot, store, runtimeExecutable: "F:\\Pi Desktop\\Pi Desktop.exe" },
      async () => "temporary-smoke", path, () => "temporary", Rpc, () => "test-id", async () => { cleaned = true; });
    assert.deepEqual(calls, ["get_state", "get_extension_state"]);
    assert.equal(stopped, true);
    assert.equal(cleaned, true);
  });
}

test("RPC passes appRoot through to the add-on dependency resolver", () => {
  const rpc = readFileSync(new URL("../electron/pi-rpc-process.ts", import.meta.url), "utf8");
  assert.match(rpc, /PI_DESKTOP_APP_ROOT: this\.options\.appRoot/);
});

test("ComfyUI resolves bundled jiti with appRoot even outside node_modules", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const addonHost = new URL("../resources/pi-comfyui/lib/host.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e",
    `const {hostRequire}=await import(${JSON.stringify(addonHost)});const jiti=hostRequire('jiti');if(typeof jiti.createJiti!=='function')process.exit(1);console.log('Bundled jiti resolved');`], {
    env: { ...process.env, PI_DESKTOP_APP_ROOT: root }, encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Bundled jiti resolved/);
});
