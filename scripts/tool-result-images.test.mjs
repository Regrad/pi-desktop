import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import http from "node:http";
import { patchToolResultImages } from "./tool-result-images-patch.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentPackage = pathToFileURL(path.join(root, "node_modules/@earendil-works/pi-coding-agent/package.json")).href;
const providerRoot = process.env.PI_TEST_PROVIDER_ROOT || path.dirname(findPackageJSON("@earendil-works/pi-ai", agentPackage));
const providerPath = path.join(providerRoot, "dist/api/openai-completions.js");
const { convertMessages, stream } = await import(pathToFileURL(providerPath));
const { normalizeContext } = await import(pathToFileURL(path.join(providerRoot, "dist/utils/transcript.js")));
const model = {
  id: "qwen3.8-flash-next-ud-q4-k-xl", name: "Test", provider: "llama-cpp",
  api: "openai-completions", input: ["text", "image"], reasoning: true,
  contextWindow: 262144, maxTokens: 32,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
};
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF3sAAAAASUVORK5CYII=";
const image = (data = png, mimeType = "image/png") => ({ type: "image", data, mimeType });
const text = (value) => ({ type: "text", text: value });
const user = { role: "user", content: [text("Finish the requested edit."), image()], timestamp: 1 };
const assistant = (ids, override = {}) => ({
  role: "assistant", provider: model.provider, api: model.api, model: model.id,
  content: [{ type: "thinking", thinking: "Inspect the tool outputs next.", thinkingSignature: "reasoning_content" },
    ...ids.map(id => ({ type: "toolCall", id, name: "desktop_show_image", arguments: {} }))],
  stopReason: "toolUse", timestamp: 2, ...override,
});
const result = (id, content, override = {}) => ({ role: "toolResult", toolCallId: id, toolName: "desktop_show_image", content, isError: false, timestamp: 3, ...override });
const context = (messages) => normalizeContext({ systemPrompt: "Use tool results as evidence.", messages, tools: [] });
const convert = (messages, selected = model, compat = {}) => convertMessages(selected, context(messages), compat);
const url = (data = png, mimeType = "image/png") => `data:${mimeType};base64,${data}`;
const body = (message) => typeof message.content === "string" ? message.content : message.content.filter(b => b.type === "text").map(b => b.text).join("\n");

test("tool image belongs to its tool_call_id without a synthetic user turn", () => {
  const out = convert([user, assistant(["a"]), result("a", [text("Generated image."), image()])]);
  assert.deepEqual(out.map(m => m.role), ["system", "user", "assistant", "tool"]);
  assert.equal(out.at(-1).tool_call_id, "a");
  assert.deepEqual(out.at(-1).content, [{ type: "text", text: "Generated image." }, { type: "image_url", image_url: { url: url() } }]);
  assert.equal(out[2].reasoning_content, "Inspect the tool outputs next.");
});

test("parallel tool results keep separate image ownership and order", () => {
  const out = convert([user, assistant(["mask", "preview", "bash"]),
    result("mask", [text("Mask"), image("MASK"), image("MASK2")]),
    result("preview", [text("Preview"), image("PREVIEW", "image/webp")]),
    result("bash", [text("ok")], { toolName: "bash" })]);
  const tools = out.filter(m => m.role === "tool");
  assert.deepEqual(tools.map(m => m.tool_call_id), ["mask", "preview", "bash"]);
  assert.deepEqual(tools[0].content.slice(1).map(b => b.image_url.url), [url("MASK"), url("MASK2")]);
  assert.equal(tools[1].content[1].image_url.url, url("PREVIEW", "image/webp"));
  assert.equal(tools[2].content, "ok");
  assert.equal(out.filter(m => m.role === "user").length, 1);
});

test("image-only and failed results preserve placeholder and media", () => {
  for (const isError of [false, true]) {
    const out = convert([user, assistant(["a"]), result("a", [image()], { isError })]);
    assert.equal(body(out.at(-1)), "(see attached image)");
    assert.equal(out.at(-1).content[1].image_url.url, url());
  }
});

test("real user attachments and subsequent messages remain untouched", () => {
  const next = { role: "user", content: [text("Attached image(s) from tool result:"), image("USER")], timestamp: 4 };
  const out = convert([user, assistant(["a"]), result("a", [image()]), next]);
  assert.equal(out.filter(m => m.role === "user").length, 2);
  assert.equal(out.at(-1).role, "user");
  assert.equal(out.at(-1).content[1].image_url.url, url("USER"));
  assert.equal(body(out.at(-1)), "Attached image(s) from tool result:");
});

test("source history is not mutated by repeated conversion", () => {
  const history = [user, assistant(["a"]), result("a", [text("Done"), image()])];
  const saved = structuredClone(history);
  assert.deepEqual(convert(history), convert(history));
  assert.deepEqual(history, saved);
});

test("text-only tools keep their original format", () => {
  const out = convert([user, assistant(["a"]), result("a", [text("ok")])]);
  assert.equal(out.at(-1).content, "ok");
});

test("non-vision llama model still receives the Pi omission placeholder", () => {
  const out = convert([user, assistant(["a"]), result("a", [image()])], { ...model, input: ["text"] });
  assert.equal(out.filter(m => m.role === "user").length, 1);
  assert.equal(out.at(-1).content, "(tool image omitted: model does not support images)");
});

test("other providers retain their existing supported image transport", () => {
  const out = convert([user, assistant(["a"]), result("a", [image()])], { ...model, provider: "openai" });
  assert.equal(out.at(-2).role, "tool");
  assert.equal(typeof out.at(-2).content, "string");
  assert.equal(out.at(-1).role, "user");
  assert.equal(body(out.at(-1)), "Attached image(s) from tool result:");
});

test("required tool name survives multimodal conversion", () => {
  const out = convert([user, assistant(["a"]), result("a", [image()])], model, { requiresToolResultName: true });
  assert.equal(out.at(-1).name, "desktop_show_image");
});

test("assistant bridge before a real user still works", () => {
  const next = { role: "user", content: "Continue", timestamp: 4 };
  const out = convert([user, assistant(["a"]), result("a", [image()]), next], model, { requiresAssistantAfterToolResult: true });
  assert.equal(out.at(-3).role, "tool");
  assert.equal(out.at(-2).role, "assistant");
  assert.equal(out.at(-1).content, "Continue");
});

test("compatibility patch is idempotent and refuses unknown upstream code", async () => {
  const source = await readFile(providerPath, "utf8");
  assert.equal(patchToolResultImages(source), source);
  assert.equal(patchToolResultImages(source.replace(/\r?\n/g, "\r\n")), source.replace(/\r?\n/g, "\r\n"));
  assert.throws(() => patchToolResultImages("changed upstream"), /no longer matches/);
});

test("actual HTTP request preserves image in tool result through the SDK", async () => {
  let captured;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    captured = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end('data: {"id":"test","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const output = await stream({ ...model, baseUrl: `http://127.0.0.1:${server.address().port}/v1` },
      context([user, assistant(["a"]), result("a", [text("Result"), image()])]),
      { apiKey: "test", maxTokens: 1 }).result();
    assert.notEqual(output.stopReason, "error", output.errorMessage);
    assert.equal(captured.messages.filter(m => m.role === "user").length, 1);
    assert.equal(captured.messages.at(-1).role, "tool");
    assert.equal(captured.messages.at(-1).tool_call_id, "a");
    assert.equal(captured.messages.at(-1).content[1].image_url.url, url());
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("existing latest chat replays without image-generated user turns", { skip: !process.env.PI_TEST_TOOL_IMAGES_HISTORY }, async () => {
  const data = path.join(root, "release/Pi Desktop/data");
  const state = JSON.parse(await readFile(path.join(data, "desktop-state.json"), "utf8"));
  const chat = state.conversations.find(c => c.id === state.activeConversationId);
  const entries = (await readFile(path.join(data, chat.sessionFile), "utf8")).trim().split("\n").map(JSON.parse);
  const messages = entries.filter(e => e.message && ["user", "assistant", "toolResult"].includes(e.message.role)).map(e => e.message);
  const saved = structuredClone(messages);
  const out = convert(messages);
  assert.equal(out.filter(m => m.role === "user").length, messages.filter(m => m.role === "user").length);
  assert.ok(out.some(m => m.role === "tool" && Array.isArray(m.content) && m.content.some(b => b.type === "image_url")));
  assert.deepEqual(messages, saved);
});

test("local llama template puts each image inside its tool response, not a new user request", { skip: !process.env.PI_TEST_TOOL_IMAGES_LIVE }, async () => {
  // /apply-template formats the request; no inference or Comfy job is started.
  const settings = JSON.parse(await readFile(path.join(root, "release/Pi Desktop/data/agent/models.json"), "utf8"));
  const provider = settings.providers["llama-cpp"];
  const messages = convert([user, assistant(["a", "b"]), result("a", [text("First tool result"), image()]), result("b", [text("Second tool result"), image()])]);
  const response = await fetch(provider.baseUrl.replace(/\/v1\/?$/, "") + "/apply-template", {
    method: "POST", headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messages, add_generation_prompt: true }), signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200);
  const { prompt } = await response.json();
  assert.equal((prompt.match(/<tool_response>/g) || []).length, 2);
  const responses = [...prompt.matchAll(/<tool_response>([\s\S]*?)<\/tool_response>/g)].map(m => m[1]);
  assert.match(responses[0], /First tool result/);
  assert.match(responses[1], /Second tool result/);
  for (const content of responses) assert.match(content, /<__media_|<\|vision_start\|>/);
  assert.equal((prompt.match(/Finish the requested edit\./g) || []).length, 1);
  assert.doesNotMatch(prompt, /Attached image\(s\) from tool result/);
});
