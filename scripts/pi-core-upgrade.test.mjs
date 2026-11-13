import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { patchLlamaStatsCancellation } from "./llama-stats-patch.mjs";

const root = process.env.PI_TEST_APP_ROOT || fileURLToPath(new URL("..", import.meta.url));

test("statistics cancellation patch is idempotent and fails closed on unknown source", async () => {
  const source = await readFile(path.join(root, "node_modules/pi-llama-cpp-stats/index.ts"), "utf8");
  assert.match(source, /return reader\.cancel\(reason\)/);
  assert.equal(patchLlamaStatsCancellation(source), source);
  const original = source.replace("return reader.cancel(reason);", "reader.cancel(reason);");
  assert.equal(patchLlamaStatsCancellation(original), source);
  assert.throws(() => patchLlamaStatsCancellation("unknown source"), /no longer matches/);
});

test("Pi 1.5.2 embedded SDK engine loads add-ons, preserves user input, runs tools and aborts", { timeout: 60000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-core-upgrade-smoke-"));
  const agent = path.join(directory, "agent");
  await mkdir(agent);
  await writeFile(path.join(directory, "desktop-state.json"), JSON.stringify({ conversations: [{ id: "upgrade-smoke" }] }), "utf8");
  await writeFile(path.join(directory, "evidence.txt"), "upgrade evidence", "utf8");
  const mcpConfigPath=path.join(agent,"mcp-adapter.json");
  let unusedConnections = 0;
  const unusedResponses = new Set();
  const unusedServer = http.createServer((_req, res) => {
    unusedConnections++;
    unusedResponses.add(res);
    res.once("close", () => unusedResponses.delete(res));
  });
  await new Promise(resolve => unusedServer.listen(0, "127.0.0.1", resolve));
  t.after(() => { unusedServer.closeAllConnections(); unusedServer.close(); });
  const coldMarker = path.join(directory, "unused-stdio-started.txt");
  const usedMarker = path.join(directory, "used-stdio-started.txt");
  const mcpServerPath=path.join(directory,"mcp-fixture.cjs");
  await writeFile(mcpServerPath,`if(process.argv[2])require('node:fs').appendFileSync(process.argv[2],'spawn;');const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};if(m.method==='tools/list')result={tools:[{name:'fixture_ping',description:'Fixture tool',inputSchema:{type:'object',properties:{}}}]};if(m.method==='tools/call')result={content:[{type:'text',text:'fixture-pong'}]};console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));});rl.on('close',()=>process.exit(0));`,'utf8');
  const unusedConfig = {
    unused: {url:`http://127.0.0.1:${unusedServer.address().port}/mcp`,lifecycle:'keep-alive',directTools:false},
    cold: {command:process.execPath,args:[mcpServerPath,coldMarker],lifecycle:'eager',directTools:true},
    fixture: {command:process.execPath,args:[mcpServerPath,usedMarker],lifecycle:'lazy',directTools:false},
  };
  await writeFile(mcpConfigPath,JSON.stringify({mcpServers:unusedConfig}),'utf8');
  const mcpConfig={mcpServers:{...unusedConfig,fixture:{command:process.execPath,args:[mcpServerPath,usedMarker],lifecycle:'lazy',directTools:true}}};
  const mcpDiscoveryCode = `const status=await tools.mcp({});if(status.details.connectedCount!==0)throw new Error('Status connected unused servers');const found=await tools.mcp({search:'no-matches-fixture'});if(!found.details.undiscoveredServers.some(s=>s.name==='cold'))throw new Error('Cold servers not discoverable');const listed=await tools.mcp({server:'fixture'});if(listed.details.error)throw new Error('Scoped discovery failed: '+JSON.stringify(listed));const pong=await tools.mcp({server:'fixture',tool:'fixture_ping',args:{}});if(!JSON.stringify(pong).includes('fixture-pong'))throw new Error('MCP tool did not execute');`;
  const mcpReloadCode=`const cfg=await tools.mcp({action:'config'});if(!cfg.details.desktopConfig.sources.some(s=>s.path===${JSON.stringify(mcpConfigPath)}))throw new Error('Wrong config path');await tools.write({path:${JSON.stringify(mcpConfigPath)},content:${JSON.stringify(JSON.stringify(mcpConfig))}});const connected=await tools.mcp({connect:'fixture'});if(connected.details.error)throw new Error(JSON.stringify(connected));text('MCP-RELOADED:'+JSON.stringify(connected));`;
  const probePath = path.join(directory, "routing-probe.mjs");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF3sAAAAASUVORK5CYII=";
  await writeFile(probePath, `export default pi => {pi.on('tool_call',event=>event.toolName==='comfyui_routing_probe'&&event.input.token==='blocked'?{block:true,reason:'fixture permission denied'}:undefined);pi.registerTool({name:"comfyui_routing_probe",label:"Routing probe",description:"Music and image routing fixture",parameters:{type:"object",properties:{token:{type:"string"}},required:["token"],additionalProperties:false},async execute(id,args){if(args.token==="json")return {content:[{type:"text",text:JSON.stringify({items:[{id:"typed-item"}],nextOffset:null})}],details:{}};if(args.token!=="ok")throw new Error("Invalid call reached executor");return {content:[{type:"text",text:"probe-ok"},{type:"image",data:${JSON.stringify(png)},mimeType:"image/png"}],details:{media:[{type:"audio",path:"C:/fixture.flac",mimeType:"audio/flac"}],audioSelection:true}};}});};`, "utf8");
  const captured = [];
  const messageText = message => typeof message.content === "string" ? message.content
    : message.content?.filter(block => block.type === "text").map(block => block.text).join("\n") ?? "";
  let hangingResponse;
  const server = http.createServer(async (req, res) => {
    // Model/server discovery is separate from chat completions.
    if (req.method !== "POST") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Fixture exposes only chat completions" }));
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    captured.push(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    if (body.messages.some(m => m.role === "user" && messageText(m).endsWith("abort-test"))) {
      hangingResponse = res;
      return;
    }
    if (body.messages.some(m => m.role === "user" && messageText(m).endsWith("mcp-blocked-probe"))) {
      res.end(`data: ${JSON.stringify({ id: "mcp-probe", object: "chat.completion.chunk", choices: [{ index: 0,
        delta: { tool_calls: [{ index: 0, id: "mcp-wait", type: "function", function: { name: "codemode", arguments: JSON.stringify({code:"text(await tools.mcp({connect:'unused'}));"}) } }] }, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    const routing = body.messages.some(m => m.role === "user" && messageText(m).endsWith("routing-test"));
    const routingCalls = body.messages.filter(m => m.role === "tool" && String(m.tool_call_id).startsWith("routing-")).length;
    const code = routingCalls === 0
      ? "text(await describeTool('comfyui_routing_probe')); text(await searchTools('music')); const names=ALL_TOOLS.map(tool=>tool.name); for(const name of names) if(!await describeTool(name)) throw new Error('Missing declaration '+name); text('AUDIT:'+JSON.stringify(names));"
      : "for (const token of ['blocked',42]) { let rejected=false; try { await tools.comfyui_routing_probe({token}); } catch(error) { rejected=true; text(String(error)); } if(!rejected) throw new Error('validation bypass'); } const parsed = await tools.comfyui_routing_probe({token:'json'}); if(parsed.data.items[0].id!=='typed-item' || parsed.data.nextOffset!==null) throw new Error('JSON envelope not normalized'); const result = await tools.comfyui_routing_probe({token:'ok'}); text(result.text); image(result.images[0]);" + mcpDiscoveryCode + mcpReloadCode;
    const delta = routing ? (routingCalls < 2 ? { tool_calls: [{ index: 0, id: `routing-${routingCalls}`, type: "function", function: { name: "codemode", arguments: JSON.stringify({code}) } }] } : {content:"Routed."}) : body.messages.some(m => m.role === "tool")
      ? { content: "Verified." }
      : { reasoning_content: "Verified project X:/KDPI and editor https://tilda.ru/.", tool_calls: [{ index: 0, id: "upgrade-read", type: "function", function: {
        name: "read", arguments: JSON.stringify({ path: path.join(directory, "evidence.txt") }),
      } }] };
    const finish = delta.tool_calls ? "tool_calls" : "stop";
    res.end(`data: ${JSON.stringify({ id: "upgrade", object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: { "upgrade-test": {
    api: "openai-completions", apiKey: "test-only", baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    models: [{ id: "upgrade", name: "Upgrade test", reasoning: false, input: ["text", "image"], contextWindow: 262144, maxTokens: 128,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }), "utf8");
  const extensions = [
    "resources/pi-comfyui/index.ts", "resources/tool-routing/index.js",
    "electron/goal-extension.ts", "electron/plan-extension.ts", "electron/notebook-extension.ts",
    "electron/browser-extension.ts",
    "resources/pi-single-slot-guard/index.js",
    "resources/pi-llama-generation-speed/index.js", "resources/pi-loop-police/index.js",
  ].map(file => path.join(root, process.env.PI_TEST_APP_ROOT && file.startsWith("electron/")
    ? `dist-electron/${file.replace(/\.ts$/, ".js")}` : file));
  extensions.push(probePath);
  const packages=["pi-web-access","pi-tool-repair","pi-mcp-adapter","pi-lens","pi-llama-cpp-stats"].map(name=>path.join(root,"node_modules",name));
  await writeFile(path.join(agent, "settings.json"), JSON.stringify({ packages, extensions,
    defaultProvider: "upgrade-test", defaultModel: "upgrade", defaultThinkingLevel: "off" }), "utf8");
  const child = spawn(process.env.PI_TEST_EXECUTABLE || process.execPath, [path.join(root, 'resources/pi-engine/worker.mjs')], {
    cwd: directory, windowsHide: true, stdio: ["pipe", "pipe", "pipe", "ipc"], env: { ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      ...(process.env.PI_TEST_FORBID_PI_CLI ? {NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import=' + new URL('./fixtures/no-pi-cli.mjs', import.meta.url).href].filter(Boolean).join(' ')} : {}),
      PI_DESKTOP_ENGINE_OPTIONS: JSON.stringify({ agentDir: agent, sessionsDir: path.join(directory, 'sessions'),
        provider: 'upgrade-test', model: 'upgrade', extensions: ['builtin:codemode'], extensionFlags: {'mcp-config': mcpConfigPath} }),
      PI_CODING_AGENT_DIR: agent, PI_DESKTOP_APP_ROOT: root, PI_DESKTOP_DATA_DIR: directory,
      PI_DESKTOP_CONVERSATION_ID: "upgrade-smoke", PI_DESKTOP_GOAL_STATE_FILE: path.join(directory, "desktop-state.json"),
      PI_DESKTOP_TOOL_ROUTING: "1", PI_OFFLINE: "1", NO_UPDATE_NOTIFIER: "1" },
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise(resolve => child.once("exit", resolve));
    child.stdin.end();
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timeout);
  });
  t.after(async () => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(tmpdir()) + path.sep + "pi-core-upgrade-smoke-"));
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const pending = new Map();
  let sequence = 0;
  let buffer = "";
  let stdout = "";
  const events = [];
  child.stdout.on("data", chunk => {
    stdout = `${stdout}${chunk.toString("utf8")}`.slice(-12000);
    buffer += chunk.toString("utf8");
    let end;
    while ((end = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      let message; try { message = JSON.parse(line); } catch { continue; }
      if (message.type !== "response") { events.push(message); continue; }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id); clearTimeout(waiter.timer);
      if (!message.success) waiter.reject(new Error(message.error)); else waiter.resolve(message.data);
    }
  });
  child.on("exit", code => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error(`Pi exited ${code}: ${stderr}\n${stdout}`)); }
    pending.clear();
  });
  const request = (type, args = {}) => new Promise((resolve, reject) => {
    const id = `upgrade-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${type} timeout: ${stderr}`)); }, 20000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, type, ...args })}\n`);
  });
  let state;
  try { state = await request("get_state"); }
  catch (error) {
    for (const name of ["crashes.json", "logs/crashes.json"]) {
      try { t.diagnostic(await readFile(path.join(agent, name), "utf8")); } catch {}
    }
    throw error;
  }
  assert.equal(state.model.id, "upgrade");
  assert.equal(unusedConnections, 0, "Starting Pi must not connect an unused HTTP server");
  assert.equal(existsSync(coldMarker), false, "Starting Pi must not spawn an unused stdio server");
  const inventory = await request("get_extension_state");
  for (const name of ["get_goal", "update_plan", "update_notebook", "browser", "mcp", "media_generate_image", "media_generate_music", "media_texture_3d"]) {
    assert.ok(inventory.tools.some(tool => tool.name === name), `Missing ${name}: ${stderr}`);
  }
  assert.doesNotMatch(stderr, /Failed to load extension|TypeError|SyntaxError/);
  const modelsFile = path.join(agent, "models.json");
  const initialModels = JSON.parse(await readFile(modelsFile, "utf8"));
  const changedModels = structuredClone(initialModels);
  changedModels.providers["upgrade-test"].models[0].id = "replacement-model";
  changedModels.providers["upgrade-test"].models[0].contextWindow = 131072;
  changedModels.desktopModelOverrides = { "upgrade-test": { "replacement-model": { name: "Manual label" } } };
  await writeFile(modelsFile, JSON.stringify(changedModels), "utf8");
  const refreshed = await request("desktop_refresh_models", { provider: "upgrade-test", modelId: "replacement-model" });
  assert.ok(refreshed.models.some(model => model.id === "replacement-model"));
  assert.ok(!refreshed.models.some(model => model.id === "upgrade"));
  assert.equal((await request("get_state")).model.id, "replacement-model");
  assert.equal((await request("get_state")).model.contextWindow, 131072);
  changedModels.providers["upgrade-test"].models = [];
  await writeFile(modelsFile, JSON.stringify(changedModels), "utf8");
  await request("desktop_refresh_models");
  assert.equal((await request("get_state")).model, undefined, "An unavailable model must not survive in the session");
  await writeFile(modelsFile, JSON.stringify(initialModels), "utf8");
  await request("desktop_refresh_models", { provider: "upgrade-test", modelId: "upgrade" });
  const retired=new Set(["tool_search","pi_lens_activate_tools","mcpScript","codemode"]);
  const core=new Set(["read","bash","powershell","edit","write","grep","find","ls","get_goal","create_goal","update_goal","desktop_goal_report","update_plan","update_notebook"]);
  for(const tool of inventory.tools) if(!core.has(tool.name)&&!retired.has(tool.name)) assert.equal(tool.active,false,`Eager addon tool ${tool.name}`);
  const initialHistory = await request("get_messages");
  const firstPromptEventIndex = events.length;
  const accepted = await request("prompt", { message: "Read evidence.txt and verify it." });
  assert.ok(accepted.disposition);
  const deadline = Date.now() + 15000;
  while ((await request("get_state")).isStreaming) {
    assert.ok(Date.now() < deadline, "tool turn did not finish");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(captured.length, 2);
  assert.equal(unusedConnections, 0, "Ordinary user input must not wait for MCP discovery");
  assert.equal(existsSync(coldMarker), false);
  const acknowledged = [...initialHistory.messageIds, ...events.slice(firstPromptEventIndex)
    .filter(event => event.type === "message_end").map(event => event.desktopMessageId)];
  const settledHistory = await request("get_messages", { knownMessageIds: acknowledged });
  assert.equal(settledHistory.startIndex, acknowledged.length, "Finalized event messages must match authoritative RPC history");
  assert.deepEqual(settledHistory.messages, [], "Do not resend unchanged history on settlement");
  assert.equal(captured[0].messages.filter(m => m.role === "user").length, 1);
  assert.ok(captured[0].messages.some(m => ["system", "developer"].includes(m.role)
    && messageText(m).includes("Goals are thread-scoped state")));
  assert.ok(captured[0].messages.some(m => m.role === "user" && messageText(m).endsWith("Read evidence.txt and verify it.")));
  assert.equal(captured[1].messages.filter(m => m.role === "user").length, 1, "service metadata must not invent user turns after tools");
  assert.ok(captured[1].messages.some(m => m.role === "assistant" && m.reasoning_content === "Verified project X:/KDPI and editor https://tilda.ru/."));
  assert.ok(captured[1].messages.some(m => m.role === "tool" && messageText(m).includes("upgrade evidence")),
    JSON.stringify(captured[1].messages.filter(m => m.role === "tool")));
  const schemas = captured[0].tools;
  const names = schemas.map(tool => tool.function?.name);
  assert.ok(names.includes("codemode"));
  const discoveryDescription = schemas.find(tool => tool.function?.name === "codemode").function.description;
  for (const helper of ["searchTools", "describeTool", "describeNamespace"]) assert.ok(discoveryDescription.includes(`text(await ${helper}`));
  assert.ok(discoveryDescription.includes("ALL_TOOLS.map(t => t.name)"));
  for (const name of ["browser", "mcp", "media_generate_image", "media_generate_music", "media_texture_3d", "comfyui_routing_probe", "tool_search", "pi_lens_activate_tools", "mcpScript"]) assert.ok(!names.includes(name), `Eager ${name}`);
  await request("prompt", {message:"routing-test"});
  const routingDeadline = Date.now() + 15000;
  while ((await request("get_state")).isStreaming) {
    assert.ok(Date.now() < routingDeadline, "routing did not finish");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(captured.length, 5);
  const auditText=captured[3].messages.filter(m=>m.role==='tool').map(messageText).join('\n');
  const callable=JSON.parse(auditText.match(/AUDIT:(\[[^\n]*\])/)[1]);
  for(const tool of inventory.tools) if(!retired.has(tool.name)) assert.ok(callable.includes(tool.name),`Addon tool unavailable through codemode: ${tool.name}`);
  t.diagnostic(`Audited ${inventory.tools.length} registered extension tools; ${callable.length} callable tools have on-demand declarations.`);
  for (const body of captured.slice(1)) assert.deepEqual(body.tools, schemas, "Discovery changed schemas");
  for (const [previous,next] of [[captured[2],captured[3]],[captured[3],captured[4]]]) {
    assert.deepEqual(next.messages.slice(0,previous.messages.length),previous.messages,"Tool discovery changed message prefix");
  }
  assert.ok(captured[4].messages.some(m => m.role === "tool" && messageText(m).includes("probe-ok")), JSON.stringify(captured[4].messages));
  assert.ok(captured[4].messages.some(m=>m.role==='tool'&&messageText(m).includes('MCP-RELOADED:')&&messageText(m).includes('fixture_ping')),'MCP configuration reload did not reach the new stdio server: '+captured[4].messages.filter(m=>m.role==='tool').map(messageText).join('\n')+'\n'+stderr);
  assert.ok(events.some(event => event.type === "tool_execution_end" && event.toolName === "comfyui_routing_probe" && event.parentToolCallId === "routing-1"));
  const nestedResults=events.filter(event=>event.type==='tool_execution_end'&&event.toolName==='comfyui_routing_probe');
  assert.equal(nestedResults.filter(event=>event.isError).length,2,"permission or validation bypass");
  assert.ok(JSON.stringify(captured[4]).includes(`data:image/png;base64,${png}`),"codemode image lost");
  assert.equal(unusedConnections, 0, "Using one MCP server must not connect another");
  assert.equal(existsSync(coldMarker), false);
  assert.equal(existsSync(usedMarker), true, "The requested MCP server must really start");
  // A completed run clears its temporary prompt options asynchronously. An
  // immediate continuation hides the bug; exercise the real idle boundary.
  // Lens deliberately consumes its one-shot turn-end advisory on the next
  // run (runtime-context.consumeTurnEndFindings). It is not persisted history;
  // assert the full stable system/user/tool prefix independently of its timing.
  const stableMessages = messages => messages.filter(message => !(message.role === 'user' &&
    typeof message.content === 'string' && message.content.startsWith('[pi-lens automated check — not a user request] ')));
  for (const type of ["desktop_plan_continue", "desktop_goal_continue"]) {
    const previous = captured.at(-1);
    await new Promise(resolve => setTimeout(resolve, 1500));
    await request(type, { message: `<pi_desktop_service_context source="${type === "desktop_plan_continue" ? "plan" : "goal"}">Continue authorized work.</pi_desktop_service_context>` });
    const next = captured.at(-1);
    assert.deepEqual(next.tools, previous.tools, `${type} changed tool schemas`);
    const prefix = stableMessages(previous.messages);
    assert.deepEqual(stableMessages(next.messages).slice(0, prefix.length), prefix, `${type} changed the stable request prefix`);
    assert.ok(messageText(next.messages[0]).includes("Goals are thread-scoped state"));
    assert.ok(messageText(next.messages[0]).includes("For simple tasks, work without a checklist"));
  }
  const history = await request("get_messages");
  assert.ok(JSON.stringify(history).includes("desktopNestedMedia"), "nested media missing from saved parent result");
  await request("prompt", { message: "mcp-blocked-probe" });
  const mcpDeadline = Date.now() + 10000;
  while (!unusedConnections) {
    assert.ok(Date.now() < mcpDeadline, "The requested MCP connection never started");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const mcpAbortStarted = Date.now();
  const connectionsBeforeAbort = unusedConnections;
  await request("abort");
  assert.ok(Date.now() - mcpAbortStarted < 3000, "Stop must not wait for an MCP handshake");
  assert.equal((await request("get_state")).isStreaming, false);
  const closeDeadline = Date.now() + 3000;
  while (unusedResponses.size) {
    assert.ok(Date.now() < closeDeadline, "Cancelled MCP requests must release their HTTP connections");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(unusedConnections, connectionsBeforeAbort, "Cancellation must not start another diagnostic connection");
  await request("prompt", { message: "abort-test" });
  const abortDeadline = Date.now() + 10000;
  while (!hangingResponse) {
    assert.ok(Date.now() < abortDeadline);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.ok((await request("steer", { message: "queued-steer" })).disposition);
  await assert.rejects(request("desktop_refresh_models"), /current operation/);
  assert.ok((await request("follow_up", { message: "queued-follow-up" })).disposition);
  await request("clear_queue");
  const start = Date.now();
  await request("abort");
  assert.ok(Date.now() - start < 3000, "abort waited for provider response");
  assert.equal((await request("get_state")).isStreaming, false);
  await request("clear_queue");
  await writeFile(mcpConfigPath,JSON.stringify({mcpServers:{}}),'utf8');
  await request("reload");
  assert.ok((await request("get_extension_state")).tools.some(tool => tool.name === "update_notebook"));
  assert.doesNotMatch(stderr, /Failed to load extension|TypeError|SyntaxError/);
  const launcher = await readFile(path.join(root, process.env.PI_TEST_APP_ROOT
    ? "dist-electron/electron/pi-rpc-process.js" : "electron/pi-rpc-process.ts"), "utf8");
  assert.doesNotMatch(launcher, /--mode|--approve|cli\.js/);
  assert.match(await readFile(path.join(root, 'resources/pi-engine/worker.mjs'), 'utf8'), /disabledBuiltinExtensions: \["mcp"\]/);
});
