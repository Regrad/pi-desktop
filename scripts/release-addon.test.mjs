import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createFastReleaseManifest, FAST_RELEASE_MANIFEST } from "./release-update-core.mjs";
import { createReleaseTransaction } from "./release-transaction.mjs";
import { activeComfyAddon, planComfyAddonUpdate, stageComfyAddonUpdate, assertComfyAddonState } from "./release-addon.mjs";

const digest = text => createHash("sha256").update(text).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-release-addon-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "resources/pi-comfyui");
  const portable = path.join(root, "release");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(root, "package.json"), "{}");
  for (const name of ["stock.ts", "custom.ts", "deleted.ts", "retired.ts"]) await writeFile(path.join(source, name), "old stock");
  const previous = await createFastReleaseManifest(root);
  await mkdir(portable);
  await cp(source, path.join(portable, "resources/app/resources/pi-comfyui"), { recursive: true });
  await cp(source, path.join(portable, activeComfyAddon), { recursive: true });
  await writeFile(path.join(portable, FAST_RELEASE_MANIFEST), JSON.stringify(previous));
  for (const name of ["stock.ts", "custom.ts", "deleted.ts", "added.ts"]) await writeFile(path.join(source, name), "new stock");
  await rm(path.join(source, "retired.ts"));
  return { root, portable, source };
}

test("addon updates deliver stock files, additions and removals while preserving local edits/deletions", async t => {
  const { root, portable } = await fixture(t);
  const active = path.join(portable, activeComfyAddon);
  await writeFile(path.join(active, "custom.ts"), "my local edit");
  await rm(path.join(active, "deleted.ts"));
  await writeFile(path.join(active, "my-tool.ts"), "user tool");
  const snapshot = await createFastReleaseManifest(root);
  const plan = await planComfyAddonUpdate(root, portable, snapshot);
  assert.deepEqual(plan.changes.map(change => change.relative).sort(), ["added.ts", "retired.ts", "stock.ts"]);
  assert.deepEqual(plan.preserved.sort(), ["custom.ts", "deleted.ts"]);
  const tx = await createReleaseTransaction(portable);
  await stageComfyAddonUpdate(tx, plan, portable);
  await tx.commit(phase => assertComfyAddonState(plan, portable, phase === "after"));
  assert.equal(await readFile(path.join(active, "stock.ts"), "utf8"), "new stock");
  assert.equal(await readFile(path.join(active, "added.ts"), "utf8"), "new stock");
  assert.equal(await readFile(path.join(active, "custom.ts"), "utf8"), "my local edit");
  assert.equal(await readFile(path.join(active, "my-tool.ts"), "utf8"), "user tool");
  await assert.rejects(readFile(path.join(active, "deleted.ts")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(active, "retired.ts")), { code: "ENOENT" });
});

test("full pack applies the same addon upgrade to copied data before activation", async t => {
  const { root, portable } = await fixture(t);
  const snapshot = await createFastReleaseManifest(root);
  const plan = await planComfyAddonUpdate(root, portable, snapshot);
  const next = path.join(root, "next");
  await cp(portable, next, { recursive: true });
  const tx = await createReleaseTransaction(next);
  await stageComfyAddonUpdate(tx, plan, next);
  await tx.commit(phase => assertComfyAddonState(plan, next, phase === "after"));
  assert.equal(await readFile(path.join(next, activeComfyAddon, "stock.ts"), "utf8"), "new stock");
  assert.equal(await readFile(path.join(portable, activeComfyAddon, "stock.ts"), "utf8"), "old stock", "old installation is intact until the full swap");
});

test("legacy false-current manifests repair only exact historical stock files", async t => {
  const { root, portable, source } = await fixture(t);
  const active = path.join(portable, activeComfyAddon);
  await writeFile(path.join(active, "custom.ts"), "my local edit");
  const snapshot = await createFastReleaseManifest(root);
  await writeFile(path.join(portable, FAST_RELEASE_MANIFEST), JSON.stringify({ ...snapshot, format: 1 }));
  await rm(path.join(portable, "resources/app/resources/pi-comfyui"), { recursive: true });
  await cp(source, path.join(portable, "resources/app/resources/pi-comfyui"), { recursive: true });
  const plan = await planComfyAddonUpdate(root, portable, snapshot, { historicalHashes: async () => new Set([digest("old stock")]) });
  assert.ok(plan.changes.some(change => change.relative === "stock.ts"));
  assert.ok(plan.preserved.includes("custom.ts"));
});

test("an addon edit made during preparation aborts before replacing user content", async t => {
  const { root, portable } = await fixture(t);
  const plan = await planComfyAddonUpdate(root, portable, await createFastReleaseManifest(root));
  const tx = await createReleaseTransaction(portable);
  await stageComfyAddonUpdate(tx, plan, portable);
  await writeFile(path.join(portable, activeComfyAddon, "stock.ts"), "edited while building");
  await assert.rejects(tx.commit(phase => assertComfyAddonState(plan, portable, phase === "after")), /Active addon changed/);
  assert.equal(await readFile(path.join(portable, activeComfyAddon, "stock.ts"), "utf8"), "edited while building");
});

test("removed addon stays removed and fresh installations use normal seeding", async t => {
  const { root, portable } = await fixture(t);
  await rm(path.join(portable, activeComfyAddon), { recursive: true });
  const snapshot = await createFastReleaseManifest(root);
  assert.deepEqual((await planComfyAddonUpdate(root, portable, snapshot)).changes, []);
});

test("malformed legacy manifest cannot direct addon deletion outside its directory", async t => {
  const { root, portable } = await fixture(t);
  await writeFile(path.join(portable, FAST_RELEASE_MANIFEST), JSON.stringify({ format: 1, files: { "resources/pi-comfyui/../../outside": "hash" } }));
  await assert.rejects(planComfyAddonUpdate(root, portable, await createFastReleaseManifest(root)), /Invalid addon manifest path/);
});
