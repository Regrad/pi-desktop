import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createReleaseTransaction } from "./release-transaction.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-release-transaction-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = path.join(root, "release");
  await mkdir(release);
  for (const name of ["renderer", "electron"]) {
    await mkdir(path.join(root, name));
    await writeFile(path.join(root, name, "version.txt"), "new");
    await mkdir(path.join(release, name));
    await writeFile(path.join(release, name, "version.txt"), "old");
  }
  await writeFile(path.join(release, "manifest.json"), "old manifest");
  await writeFile(path.join(root, "manifest.json"), "new manifest");
  return { root, release, version: name => readFile(path.join(release, name, "version.txt"), "utf8") };
}

test("all modules and manifest commit together; success leaves no recovery copies", async t => {
  const { root, release, version } = await fixture(t);
  const tx = await createReleaseTransaction(release);
  for (const name of ["renderer", "electron"]) await tx.replace(path.join(root, name), path.join(release, name));
  await tx.replace(path.join(root, "manifest.json"), path.join(release, "manifest.json"));
  assert.equal(await version("renderer"), "old", "staging never mutates the installed version");
  await tx.commit(); await tx.dispose();
  assert.equal(await version("renderer"), "new");
  assert.equal(await version("electron"), "new");
  assert.equal(await readFile(path.join(release, "manifest.json"), "utf8"), "new manifest");
  assert.deepEqual((await readdir(release)).sort(), ["electron", "manifest.json", "renderer"]);
});

test("a late module failure rolls back earlier modules, deletions and manifest", async t => {
  const { root, release, version } = await fixture(t);
  await writeFile(path.join(release, "removed.txt"), "keep on rollback");
  const tx = await createReleaseTransaction(release, { rename: async (from, to) => {
    if (path.basename(from).startsWith("next-") && to === path.join(release, "electron")) throw new Error("injected activation failure");
    await rename(from, to);
  } });
  await tx.replace(path.join(root, "renderer"), path.join(release, "renderer"));
  await tx.remove(path.join(release, "removed.txt"));
  await tx.replace(path.join(root, "manifest.json"), path.join(release, "manifest.json"));
  await tx.replace(path.join(root, "electron"), path.join(release, "electron"));
  await assert.rejects(tx.commit(), /injected activation failure/); await tx.dispose();
  assert.equal(await version("renderer"), "old");
  assert.equal(await version("electron"), "old");
  assert.equal(await readFile(path.join(release, "manifest.json"), "utf8"), "old manifest");
  assert.equal(await readFile(path.join(release, "removed.txt"), "utf8"), "keep on rollback");
  assert.ok((await readdir(release)).every(name => !name.startsWith(".pi-desktop-update-")));
});

test("validation failure after activation restores the whole previous version", async t => {
  const { root, release, version } = await fixture(t);
  const tx = await createReleaseTransaction(release);
  await tx.replace(path.join(root, "renderer"), path.join(release, "renderer"));
  let checks = 0;
  await assert.rejects(tx.commit(async () => { if (++checks === 2) throw new Error("sources changed"); }), /sources changed/);
  await tx.dispose(); assert.equal(await version("renderer"), "old");
});

test("failed rollback keeps recoverable originals and identifies their directory", async t => {
  const { root, release } = await fixture(t);
  const tx = await createReleaseTransaction(release, { rename: async (from, to) => {
    if ((path.basename(from).startsWith("next-") && to === path.join(release, "electron"))
      || path.basename(from).startsWith("old-")) throw new Error("injected lock");
    await rename(from, to);
  } });
  for (const name of ["renderer", "electron"]) await tx.replace(path.join(root, name), path.join(release, name));
  await assert.rejects(tx.commit(), error => error instanceof AggregateError && error.message.includes(tx.stagingRoot));
  await tx.dispose();
  assert.equal(await readFile(path.join(tx.stagingRoot, "old-0", "version.txt"), "utf8"), "old");
  assert.equal(await readFile(path.join(tx.stagingRoot, "old-1", "version.txt"), "utf8"), "old");
});

test("all activation renames stay on the release volume, independent of source location", async t => {
  const { root, release, version } = await fixture(t);
  const tx = await createReleaseTransaction(release, { rename: async (from, to) => {
    assert.ok(from.startsWith(release + path.sep), "cross-volume source must be copied to staging first");
    assert.ok(to.startsWith(release + path.sep));
    await rename(from, to);
  } });
  await tx.replace(path.join(root, "renderer"), path.join(release, "renderer"));
  await tx.commit(); assert.equal(await version("renderer"), "new");
});

test("missing input or invalid targets abort staging without changing installed files", async t => {
  const { root, release, version } = await fixture(t);
  const tx = await createReleaseTransaction(release);
  await assert.rejects(tx.replace(path.join(root, "absent"), path.join(release, "renderer")), { code: "ENOENT" });
  await assert.rejects(tx.remove(root), /inside the release directory/);
  await assert.rejects(tx.remove(release), /inside the release directory/);
  await tx.replace(path.join(root, "renderer"), path.join(release, "renderer"));
  await assert.rejects(tx.remove(path.join(release, "renderer", "version.txt")), /Overlapping/);
  await tx.dispose(); assert.equal(await version("renderer"), "old");
  await assert.rejects(stat(tx.stagingRoot), { code: "ENOENT" });
});
