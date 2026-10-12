import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, constants, mkdtempSync } from "node:fs";
import { readFile, copyFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import os from "node:os";
import { migrateLegacyAdapterConfig, parseMcpConfiguration } from "../shared/mcp-config.ts";
import { atomicStateWrite } from "../electron/atomic-state.ts";

test("legacy adapter options migrate without changing connections or native Pi entries", () => {
  const native = { settings: { requestTimeoutMs: 86400000 }, mcpServers: {
    godot: { url: "http://localhost:8000/mcp", directTools: false },
    computer: { command: "custom", args: ["exact"], env: { KEY: "test-only" }, directTools: true },
    modern: { url: "http://localhost:9000/mcp", exposure: "deferred", timeout: 42 },
  } };
  const original = structuredClone(native);
  const result = migrateLegacyAdapterConfig(native);
  assert.deepEqual(native, original);
  assert.deepEqual(result.adapterConfig.mcpServers.godot, original.mcpServers.godot);
  assert.deepEqual(result.adapterConfig.mcpServers.computer, original.mcpServers.computer);
  assert.deepEqual(result.adapterConfig.settings, original.settings);
  assert.deepEqual(result.nativeConfig, { mcpServers: { modern: original.mcpServers.modern } });
  assert.equal(migrateLegacyAdapterConfig(result.nativeConfig, result.adapterConfig).changed, false);
});

test("existing adapter settings override legacy values and preserve credentials and imports", () => {
  const result = migrateLegacyAdapterConfig({ settings: { requestTimeoutMs: 10, debug: true }, imports: ["cursor"],
    mcpServers: { a: { command: "old", directTools: false, env: { OLD: "keep", SAME: "old" } } } },
  { settings: { requestTimeoutMs: 20 }, imports: ["codex"], mcpServers: { a: { command: "new", directTools: true, env: { SAME: "new" } }, b: { url: "http://localhost" } } });
  assert.equal(result.adapterConfig.settings.requestTimeoutMs, 20);
  assert.equal(result.adapterConfig.settings.debug, true);
  assert.equal(result.adapterConfig.mcpServers.a.command, "new");
  assert.deepEqual(result.adapterConfig.mcpServers.a.env, { OLD: "keep", SAME: "new" });
  assert.deepEqual(result.adapterConfig.imports, ["cursor", "codex"]);
  assert.ok(result.adapterConfig.mcpServers.b);
});

test("JSONC and BOM are supported, malformed structures are rejected before migration", () => {
  assert.deepEqual(parseMcpConfiguration('\uFEFF{/* keep */"mcpServers":{},}'), { mcpServers: {} });
  for (const value of ['[]', '{"mcpServers":[]}', '{"settings":"bad"}', 'broken'])
    assert.throws(() => parseMcpConfiguration(value));
});

const source = readFileSync(new URL("../electron/data-store.ts", import.meta.url), "utf8");
const start = source.indexOf("  private async migrateLegacyAdapterConfiguration()");
const begin = source.indexOf(" {", start) + 2;
const end = source.indexOf("\n  }", begin);
const migrate = new Function("path", "existsSync", "readFile", "copyFile", "constants", "atomicStateWrite", "parseMcpConfiguration", "migrateLegacyAdapterConfig",
  `${stripTypeScriptTypes(`async function migrate() {${source.slice(begin, end)}\n}`)}; return migrate;`)
  (path, existsSync, readFile, copyFile, constants, atomicStateWrite, parseMcpConfiguration, migrateLegacyAdapterConfig);

test("actual startup migration backs up original and is persistent and idempotent", async () => {
  const agentDir = mkdtempSync(path.join(os.tmpdir(), "pi-mcp-layout-"));
  const old = '{"settings":{"requestTimeoutMs":123},"mcpServers":{"godot":{"url":"http://localhost/mcp","directTools":false}}}\n';
  await atomicStateWrite(path.join(agentDir, "mcp.json"), old);
  await migrate.call({ agentDir });
  assert.equal(await readFile(path.join(agentDir, "mcp.json.before-adapter-migration"), "utf8"), old);
  const adapter = await readFile(path.join(agentDir, "mcp-adapter.json"), "utf8");
  assert.equal(JSON.parse(adapter).settings.requestTimeoutMs, 123);
  assert.deepEqual(JSON.parse(await readFile(path.join(agentDir, "mcp.json"), "utf8")), { mcpServers: {} });
  await migrate.call({ agentDir });
  assert.equal(await readFile(path.join(agentDir, "mcp-adapter.json"), "utf8"), adapter);
});

test("fresh install and managed writes use adapter-owned file", () => {
  assert.match(source, /migrateManagedMcpServers\(path.join\(this.agentDir, "mcp-adapter.json"\)\)/);
  assert.match(source, /getMcpDirectToolSelectors\(\)[\s\S]*readFile\(path.join\(this.agentDir, "mcp-adapter.json"\)/);
  assert.ok(existsSync(new URL("../resources/agent-template/mcp-adapter.json", import.meta.url)));
  assert.ok(!existsSync(new URL("../resources/agent-template/mcp.json", import.meta.url)));
});
