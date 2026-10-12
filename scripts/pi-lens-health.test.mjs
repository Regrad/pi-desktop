import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createDispatchContext, dispatchForFile, RunnerRegistry, clearCoverageNoticeState } from "../node_modules/pi-lens/dist/clients/dispatch/dispatcher.js";
import { FactStore } from "../node_modules/pi-lens/dist/clients/dispatch/fact-store.js";
import { patchPiLensAnalysisHealth } from "../resources/pi-lens/analysis-health-patch.mjs";

async function dispatch(t, run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lens-health-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "source.ts");
  await writeFile(file, "export const answer = 42;\n", "utf8");
  clearCoverageNoticeState();
  const ctx = createDispatchContext(file, dir, { getFlag: () => false }, new FactStore(), false);
  ctx.deltaMode = false;
  const registry = new RunnerRegistry();
  registry.register({ id: "health-fixture", priority: 1, appliesTo: [], run, timeoutMs: 1000 });
  return dispatchForFile(ctx, [{ runnerIds: ["health-fixture"], semantic: "blocking", mode: "all" }], registry);
}

test("health patch is idempotent in bundled and unbundled dispatchers", async () => {
  for (const file of ["dist/index.js", "dist/clients/dispatch/dispatcher.js"]) {
    const source = await readFile(path.join("node_modules/pi-lens", file), "utf8");
    assert.equal(patchPiLensAnalysisHealth(source), source);
  }
});

test("a crashed analyzer cannot become a clean result", async t => {
  const result = await dispatch(t, async () => { throw new Error("test analyzer crash"); });
  assert.match(result.output, /Analysis incomplete.*exception/);
  assert.ok(result.warnings.some(d => d.id.startsWith("analysis-incomplete:")));
});

test("partial analysis preserves genuine findings and exposes incomplete coverage", async t => {
  const result = await dispatch(t, async ctx => ({ status: "failed", analysisIncomplete: true,
    diagnostics: [{ id: "real-finding", filePath: ctx.filePath, line: 1, severity: "error", semantic: "blocking", message: "real issue", tool: "health-fixture" }] }));
  assert.match(result.output, /real issue/);
  assert.match(result.output, /Analysis incomplete.*incomplete/);
  assert.equal(result.hasBlockers, true);
});

test("intentional cancellation is not mislabeled as an analyzer exception", async t => {
  const result = await dispatch(t, async () => { throw new DOMException("Stop", "AbortError"); });
  assert.doesNotMatch(result.output, /Analysis incomplete/);
});

test("a detected code error is not confused with an analyzer failure", async t => {
  const result = await dispatch(t, async ctx => ({ status: "failed", diagnostics: [
    { id: "real-finding", filePath: ctx.filePath, line: 1, severity: "error", semantic: "blocking", message: "real issue", tool: "health-fixture" }
  ] }));
  assert.match(result.output, /real issue/);
  assert.doesNotMatch(result.output, /Analysis incomplete/);
});

test("a complete successful analysis stays complete", async t => {
  const result = await dispatch(t, async () => ({ status: "success", diagnostics: [] }));
  assert.doesNotMatch(result.output, /Analysis incomplete/);
});
