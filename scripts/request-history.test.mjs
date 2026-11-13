import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire, findPackageJSON } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";

const root = fileURLToPath(new URL("..", import.meta.url));
const app = process.env.PI_TEST_APP_ROOT || root;
const agent = path.join(app, "node_modules/@earendil-works/pi-coding-agent");
const agentPackage = pathToFileURL(path.join(agent, "package.json")).href;
const ai = path.dirname(findPackageJSON("@earendil-works/pi-ai", agentPackage));
const core = path.dirname(findPackageJSON("@earendil-works/pi-agent-core", agentPackage));
const { stream } = await import(pathToFileURL(path.join(ai, "dist/api/openai-completions.js")));
const { normalizeContext } = await import(pathToFileURL(path.join(ai, "dist/utils/transcript.js")));
const { convertToLlm } = await import(pathToFileURL(path.join(agent, "dist/core/messages.js")));
const { buildSessionContext } = await import(pathToFileURL(path.join(agent, "dist/core/session-manager.js")));
const { runAgentLoop } = await import(pathToFileURL(path.join(core, "dist/agent-loop.js")));
const { Type } = createRequire(path.join(app, "package.json"))("typebox");
const model = { id: "qwen3.8-flash-next-ud-q4-k-xl", name: "Request history test", provider: "llama-cpp",
  api: "openai-completions", input: ["text", "image"], reasoning: true, contextWindow: 262144, maxTokens: 128,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: false,
    thinkingFormat: "chat-template", chatTemplateKwargs: { enable_thinking: true, preserve_thinking: true, reasoning_effort: "medium" } } };

function desktop(t) {
  const previous = process.env.PI_DESKTOP_CONVERSATION_ID;
  process.env.PI_DESKTOP_CONVERSATION_ID = "request-history-test";
  t.after(() => { if (previous === undefined) delete process.env.PI_DESKTOP_CONVERSATION_ID; else process.env.PI_DESKTOP_CONVERSATION_ID = previous; });
}

async function endpoint(t, reply) {
  const captured = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    captured.push(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", choices: [{ index: 0, ...reply(captured.length - 1) }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { captured, selected: { ...model, baseUrl: `http://127.0.0.1:${server.address().port}/v1` } };
}

test("actual agent loop and HTTP provider keep one user message across consecutive tool calls", { timeout: 15000 }, async t => {
  desktop(t);
  const { captured, selected } = await endpoint(t, index => index < 3 ? {
    delta: { reasoning_content: `Evidence step ${index}`, tool_calls: [{ index: 0, id: `probe-${index}`, type: "function", function: { name: "probe", arguments: JSON.stringify({ index }) } }] }, finish_reason: "tool_calls",
  } : { delta: { content: "Done" }, finish_reason: "stop" });
  let calls = 0;
  const tool = { name: "probe", label: "Probe", description: "Return verified test data", parameters: Type.Object({ index: Type.Integer() }),
    async execute(_id, args) { calls++; return { content: [{ type: "text", text: `Verified step ${args.index}` }], details: {} }; } };
  const messages = await runAgentLoop([{ role: "system", content: "Complete the user task using tool evidence.", timestamp: 0 },
    { role: "user", content: [{ type: "text", text: "Сделай картинку лошади с цветами на голове." }], timestamp: 1 }], { messages: [], tools: [tool] },
    { model: selected, apiKey: "test", convertToLlm,
      transformContext(history) {
        return history.some(m => m.role === "toolResult") ? [...history, { role: "custom", customType: "desktop_notebook_limit_state",
          content: "Notebook character limit: 12000. Not a user request.", display: false, timestamp: 2 }] : history;
      } }, () => {}, AbortSignal.timeout(10000), (m, c, options) => stream(m, c, { ...options, apiKey: "test", maxTokens: 128 }));
  assert.equal(calls, 3); assert.equal(captured.length, 4);
  for (const [index, request] of captured.entries()) {
    assert.equal(request.messages.filter(m => m.role === "user").length, 1, `Request ${index}`);
    assert.equal(request.messages.filter(m => m.role === "tool").length, index);
    if (index) assert.equal(request.messages.at(-1).role, "tool");
    for (let prior = 0; prior < index; prior++) {
      assert.equal(request.messages.find(m => m.tool_calls?.[0]?.id === `probe-${prior}`).reasoning_content, `Evidence step ${prior}`);
      assert.equal(request.messages.filter(m => m.tool_call_id === `probe-${prior}`).length, 1);
    }
  }
  assert.equal(messages.filter(m => m.role === "user").length, 1);
});

test("latest saved chat is replayed at every real response boundary through actual HTTP conversion", {
  skip: !process.env.PI_TEST_REQUEST_HISTORY_DATA, timeout: 20000,
}, async t => {
  desktop(t);
  const data = path.resolve(process.env.PI_TEST_REQUEST_HISTORY_DATA);
  const state = JSON.parse(await readFile(path.join(data, "desktop-state.json"), "utf8"));
  const chat = state.conversations.find(c => c.id === state.activeConversationId);
  assert.ok(chat?.sessionFile);
  const entries = (await readFile(path.join(data, chat.sessionFile), "utf8")).trim().split("\n").map(JSON.parse);
  const { captured, selected } = await endpoint(t, () => ({ delta: { content: "Replay verified" }, finish_reason: "stop" }));
  const userEntries = entries.filter(e => e.message?.role === "user");
  assert.ok(userEntries.length);
  let boundaries = 0;
  for (const entry of entries.filter(e => e.message?.role === "assistant")) {
    const index = entries.indexOf(entry);
    // A partial parallel batch isn't an actual request boundary: the SDK would
    // synthesize "No result provided" for its unfinished calls. Replay only
    // prefixes at which the stored agent really started another response.
    const prefix = entries.slice(0, index), last = prefix.findLast(e => e.id);
    const history = buildSessionContext(prefix, last.id).messages;
    const before = structuredClone(history);
    const output = await stream(selected, normalizeContext({ messages: convertToLlm(history) }), { apiKey: "test", maxTokens: 1 }).result();
    assert.notEqual(output.stopReason, "error", output.errorMessage);
    const wire = captured.at(-1).messages;
    const expectedUsers = prefix.filter(e => e.message?.role === "user");
    assert.equal(wire.filter(m => m.role === "user").length, expectedUsers.length, entry.id);
    const expectedTools = prefix.filter(e => e.message?.role === "toolResult");
    const actualTools = wire.filter(m => m.role === "tool");
    assert.equal(actualTools.length, expectedTools.length, entry.id);
    for (const tool of expectedTools)
      assert.equal(actualTools.filter(m => m.tool_call_id === tool.message.toolCallId).length, 1, tool.id);
    assert.ok(!actualTools.some(m => m.content === "No result provided"), entry.id);
    for (const assistant of prefix.filter(e => e.message?.role === "assistant")) {
      const call = assistant.message.content?.find(p => p.type === "toolCall");
      if (!call) continue;
      const prior = wire.find(m => m.tool_calls?.some(c => c.id === call.id));
      assert.ok(prior, assistant.id);
      const thinking = assistant.message.content.filter(p => p.type === "thinking").map(p => p.thinking).join("\n");
      if (thinking) assert.equal(prior.reasoning_content, thinking, assistant.id);
    }
    assert.deepEqual(history, before);
    boundaries++;
  }
  assert.ok(boundaries);
  t.diagnostic(`${boundaries} response boundaries replayed from ${chat.id}; original user messages: ${userEntries.length}. No requests sent to the model server.`);
});
