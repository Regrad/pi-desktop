import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
const source = readFileSync(new URL("../electron/browser-automation.ts", import.meta.url), "utf8");
const body = source.slice(source.indexOf("  async page():"), source.indexOf("  private async connect():"));
const code = stripTypeScriptTypes(body.replace("async page()", "async function page()"));
const page = new Function(`${code};return page;`)();
test("late failed browser connection cannot disconnect its replacement", async () => {
  let rejectOld, resolveNew, count = 0;
  const old = new Promise((_, reject) => { rejectOld = reject; });
  const next = new Promise(resolve => { resolveNew = resolve; });
  const instance = { generation: 0, connection: undefined,
    connect: () => count++ === 0 ? old : next,
    disconnect() { this.generation++; this.connection = undefined; },
  };
  const first = page.call(instance);
  instance.disconnect();
  const second = page.call(instance);
  rejectOld(new Error("cancelled"));
  await assert.rejects(first, /cancelled/);
  assert.equal(instance.generation, 1);
  assert.ok(instance.connection);
  resolveNew("replacement page");
  assert.equal(await second, "replacement page");
});
