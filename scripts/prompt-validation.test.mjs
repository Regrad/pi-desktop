import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
function method(name, args, result) {
  const start = source.indexOf(`\n  async ${name}(`);
  const signature = `): Promise<${result}> {`;
  const begin = source.indexOf(signature, start) + signature.length;
  const end = source.indexOf("\n  }", begin);
  assert.ok(start >= 0 && begin > start && end > begin);
  return new Function(`${stripTypeScriptTypes(`async function invoke(${args}) {${source.slice(begin, end)}\n}`)}; return invoke;`)();
}

test("empty sends fail before runtime startup or service-context injection", async () => {
  const send = method("sendPrompt", "conversationId, message, attachments", "void");
  const host = { ensureRuntime() { throw Error("Must not start runtime"); } };
  for (const content of ["", " \n\t", null])
    await assert.rejects(send.call(host, "chat", content, []), /Сообщение не может быть пустым/);
});

test("empty queued messages cannot persist a future service-only request", async () => {
  const queue = method("queuePrompt", "conversationId, message, attachments, requestPlan", "QueuedPrompt[]");
  const host = { store: { queuePrompt() { throw Error("Must not write empty input"); } } };
  await assert.rejects(queue.call(host, "chat", "  ", []), /Сообщение не может быть пустым/);
  let captured;
  host.store.queuePrompt = async (...args) => { captured = args; return []; };
  host.syncQueuedPrompts = () => {};
  await queue.call(host, "chat", "", [{ path: "C:/fixture.png" }], false);
  assert.equal(captured[1], "", "attachment-only requests remain valid");
});
