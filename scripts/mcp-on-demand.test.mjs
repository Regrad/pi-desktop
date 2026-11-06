import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { patchMcpOnDemandIndex, patchMcpOnDemandInit, patchMcpOnDemandManager } from "../resources/pi-mcp/on-demand-patch.js";
import { withDeferredServers } from "../resources/pi-mcp/desktop-config.js";

test("on-demand patches are pinned and idempotent; generated TypeScript remains valid", () => {
  for (const [file, patch] of [["index.ts", patchMcpOnDemandIndex], ["init.ts", patchMcpOnDemandInit], ["server-manager.ts", patchMcpOnDemandManager]]) {
    const source = readFileSync(new URL(`../node_modules/pi-mcp-adapter/${file}`, import.meta.url), "utf8");
    assert.equal(patch(source), source);
    assert.throws(() => patch("unknown upstream"), /Unsupported/);
    assert.doesNotThrow(() => stripTypeScriptTypes(source, { mode: "transform" }));
  }
});

test("ordinary session startup and user input cannot initiate or await server connections", () => {
  const source = readFileSync(new URL("../node_modules/pi-mcp-adapter/index.ts", import.meta.url), "utf8");
  const hook = source.slice(source.indexOf('pi.on("session_start"'), source.indexOf("// Other extensions can reactivate"));
  assert.doesNotMatch(hook, /startInitialization|ensureSessionRuntime|offerPiSignInImports|await initialization/);
  assert.doesNotMatch(source, /^\s*startLoadTimeInitialization\(\);/m);
  assert.doesNotMatch(source, /pi\.on\("input"/);
  assert.match(source, /connectAndReport\(proxyState, requestedServer, signal, _ctx\)/);
  assert.match(source, /onProjectTrustResolved: markStarted/);
});

test("cached search exposes undiscovered servers as metadata, without inventing tools or exposing credentials", () => {
  const state = { config: { mcpServers: {
    cached: { url: "http://localhost/mcp" },
    wanted: { url: "http://secret@example/mcp", description: "Game editor", args: ["private"] },
    disabled: { disabled: true },
  } }, toolMetadata: new Map([["cached", [{ name: "cached_tool" }]]]) };
  const original = { content: [{ type: "text", text: "Search results" }], details: { matches: [] } };
  const result = withDeferredServers(original, state);
  assert.deepEqual(result.details.undiscoveredServers, [{ name: "wanted", description: "Game editor" }]);
  assert.match(result.content.at(-1).text, /mcp\(\{server: "NAME"\}\)/);
  assert.doesNotMatch(JSON.stringify(result), /secret|private/);
  assert.equal(original.content.length, 1);
  state.toolMetadata.set("wanted", []);
  assert.equal(withDeferredServers(original, state), original);
});

test("keep-alive begins after a requested connection, not during cold discovery", () => {
  const source = readFileSync(new URL("../node_modules/pi-mcp-adapter/init.ts", import.meta.url), "utf8");
  const init = source.slice(0, source.indexOf("export function markKeepAliveAfterConnect"));
  assert.doesNotMatch(init, /lifecycle\.markKeepAlive\(name/);
  assert.doesNotMatch(init, /direct-tools-bootstrap/);
  assert.match(init, /return false; \/\/ Metadata discovery never connects unrelated servers/);
  assert.match(source, /\["keep-alive", "eager", "lazy-keep-alive"\]\.includes/);
});
