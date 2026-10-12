import test from "node:test";
import assert from "node:assert/strict";
import { activatePortableBuild } from "./portable-swap.mjs";
import { mkdtemp, mkdir, writeFile, readFile, access, rename, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

function fixture(failures = []) {
  const dirs = new Map([["target", "original data"], ["next", "new build"]]);
  return { dirs, ops: {
    exists: async name => dirs.has(name),
    rename: async (from, to, label) => {
      if (failures.includes(label)) throw new Error(label);
      assert.ok(dirs.has(from)); assert.ok(!dirs.has(to));
      dirs.set(to, dirs.get(from)); dirs.delete(from);
    },
  } };
}
const paths = { target: "target", next: "next", previous: "previous" };
test("portable activation keeps original data in the backup until success is confirmed", async () => {
  const f = fixture();
  assert.equal(await activatePortableBuild(paths, f.ops), true);
  assert.equal(f.dirs.get("target"), "new build");
  assert.equal(f.dirs.get("previous"), "original data");
});
test("failed activation restores original installation", async () => {
  const f = fixture(["activate new build"]);
  await assert.rejects(activatePortableBuild(paths, f.ops), /activate new build/);
  assert.equal(f.dirs.get("target"), "original data");
});
test("failed activation and rollback preserve the only original copy", async () => {
  const f = fixture(["activate new build", "restore original build"]);
  await assert.rejects(activatePortableBuild(paths, f.ops), error => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /preserved at: previous/);
    return true;
  });
  assert.equal(f.dirs.get("previous"), "original data");
});
test("existing recovery directory is never overwritten", async () => {
  const f = fixture(); f.dirs.set("previous", "older recovered data");
  await assert.rejects(activatePortableBuild(paths, f.ops), /Backup already exists/);
  assert.equal(f.dirs.get("previous"), "older recovered data");
  assert.equal(f.dirs.get("target"), "original data");
});
test("real failed rollback leaves the original data recoverable on disk", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-portable-recovery-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); await rm(root, { recursive: true, force: true }); });
  const paths = Object.fromEntries(["target", "next", "previous"].map(name => [name, path.join(root, name)]));
  await mkdir(path.join(paths.target, "data"), { recursive: true });
  await mkdir(paths.next);
  const content = JSON.stringify({ conversations: [{ id: "test-only", title: "Сохранить чат" }] });
  await writeFile(path.join(paths.target, "data", "desktop-state.json"), content, "utf8");
  await assert.rejects(activatePortableBuild(paths, {
    exists: filename => access(filename).then(() => true, () => false),
    rename: async (from, to, label) => {
      if (label !== "move old aside") throw new Error("simulated locked folder");
      await rename(from, to);
    },
  }), /Original installation preserved/);
  assert.equal(await readFile(path.join(paths.previous, "data", "desktop-state.json"), "utf8"), content);
});
