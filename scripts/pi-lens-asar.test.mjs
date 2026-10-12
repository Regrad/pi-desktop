import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createPackage } from "@electron/asar";
import path from "node:path";
import { pathToFileURL } from "node:url";

test("real Electron loads, forks and cancels the analyzer from an ASAR archive", async t => {
  // This packages only an analyzer fixture; it never compiles or replaces Pi Desktop.
  const repo = process.cwd();
  const dir = await mkdtemp(path.join(repo, ".lens-asar-test-"));
  assert.ok(path.resolve(dir).startsWith(path.resolve(repo) + path.sep + ".lens-asar-test-"));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const input = path.join(dir, "input");
  await cp(path.join(repo, "node_modules/pi-lens"), input, { recursive: true });
  const archive = path.join(dir, "analysis.asar");
  await createPackage(input, archive);
  const file = path.join(dir, "Проверка & cache.ts");
  const content = "export function example() { return 42; }\n";
  await writeFile(file, content, "utf8");
  const clientUrl = pathToFileURL(path.join(archive, "dist/clients/tree-sitter-client.js")).href;
  const code = `
    const {TreeSitterClient}=await import(${JSON.stringify(clientUrl)});
    const c=new TreeSitterClient();
    const q={id:'asar-test',query:'(function_declaration name: (identifier) @NAME)',metavars:['NAME']};
    const found=await c.runQueryOnFile(q,${JSON.stringify(file)},'typescript');
    if(found.length!==1 || found[0].captures.NAME!=='example') throw Error('ASAR analysis mismatch');
    await globalThis[Symbol.for('pi.desktop.cancel.native.analysis')]();
    console.log('ASAR_ANALYSIS_OK');
  `;
  const result = spawnSync(path.join(repo, "node_modules/electron/dist/electron.exe"), ["--input-type=module", "-e", code], {
    windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", PI_LENS_TEST_MODE: "1" }, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, JSON.stringify({ error: result.error?.message, stdout: result.stdout, stderr: result.stderr }));
  assert.match(result.stdout, /ASAR_ANALYSIS_OK/);
});
