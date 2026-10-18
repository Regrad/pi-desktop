// Run with Electron, not node. No app build or ComfyUI/GPU process is needed.
import { app, BrowserWindow } from "electron";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import assert from "node:assert/strict";

registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const source = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(source))) return next(source.href, context);
  }
  return next(specifier, context);
} });
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
void (async () => {
const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-comfy-native-"));
app.setPath("userData", temporary);
const deadline = setTimeout(() => { console.error("Native compiler smoke timed out"); app.exit(1); }, 45_000);
let mutations = 0;
const server = http.createServer((req, res) => {
  if (req.url === "/scripts/app.js") {
    res.setHeader("Content-Type", "application/javascript");
    return res.end(`let workflow; export const app = {
      graph: {}, canvas: {},
      async loadGraphData(value, clean, restore, name, options) {
        if (value.hang) await new Promise(() => {});
        if (value.fail) throw Error('Missing custom node');
        workflow = value;
        // The compiler must block writes even if a frontend extension tries one.
        await fetch('/userdata/unwanted', {method:'POST',body:'should not be written'}).catch(() => {});
        return true;
      },
      async graphToPrompt() { return {output:{'1':{class_type:'SaveAny',inputs:{text:workflow.nodes[0].text}}}}; }
    };`);
  }
  if (req.method !== "GET") { mutations++; res.statusCode = 500; return res.end(); }
  res.setHeader("Content-Type", "text/html"); res.end("<!doctype html><html><body>Comfy export fixture</body></html>");
});
let compiler;
try {
  await app.whenReady();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const { DEFAULT_COMFY_SETTINGS } = await import("../shared/comfy.ts");
  await writeFile(path.join(temporary, "comfyui.json"), JSON.stringify({ ...DEFAULT_COMFY_SETTINGS, enabled: true, url }));
  const { ComfyWorkflowCompiler } = await import("../electron/comfy-workflow-compiler.ts");
  compiler = new ComfyWorkflowCompiler(temporary);
  const workflow = { nodes: [{ text: "literal </script> with 'quotes'" }] };
  const before = JSON.stringify(workflow);
  const result = await compiler.compile("success", workflow);
  assert.equal(result["1"].inputs.text, workflow.nodes[0].text);
  assert.equal(JSON.stringify(workflow), before);
  assert.equal(mutations, 0);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  await assert.rejects(compiler.compile("failure", { nodes: [], fail: true }), /Missing custom node/);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  const early = compiler.compile("early-cancel", { nodes: [], hang: true });
  compiler.cancel("early-cancel");
  await assert.rejects(early, /отменён/);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  const pooled = ["pool-a", "pool-b"].map(owner => ({ owner, waiting: compiler.compile(owner, { nodes: [], hang: true }) }));
  const failures = pooled.map(item => assert.rejects(item.waiting, /отменён/));
  while (BrowserWindow.getAllWindows().length < 2) await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(compiler.compile("pool-full", workflow), /Два экспорта/);
  pooled.forEach(item => compiler.cancel(item.owner));
  await Promise.all(failures);
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  const waiting = compiler.compile("cancel", { nodes: [], hang: true });
  const rejected = assert.rejects(waiting, /отменён/);
  while (!BrowserWindow.getAllWindows().length) await new Promise(resolve => setTimeout(resolve, 10));
  compiler.cancel("cancel");
  await rejected;
  assert.equal(BrowserWindow.getAllWindows().length, 0);
  const settings = JSON.parse(await readFile(path.join(temporary, "comfyui.json"), "utf8"));
  assert.equal(settings.url, url);
  compiler.close();
  await assert.rejects(compiler.compile("closed", workflow), /остановлен/);
  console.log("PASS: real Electron export, literal data, errors, early/active cancellation, bounded two-page pool, write blocking and zero leftover windows; no generation or build.");
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  clearTimeout(deadline);
  compiler?.close();
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  // Electron releases its user-data handles at exit; remove what is unlocked now.
  await rm(temporary, { recursive: true, force: true }).catch(() => {});
  app.exit(process.exitCode ?? 0);
}
})().catch(error => { console.error(error); app.exit(1); });
