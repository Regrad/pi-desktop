import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const appRoot = process.env.PI_TEST_APP_ROOT;

test("an addon can resolve a bundled peer copied from an ASAR directory", {
  skip: !appRoot || path.basename(appRoot) !== "app.asar",
}, async t => {
  const managerUrl = pathToFileURL(path.join(appRoot, "dist-electron/electron/update-manager.js"));
  const { UpdateManager } = await import(managerUrl.href);
  const temp = await realpath(tmpdir());
  const stage = await mkdtemp(path.join(temp, "pi-addon-peers-"));
  t.after(async () => {
    const resolved = await realpath(stage);
    assert.equal(path.dirname(resolved), temp);
    assert.match(path.basename(resolved), /^pi-addon-peers-/);
    await rm(resolved, { recursive: true, force: true });
  });

  const candidate = path.join(stage, "node_modules", "candidate");
  await mkdir(candidate, { recursive: true });
  await writeFile(path.join(candidate, "package.json"), JSON.stringify({
    peerDependencies: { "@earendil-works/pi-ai": "*", typebox: "*", zod: "*" },
  }));
  const manager = new UpdateManager(undefined, appRoot, process.execPath);
  await manager.linkBundledPeers(stage, candidate);

  const require = createRequire(path.join(candidate, "index.js"));
  assert.equal(require("zod").z.string().parse("compiled"), "compiled");
  const installed = await readFile(path.join(stage, "node_modules", "zod", "package.json"));
  const bundled = await readFile(path.join(appRoot, "node_modules", "zod", "package.json"));
  assert.deepEqual(installed, bundled);
  assert.equal(existsSync(path.join(stage, "node_modules", "@earendil-works", "pi-ai")), false);
});
