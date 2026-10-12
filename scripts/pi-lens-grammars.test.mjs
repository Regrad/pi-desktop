import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { verifyGrammar, ensurePiLensGrammars } from "../resources/pi-lens/grammars.mjs";

test("verification checks actual wasm bytes and pinned hashes, not just existence", async () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "pi-grammar-integrity-")), "test.wasm");
  const bytes = Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]);
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  assert.equal(await verifyGrammar(file, hash), false);
  writeFileSync(file, bytes); assert.equal(await verifyGrammar(file, hash), true);
  writeFileSync(file, Buffer.from([0, 97, 115, 109, 9])); assert.equal(await verifyGrammar(file, hash), false);
  writeFileSync(file, "<!doctype html>"); assert.equal(await verifyGrammar(file, hash), false);
  await assert.rejects(verifyGrammar(file, undefined), /Missing pinned/);
});

test("complete installed grammar set can be verified entirely offline", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("Unexpected network request for complete grammar set"); };
  try {
    const result = await ensurePiLensGrammars(path.resolve("node_modules/pi-lens"));
    assert.equal(result.count, 27); assert.ok(result.totalBytes > 0);
  } finally { globalThis.fetch = previous; }
});

test("distribution preparation and Pi Lens upgrades both require complete verified grammars", () => {
  const pack = readFileSync(new URL("./package-portable.mjs", import.meta.url), "utf8");
  assert.ok(pack.indexOf("await ensurePiLensGrammars") < pack.indexOf('await run("dotnet"'));
  const updates = readFileSync(new URL("../electron/update-manager.ts", import.meta.url), "utf8");
  assert.match(updates, /await ensurePiLensGrammars\(this.store.getEffectivePackagePath\("pi-lens"\)\)/);
});
