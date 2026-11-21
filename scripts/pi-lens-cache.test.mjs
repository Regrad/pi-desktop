import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { patchPiLensGrammarCache } from "../resources/pi-lens/grammar-cache-patch.mjs";
import { getDesktopAnalysisBindings } from "../node_modules/pi-lens/dist/index.js";

const { TreeSitterClient } = getDesktopAnalysisBindings();

test(`grammar cache bridge supports and is idempotent for dist/index.js`, () => {
  const source = readFileSync(new URL(`../node_modules/pi-lens/dist/index.js`, import.meta.url), "utf8");
  const patched = patchPiLensGrammarCache(source);
  assert.equal(patchPiLensGrammarCache(patched), patched);
  assert.match(patched, /push\(this.grammarsWriteDir\(\)\)/);
  assert.match(patched, /const dir = process.env.PI_DESKTOP_DATA_DIR \? this.grammarsWriteDir\(\)/);
});

test("real client reads portable grammars and never chooses the package as write target", () => {
  const previous = process.env.PI_DESKTOP_DATA_DIR;
  const data = mkdtempSync(path.join(os.tmpdir(), "pi-lens-cache-"));
  try {
    delete process.env.PI_DESKTOP_DATA_DIR;
    const client = new TreeSitterClient();
    const original = client.grammarsWriteDir();
    assert.ok(original?.includes("web-tree-sitter"));
    process.env.PI_DESKTOP_DATA_DIR = data;
    const portable = path.join(data, "pi-lens", "grammars");
    assert.equal(client.grammarsWriteDir(), portable);
    assert.ok(client.grammarSourceDirs().includes(portable));
    client.grammarsDir = path.join(data, "resources", "app.asar", "grammars");
    assert.equal(client.grammarsWriteDir(), portable);
    assert.ok(client.resolveGrammarFile("tree-sitter-typescript.wasm"), "bundled core remains readable");
  } finally {
    if (previous === undefined) delete process.env.PI_DESKTOP_DATA_DIR;
    else process.env.PI_DESKTOP_DATA_DIR = previous;
  }
});

test("unknown upstream shapes fail explicitly instead of silently applying a partial patch", () => {
  assert.throws(() => patchPiLensGrammarCache("class Changed {}"), /incompatible/);
});

test("packaging and staged module updates apply grammar routing", () => {
  const build = readFileSync(new URL("./apply-rpc-bridge.mjs", import.meta.url), "utf8");
  assert.match(build, /await applyPiLensGrammarCache/);
  const updates = readFileSync(new URL("../electron/update-manager.ts", import.meta.url), "utf8");
  assert.ok(updates.includes('if (name === "pi-lens") await this.applyLensGrammarCache(candidate);'));
});
