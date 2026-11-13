import test from "node:test";
import assert from "node:assert/strict";
import { shellTiming, remainingShellSeconds, formatShellSeconds } from "../src/shell-timeout.ts";

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
  assert.equal(formatShellSeconds(0.25), "0,25 с");
});
