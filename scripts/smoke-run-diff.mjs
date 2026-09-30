import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunDiffTracker } from "../dist-electron/electron/run-diff-tracker.js";

const text = (value) => ({ kind: "text", text: value });
const root = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-run-diff-"));
try {
  const modifiedPath = path.join(root, "modified.txt");
  const externalPath = path.join(root, "external.txt");
  await writeFile(modifiedPath, "alpha\nbeta\n", "utf8");
  await writeFile(externalPath, "before\n", "utf8");

  const tracker = RunDiffTracker.start([root]);
  tracker.recordModelMutation({
    path: modifiedPath,
    before: text("alpha\nbeta\n"),
    after: text("alpha\nBETA\n"),
  });
  await writeFile(externalPath, "before\nexternal\n", "utf8");

  const diff = await tracker.endRun();
  assert.equal(diff.files.length, 1);
  assert.equal(diff.files[0].relativePath, "modified.txt");
  assert.equal(diff.additions, 1);
  assert.equal(diff.deletions, 1);
  tracker.close();
  process.stdout.write("Run diff smoke test passed.\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
