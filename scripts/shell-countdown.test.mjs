import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";

// The renderer imports helpers without an extension, which only a bundler
// understands; Node needs the TypeScript file resolved explicitly, and the
// hooks have to be installed before the module graph is loaded.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && context.parentURL) {
      const base = specifier.replace(/\.js$/, "");
      for (const candidate of [`${base}.ts`, `${base}.tsx`]) {
        const url = new URL(candidate, context.parentURL);
        if (existsSync(url)) return next(url.href, context);
      }
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    const result = next(url, context);
    if (!url.endsWith(".ts")) return result;
    const source = typeof result.source === "string" ? result.source : new TextDecoder().decode(result.source);
    return { ...result, format: "module", source: stripTypeScriptTypes(source, { mode: "transform", sourceUrl: url }) };
  },
});

const { shellTiming, remainingShellSeconds, formatShellSeconds } = await import("../src/shell-timeout.ts");
// setLanguage writes the <html lang> attribute, which the renderer always has.
globalThis.document = { documentElement: {} };
const { getLanguage, setLanguage } = await import("../src/i18n.ts");

test("countdown uses executor timing, including after reconnect, and never runs negative", () => {
  const timing = shellTiming("powershell", {}, { details: { shellTiming: { timeoutSeconds: 1200, startedAt: 1000 } } }, 90000);
  assert.equal(remainingShellSeconds(timing, 91000), 1110);
  assert.equal(remainingShellSeconds(timing, 1201000), 0);
  assert.equal(remainingShellSeconds(timing, 1301000), 0);
  assert.equal(remainingShellSeconds(timing, 0), 1200);
});

test("default and explicit limits are displayed without rewriting unknown old history", () => {
  assert.equal(shellTiming("bash", {}, undefined, 1000).timeoutSeconds, 300);
  assert.equal(shellTiming("powershell", { timeout: 45 }, undefined, 1000).timeoutSeconds, 45);
  assert.equal(shellTiming("bash", {}, undefined, 0, true).timeoutSeconds, 300);
  assert.equal(shellTiming("bash", {}, undefined, 0), undefined);
  assert.equal(shellTiming("read", {}, undefined, 1000), undefined);
  for (const timeout of [0, -1, Infinity, "300"]) assert.equal(shellTiming("bash", { timeout }, undefined, 1000), undefined);
});

test("duration labels cover minutes, hours and fractional explicit limits", () => {
  assert.equal(formatShellSeconds(300), "5:00");
  assert.equal(formatShellSeconds(299), "4:59");
  assert.equal(formatShellSeconds(3601), "1:00:01");
  assert.equal(formatShellSeconds(0), "0:00");
  const previous = getLanguage();
  try {
    // The fractional label is localized: wording and decimal separator.
    setLanguage("en");
    assert.equal(formatShellSeconds(0.25), "0.25 s");
    setLanguage("ru");
    assert.equal(formatShellSeconds(0.25), "0,25 с");
  } finally { setLanguage(previous); }
});
