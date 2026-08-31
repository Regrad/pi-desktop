import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunDiffTracker } from "../dist-electron/electron/run-diff-tracker.js";

const testRoot = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-run-diff-"));
try {
  const modifiedPath = path.join(testRoot, "modified.txt");
  const deletedPath = path.join(testRoot, "deleted.txt");
  await writeFile(modifiedPath, "alpha\nbeta\ngamma\n", "utf8");
  await writeFile(deletedPath, "remove me\n", "utf8");

  const tracker = await RunDiffTracker.start([testRoot]);
  await writeFile(modifiedPath, "alpha\nBETA\ngamma\n", "utf8");
  await writeFile(path.join(testRoot, "added.txt"), "one\ntwo\n", "utf8");
  await rm(deletedPath);

  const diff = await tracker.finish();
  assert.equal(diff.files.length, 3);
  assert.equal(diff.additions, 3);
  assert.equal(diff.deletions, 2);
  assert.deepEqual(diff.files.map((file) => file.status).sort(), ["added", "deleted", "modified"]);
  assert.equal(diff.incomplete, false);
  process.stdout.write("Run diff smoke test passed.\n");
} finally {
  await rm(testRoot, { recursive: true, force: true });
}
