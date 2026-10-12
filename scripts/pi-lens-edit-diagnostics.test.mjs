import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { patchPiLensEditDiagnostics } from "../resources/pi-lens/edit-diagnostics-patch.mjs";
import { getTouchedLinesForGuard } from "../node_modules/pi-lens/dist/clients/read-guard-tool-lines.js";

for (const name of ["dist/index.js", "dist/clients/read-guard-tool-lines.js"]) {
  test(`neutral edit diagnostics are idempotent for ${name}`, async () => {
    const source = await readFile(new URL(`../node_modules/pi-lens/${name}`, import.meta.url), "utf8");
    const patched = patchPiLensEditDiagnostics(source);
    assert.equal(patchPiLensEditDiagnostics(patched), patched);
    assert.doesNotMatch(patched, /file has likely changed/);
    assert.match(patched, /This replacement was not applied/);
  });
}

test("unknown edit guard messages fail explicitly", () => {
  assert.throws(() => patchPiLensEditDiagnostics("unknown"), /incompatible/);
});

test("real guard reports mismatches without inventing file changes or writing the file", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-lens-neutral-edit-"));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const content = "first line\nactual second line\nlast line\n";
  for (const [index, oldText] of ["invented fragment", "first line\ninvented second line"].entries()) {
    const file = path.join(directory, `fixture-${index}.txt`);
    await writeFile(file, content, "utf8");
    const result = getTouchedLinesForGuard({ toolName: "edit", toolCallId: `fixture-${index}`,
      input: { path: file, edits: [{ oldText, newText: "replacement" }] } }, file, "fixture", `fixture-${index}`);
    assert.ok(result.preflightError);
    assert.doesNotMatch(result.preflightError, /file has likely changed/);
    assert.match(result.preflightError, /replacement was not applied/i);
    assert.match(result.preflightError, /Re-read/);
    assert.equal(await readFile(file, "utf8"), content);
  }
});
