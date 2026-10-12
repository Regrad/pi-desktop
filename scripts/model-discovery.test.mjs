import test from "node:test";
import assert from "node:assert/strict";
import { discoverProvider } from "../electron/model-server-discovery.ts";
test("invalid required models response produces a diagnostic, not an undefined property crash", async () => {
  const original = globalThis.fetch;
  try {
    for (const value of [null, [], "wrong"]) {
      globalThis.fetch = async () => new Response(JSON.stringify(value), { status: 200 });
      await assert.rejects(discoverProvider({ address: "http://localhost:1234", port: "" }), /Ожидался JSON-объект/);
    }
  } finally { globalThis.fetch = original; }
});
