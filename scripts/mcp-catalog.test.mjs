import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import http from "node:http";
import { mcpCatalog, catalogText, searchCatalog, catalogContext } from "../resources/pi-mcp/catalog.js";
import { desktopMcpDescription, withDeferredServers } from "../resources/pi-mcp/desktop-config.js";
import { projectDesktopServiceContext } from "../resources/pi-rpc-bridge/service-context.js";
import { routeTool } from "../resources/tool-routing/index.js";

const config = { mcpServers: {
  workstation: { command: "PRIVATE_EXECUTABLE", args: ["SECRET"], env: { TOKEN: "PRIVATE" },
    description: "Control desktop applications: screen screenshots, mouse clicks and keyboard input." },
  editor: { url: "http://user:secret@localhost/mcp?token=private", description: "Use the Blender application to create 3D models." },
  unknown: { command: "DoNotInferCapabilitiesFromThis" },
  disabled: { disabled: true, description: "Disabled keyboard server" },
  disabledToo: { enabled: false, description: "Disabled screen server" },
} };

test("cold catalog uses configured purposes, omits disabled servers and never guesses from transport", () => {
  let reads = 0;
  const servers = mcpCatalog(config, () => { reads++; return undefined; });
  assert.equal(reads, 1, "tool metadata needed only for the unknown purpose");
  assert.deepEqual(servers.map(entry => entry.name), ["editor", "unknown", "workstation"]);
  assert.equal(servers[1].source, "unknown");
  assert.doesNotMatch(JSON.stringify(servers), /SECRET|PRIVATE|localhost|token=|DoNotInfer/);
  assert.equal(searchCatalog(servers, "keyboard")[0].name, "workstation");
  assert.equal(searchCatalog(servers, "3D models")[0].name, "editor");
  assert.deepEqual(searchCatalog(servers, "nonexistent"), []);
  assert.equal(searchCatalog(servers, "SCREEN|KEYBOARD", { regex: true }).length, 1);
  assert.deepEqual(searchCatalog(servers, "[", { regex: true }), []);
  const learned = mcpCatalog({ mcpServers: { unknown: {} } }, () => [{ name: "echo", description: "Read fixture status" }]);
  assert.equal(learned[0].source, "discovery"); assert.match(learned[0].description, /Read fixture/);
});

test("overview stays bounded while omitted server descriptions remain searchable", () => {
  const servers = mcpCatalog({ mcpServers: Object.fromEntries(Array.from({ length: 100 }, (_, i) =>
    [`server-${String(i).padStart(3, "0")}`, { description: `Special capability ${i} ${"x".repeat(300)}` }])) });
  const overview = catalogText(servers);
  assert.ok(overview.length <= 3000);
  assert.match(overview, /more configured servers/);
  assert.doesNotMatch(overview, /server-099/);
  assert.equal(searchCatalog(servers, "server-099")[0].name, "server-099");
});

test("saved capabilities obey native configuration, TTL and privacy validation", async () => {
  const { createJiti } = await import("../vendor/pi/packages/coding-agent/dist/core/extensions/jiti-loader.js");
  const { computeServerHash, isServerCacheValid } = await createJiti(import.meta.url, { fsCache: false }).import(path.resolve("node_modules/pi-mcp-adapter/metadata-cache.ts"));
  const definition = { command: "fixture", args: ["one"] };
  const entry = { configHash: computeServerHash(definition), cachedAt: Date.now(), tools: [{ name: "known", description: "Read fixture status" }] };
  const catalog = (cached, configured = definition) => mcpCatalog({ mcpServers: { fixture: configured } },
    (_name, server) => isServerCacheValid(cached, server) ? cached.tools : undefined);
  assert.equal(catalog(entry)[0].source, "discovery");
  for (const invalid of [{ ...entry, cacheScope: "private" }, { ...entry, ttlMs: 0 },
    { ...entry, ttlMs: 1, cachedAt: 1 }, { ...entry, discoveryFailed: true }])
    assert.equal(catalog(invalid)[0].source, "unknown");
  assert.equal(catalog(entry, { ...definition, args: ["changed"] })[0].source, "unknown");
});

test("gateway search returns matching server records, not fake callable tools or irrelevant servers", () => {
  const original = { content: [{ type: "text", text: "No discovered tools" }], details: { matches: [] } };
  const state = { config, toolMetadata: new Map() };
  const result = withDeferredServers(original, state, { search: "keyboard" });
  assert.deepEqual(result.details.matches, []);
  assert.deepEqual(result.details.serverMatches.map(entry => entry.name), ["workstation"]);
  assert.deepEqual(result.details.undiscoveredServers.map(entry => entry.name), ["workstation"]);
  assert.doesNotMatch(JSON.stringify(result), /editor|unknown|SECRET|PRIVATE/);
  assert.equal(withDeferredServers(original, state, { search: "nonexistent" }), original);
});

test("catalog metadata is append-only, survives deferred persistence and refreshes after compaction", () => {
  const sent = [], pi = { sendMessage(message, options) { sent.push(message); assert.equal(options.triggerTurn, false); } };
  const history = [{ role: "user", content: "hello", timestamp: 1 }];
  const servers = mcpCatalog(config);
  const first = catalogContext(history, servers, pi);
  assert.equal(catalogContext(first, servers, pi), first);
  assert.equal(sent.length, 1);
  assert.equal(history.length, 1);
  assert.match(first.at(-1).content, /keyboard/);
  const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 2 };
  assert.deepEqual(projectDesktopServiceContext([...history, assistant, sent[0]]),
    projectDesktopServiceContext([...first, assistant]));
  const nextUser = { role: "user", content: "next", timestamp: 3 };
  const changed = catalogContext([...first, assistant, nextUser], mcpCatalog({ mcpServers: {} }), pi);
  assert.deepEqual(changed.slice(0, first.length), first);
  assert.equal(sent.length, 2);
  const compacted = [{ role: "compactionSummary", summary: "earlier chat", timestamp: 4 }];
  assert.equal(catalogContext(compacted, servers, pi).length, 2);
});

test("native codemode finds the deferred MCP gateway by cold server capabilities", async () => {
  const { executeCodemode } = await import("../vendor/pi/packages/coding-agent/dist/extensions/codemode/execute.js");
  const previous = process.env.PI_DESKTOP_TOOL_ROUTING; process.env.PI_DESKTOP_TOOL_ROUTING = "1";
  try {
    const servers = mcpCatalog(config);
    const gateway = routeTool({ name: "mcp", description: desktopMcpDescription + "\n" + catalogText(servers),
      namespace: { name: "MCP", description: catalogText(servers, 64000) },
      parameters: { type: "object", properties: {} }, execute() { assert.fail("discovery must not call the gateway"); } }, "pi-mcp-adapter");
    const result = await executeCodemode("cold-discovery", { code: `text({
      keyboard: await searchTools("keyboard"), mouse: await searchTools("mouse"),
      inventory: ALL_TOOLS.filter(tool => /keyboard/.test(tool.description)).map(tool => tool.name)
    });` }, undefined, undefined, { tools: [gateway], sessionManager: { getBranch: () => [] } }, { getToolNamespace: () => gateway.namespace });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const output = JSON.parse(result.content.filter(block => block.type === "text").map(block => block.text).join("\n").split("Output:\n")[1]);
    for (const key of ["keyboard", "mouse"]) assert.equal(output[key][0].name, "mcp");
    assert.deepEqual(output.inventory, ["mcp"]);
  } finally { if (previous === undefined) delete process.env.PI_DESKTOP_TOOL_ROUTING; else process.env.PI_DESKTOP_TOOL_ROUTING = previous; }
});

test("real Pi cold discovery connects only the selected server and preserves HTTP request prefixes", { timeout: 60000 }, async () => {
  const code = stripTypeScriptTypes(readFileSync("electron/pi-rpc-process.ts", "utf8"), { mode: "transform" });
  const { PiRpcProcess } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  mkdirSync("C:/AI_Temp", { recursive: true });
  const dir = mkdtempSync("C:/AI_Temp/pi-mcp-catalog-"), agentDir = path.join(dir, "agent"); mkdirSync(agentDir);
  const marker = path.join(dir, "started.jsonl"), fixture = path.join(dir, "server.mjs");
  const sdk = relative => pathToFileURL(path.resolve("node_modules/@modelcontextprotocol/sdk/dist/esm", relative)).href;
  writeFileSync(fixture, `import { appendFileSync } from "node:fs";
    import { McpServer } from ${JSON.stringify(sdk("server/mcp.js"))};
    import { StdioServerTransport } from ${JSON.stringify(sdk("server/stdio.js"))};
    appendFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv[2])+"\\n");
    const server = new McpServer({name:"catalog-fixture",version:"1.0.0"});
    server.registerTool("status", {description:"Read harmless fixture status"}, async () => ({content:[{type:"text",text:"fixture-ready"}]}));
    await server.connect(new StdioServerTransport());`);
  const definition = (name, description) => ({ command: process.execPath, args: [fixture, name], description, directTools: false, lifecycle: "lazy" });
  const configFile = path.join(agentDir, "mcp-adapter.json");
  const mcpConfig = { mcpServers: {
    workstation: { ...definition("workstation", "Control desktop applications: screen screenshots, mouse clicks and keyboard input."), directTools: true },
    editor: definition("editor", "Use the Blender application to create 3D models."),
  } };
  writeFileSync(configFile, JSON.stringify(mcpConfig));
  writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [path.resolve("node_modules/pi-mcp-adapter")] }));
  const stateFile = path.join(dir, "state.json");
  writeFileSync(stateFile, JSON.stringify({ conversations: [{ id: "chat", access: { mode: "full", phase: "idle", revision: 0 } }] }));
  const actions = [
    'text(await searchTools("keyboard")); text(ALL_TOOLS.filter(t=>/mouse/.test(t.description)).map(t=>t.name));',
    'text(await tools.mcp({search:"keyboard"}));',
    'text(await tools.mcp({server:"workstation"}));',
    'text(await tools.mcp({server:"workstation",tool:"status",args:{}}));',
  ];
  const captured = [], events = [];
  let action = 0, settled;
  const server = http.createServer(async (req, res) => {
    const bytes = []; for await (const chunk of req) bytes.push(chunk);
    const body = JSON.parse(Buffer.concat(bytes).toString("utf8")); captured.push(body);
    if (action <= 2) assert.equal(existsSync(marker), false, "cold inventory and global search must not launch servers");
    const command = actions[action++];
    const choice = command ? { delta: { role: "assistant", tool_calls: [{ index: 0, id: `catalog-${action}`, type: "function",
      function: { name: "codemode", arguments: JSON.stringify({ code: command }) } }] }, finish_reason: "tool_calls" }
      : { delta: { role: "assistant", content: "Done." }, finish_reason: "stop" };
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, ...choice }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "catalog-test": {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "test-only",
    models: [{ id: "test", name: "test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }],
  } } }));
  const rpc = new PiRpcProcess({ executablePath: process.execPath, enginePath: path.resolve("resources/pi-engine/worker.mjs"),
    cwd: dir, agentDir, sessionsDir: path.join(dir, "sessions"), sessionId: "chat", appRoot: process.cwd(),
    provider: "catalog-test", model: "test", goalStatePath: stateFile, planningExtensionPath: path.resolve("electron/planning-extension.ts"),
    mcpEntryPath: "unused", mcpDirectTools: [], onEvent(event) { events.push(event); if (event.type === "agent_settled") settled?.(); }, onExtensionUi() {}, onExit() {} });
  const prompt = async message => {
    const finished = new Promise(resolve => { settled = resolve; });
    await rpc.request("prompt", { message }, 15000); await finished;
  };
  try {
    await rpc.start(); assert.equal(existsSync(marker), false);
    await prompt("Find computer input capabilities, discover only workstation, then read its fixture status.");
    assert.equal(captured.length, 5);
    assert.match(JSON.stringify(captured[0].messages), /keyboard input/);
    assert.match(JSON.stringify(captured[1].messages.at(-1)), /mcp/);
    assert.match(JSON.stringify(captured[2].messages.at(-1)), /serverMatches/);
    assert.match(JSON.stringify(captured[2].messages.at(-1)), /workstation/);
    assert.match(JSON.stringify(captured[4].messages.at(-1)), /fixture-ready/);
    assert.deepEqual(readFileSync(marker, "utf8").trim().split("\n").map(JSON.parse), ["workstation"]);
    for (let i = 1; i < captured.length; i++) {
      assert.deepEqual(captured[i].tools, captured[0].tools);
      assert.deepEqual(captured[i].messages.slice(0, captured[i - 1].messages.length), captured[i - 1].messages);
    }
    assert.equal(events.some(event => event.type === "extension_error"), false, JSON.stringify(events.filter(e => e.type === "extension_error")));
    const history = await rpc.request("get_entries");
    assert.equal(history.entries.filter(entry => entry.type === "custom_message" && entry.customType === "desktop_mcp_catalog_state").length, 1);
    mcpConfig.mcpServers.editor.disabled = true;
    mcpConfig.mcpServers.workstation.description += " Updated configuration.";
    writeFileSync(configFile, JSON.stringify(mcpConfig));
    action = 4; actions[4] = 'text(await tools.mcp({connect:"workstation"}));';
    const before = captured.at(-1);
    await prompt("Reread the changed configuration for workstation only.");
    assert.deepEqual(captured.at(-1).tools, before.tools);
    assert.deepEqual(captured.at(-1).messages.slice(0, before.messages.length), before.messages);
    const refreshed = await rpc.request("get_entries");
    const catalogs = refreshed.entries.filter(entry => entry.type === "custom_message" && entry.customType === "desktop_mcp_catalog_state");
    assert.equal(catalogs.length, 2);
    assert.doesNotMatch(catalogs.at(-1).content, /"editor"/);
    assert.ok(readFileSync(marker, "utf8").trim().split("\n").every(line => JSON.parse(line) === "workstation"));
  } finally { await rpc.stop(); await new Promise(resolve => server.close(resolve)); }
});
