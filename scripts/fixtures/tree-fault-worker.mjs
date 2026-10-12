import { registerHooks } from "node:module";
// Fault injection is local to this disposable test process. The installed
// analyzer and the user's files are never rewritten.
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith("/clients/tree-sitter-client.js")) return result;
  const anchor = "for (const match of batch.query.matches(rootNode)) {";
  const source = String(result.source);
  if (source.split(anchor).length !== 2) throw new Error("Test injection anchor changed");
  return { ...result, source: source.replace(anchor, `
    if (queryDefs.some(q => q.id === "inject-block")) {
      const until = Date.now() + 10000; while (Date.now() < until) {}
    }
    if (queryDefs.some(q => q.id === "inject-abort")) {
      const error = new Error("Aborted(test WASM runtime fault)");
      this.reportWasmAbort(error); throw error;
    }
    ${anchor}`) };
} });
await import("../../node_modules/pi-lens/dist/desktop-analysis/analysis-worker.mjs");
