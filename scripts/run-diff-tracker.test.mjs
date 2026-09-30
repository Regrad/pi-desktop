import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunDiffTracker } from "../dist-electron/electron/run-diff-tracker.js";

const text = (value) => ({ kind: "text", text: value });
const missing = { kind: "missing" };

test("reports a successful model mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-diff-"));
  const filePath = path.join(root, "model.txt");
  await writeFile(filePath, "before\n", "utf8");
  const tracker = RunDiffTracker.start([root]);
  try {
    tracker.recordModelMutation({
      path: filePath,
      before: text("before\n"),
      after: text("before\nmodel\n"),
    });
    const diff = await tracker.live();
    assert.equal(diff.files.length, 1);
    assert.equal(diff.files[0].relativePath, "model.txt");
    assert.equal(diff.additions, 1);
    assert.equal(diff.deletions, 0);
  } finally {
    tracker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("does not report external changes without a model mutation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-diff-"));
  const filePath = path.join(root, "external.txt");
  await writeFile(filePath, "before\n", "utf8");
  const tracker = RunDiffTracker.start([root]);
  try {
    await writeFile(filePath, "before\nexternal\n", "utf8");
    const diff = await tracker.endRun();
    assert.deepEqual(diff, {
      additions: 0,
      deletions: 0,
      files: [],
      incomplete: false,
    });
  } finally {
    tracker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("excludes an external transition between two model mutations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-diff-"));
  const filePath = path.join(root, "mixed.txt");
  await writeFile(filePath, "base\n", "utf8");
  const tracker = RunDiffTracker.start([root]);
  try {
    tracker.recordModelMutation({
      path: filePath,
      before: text("base\n"),
      after: text("base\nmodel one\n"),
    });
    tracker.recordModelMutation({
      path: filePath,
      before: text("base\nmodel one\nexternal\n"),
      after: text("base\nmodel one\nexternal\nmodel two\n"),
    });
    const diff = await tracker.endRun();
    assert.equal(diff.files.length, 1);
    assert.equal(diff.additions, 2);
    assert.equal(diff.deletions, 0);
    assert.equal(
      diff.files[0].hunks.flatMap((hunk) => hunk.lines).includes("+external"),
      false,
    );
  } finally {
    tracker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("collapses contiguous edits and removes a full model revert", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-diff-"));
  const filePath = path.join(root, "reverted.txt");
  await writeFile(filePath, "base\n", "utf8");
  const tracker = RunDiffTracker.start([root]);
  try {
    tracker.recordModelMutation({
      path: filePath,
      before: text("base\n"),
      after: text("changed\n"),
    });
    tracker.recordModelMutation({
      path: filePath,
      before: text("changed\n"),
      after: text("base\n"),
    });
    assert.equal((await tracker.live()).files.length, 0);
  } finally {
    tracker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("reports created and deleted files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-diff-"));
  const createdPath = path.join(root, "created.txt");
  const deletedPath = path.join(root, "deleted.txt");
  await writeFile(deletedPath, "remove\n", "utf8");
  const tracker = RunDiffTracker.start([root]);
  try {
    tracker.recordModelMutation({
      path: createdPath,
      before: missing,
      after: text("created\n"),
    });
    tracker.recordModelMutation({
      path: deletedPath,
      before: text("remove\n"),
      after: missing,
    });
    const diff = await tracker.endRun();
    assert.deepEqual(
      diff.files.map((file) => file.status).sort(),
      ["added", "deleted"],
    );
  } finally {
    tracker.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ignores no-op, unsupported, excluded and outside mutations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-diff-"));
  const outside = path.join(os.tmpdir(), `outside-${Date.now()}.txt`);
  await mkdir(path.join(root, "logs"), { recursive: true });
  const tracker = RunDiffTracker.start([root]);
  try {
    tracker.recordModelMutation({
      path: path.join(root, "same.txt"),
      before: text("same\n"),
      after: text("same\n"),
    });
    tracker.recordModelMutation({
      path: path.join(root, "binary.bin"),
      before: { kind: "unsupported", size: 2, modified: 1 },
      after: { kind: "unsupported", size: 3, modified: 2 },
    });
    tracker.recordModelMutation({
      path: path.join(root, "logs", "noise.log"),
      before: text("a"),
      after: text("b"),
    });
    tracker.recordModelMutation({
      path: outside,
      before: text("a"),
      after: text("b"),
    });
    assert.equal((await tracker.endRun()).files.length, 0);
  } finally {
    tracker.close();
    await rm(root, { recursive: true, force: true });
  }
});
