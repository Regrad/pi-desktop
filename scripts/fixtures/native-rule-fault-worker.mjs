import { registerHooks } from "node:module";

// Inject one rule's real rejection path in a disposable executor only.
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith("/dispatch/runners/ast-grep-napi.js")) return result;
  const anchor = "found = preflight.findAll(nativeConfig, maxMatchesPerRule - collected.length);";
  const source = String(result.source);
  if (source.split(anchor).length !== 2) throw new Error("Native fault test anchor changed");
  return { ...result, source: source.replace(anchor,
    'if (options.content?.includes("INJECT_RULE_FAULT") && rule.id === "express-jwt-hardcoded-secret-javascript") throw new Error("injected native rejection");\n' + anchor) };
} });
await import("../../node_modules/pi-lens/dist/desktop-analysis/analysis-worker.mjs");
