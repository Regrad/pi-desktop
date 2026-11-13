// Read-only replay audit. /apply-template does not infer; --infer explicitly runs short controls.
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const root = process.cwd(), data = path.join(root, "release/Pi Desktop/data"), app = path.join(root, "release/Pi Desktop/resources/app");
const state = JSON.parse(await fs.readFile(path.join(data, "desktop-state.json"), "utf8"));
const requestedChat = process.argv.find(arg => arg.startsWith("--chat="))?.slice(7) ?? state.activeConversationId;
const chat = state.conversations.find(c => c.id === requestedChat);
assert.ok(chat?.sessionFile, "Requested conversation has no session file");
const sourceSession = await fs.readFile(path.join(data, chat.sessionFile), "utf8");
const entries = sourceSession.trim().split("\n").map(JSON.parse);
const exportArgument = process.argv.find(arg => arg.startsWith("--export-to="))?.slice(12);
const exportDir = exportArgument ? path.resolve(exportArgument) : undefined;
const exported = [];
if (exportDir) {
  await fs.mkdir(path.dirname(exportDir), { recursive: true });
  await fs.mkdir(exportDir, { recursive: false });
}
async function saveExport(filename, value) {
  if (!exportDir) return;
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n";
  assert.ok(!provider.apiKey || !body.includes(provider.apiKey), "Credential detected in export");
  const target = path.join(exportDir, filename);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body, { encoding: "utf8", flag: "wx" });
  exported.push({ file: filename, bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex") });
}
const providers = JSON.parse(await fs.readFile(path.join(data, "agent/models.json"), "utf8")).providers;
const provider = providers[chat.provider ?? "llama-cpp"];
const configured = provider.models.find(m => m.id === (chat.model ?? entries.find(e => e.type === "model_change")?.modelId));
const base = provider.baseUrl.replace(/\/v1\/?$/, "");
const headers = { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" };
async function api(route, payload) {
  const response = await fetch(base + route, { headers, ...(payload ? { method: "POST", body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(45000) });
  if (!response.ok) throw Error(`${route}: HTTP ${response.status}: ${(await response.text()).slice(0,500)}`);
  return response.json();
}
const agent = path.join(app, "node_modules/@earendil-works/pi-coding-agent"), agentPackage = pathToFileURL(path.join(agent, "package.json")).href;
const ai = path.dirname(findPackageJSON("@earendil-works/pi-ai", agentPackage));
const { stream } = await import(pathToFileURL(path.join(ai, "dist/api/openai-completions.js")));
const { normalizeContext } = await import(pathToFileURL(path.join(ai, "dist/utils/transcript.js")));
const { buildSessionContext } = await import(pathToFileURL(path.join(agent, "dist/core/session-manager.js")));
const { convertToLlm } = await import(pathToFileURL(path.join(agent, "dist/core/messages.js")));
process.env.PI_DESKTOP_CONVERSATION_ID = chat.id;
const model = { ...configured, provider: "llama-cpp", api: "openai-completions", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { ...provider.compat, ...configured.compat, chatTemplateKwargs: { enable_thinking: true, preserve_thinking: true, reasoning_effort: "medium" } } };
let captured;
const mock = http.createServer(async (req, res) => {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  captured = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end('data: {"id":"audit","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
});
await new Promise(resolve => mock.listen(0, "127.0.0.1", resolve));
try {
  const firstError = entries.find(e => e.message?.role === "toolResult" && e.message.isError);
  assert.ok(firstError, "Saved chat needs a tool error");
  let firstPayload, secondErrorPayload, secondErrorPrompt;
  const boundaries = [];
  const props = await api("/props");
  console.log(JSON.stringify({ serverModel: props.model_alias, build: props.build_info, chat: chat.id }));
  for (const entry of entries.filter(e => e.message?.role === "toolResult")) {
    const prefix = entries.slice(0, entries.indexOf(entry) + 1);
    const history = buildSessionContext(prefix, entry.id).messages;
    const output = await stream({ ...model, baseUrl: `http://127.0.0.1:${mock.address().port}/v1` }, normalizeContext({ messages: convertToLlm(history) }), { apiKey: "test", maxTokens: 1 }).result();
    assert.notEqual(output.stopReason, "error", output.errorMessage);
    const body = structuredClone(captured);
    const formatted = await api("/apply-template", { messages: body.messages, tools: body.tools, chat_template_kwargs: body.chat_template_kwargs, add_generation_prompt: true });
    const prompt = formatted.prompt;
    const stem = `${String(boundaries.length + 1).padStart(2, "0")}-after-${entry.id}${entry.message.isError ? "-error" : "-ok"}`;
    await saveExport(`reconstructed/${stem}.json`, body);
    await saveExport(`rendered/${stem}.prompt.txt`, prompt);
    boundaries.push({ entryId: entry.id, timestamp: entry.timestamp, isError: Boolean(entry.message.isError), request: `reconstructed/${stem}.json`, rendered: `rendered/${stem}.prompt.txt` });
    assert.equal(typeof prompt, "string");
    const userText = history.find(m => m.role === "user").content[0].text;
    const userCopies = prompt.split(userText).length - 1;
    assert.equal(userCopies, 1);
    const thoughts = body.messages.filter(m => m.role === "assistant" && m.reasoning_content);
    for (const message of thoughts) assert.ok(prompt.includes(message.reasoning_content.trim()), "Server dropped reasoning_content");
    assert.ok(prompt.endsWith("<|im_start|>assistant\n<think>\n"));
    console.log(JSON.stringify({ boundary: entry.id, isError: Boolean(entry.message.isError), userCopies, reasoningBlocks: thoughts.length,
      toolResponses: (prompt.match(/<tool_response>/g) ?? []).length, ordinaryUserHeaders: (prompt.match(/<\|im_start\|>user/g) ?? []).length,
      tail: prompt.slice(-240) }));
    if (entry.id === firstError.id) firstPayload = body;
    if (entry.message.isError && entry.id !== firstError.id && !secondErrorPayload) { secondErrorPayload = body; secondErrorPrompt = prompt; }
  }
  if (exportDir) {
    assert.ok(firstPayload && secondErrorPayload && secondErrorPrompt, "Two tool errors are required for the control bundle");
    const cases = [];
    const makeControl = payload => {
      const body = { ...structuredClone(payload), model: configured.id, stream: false, max_tokens: 192, temperature: 0, seed: 42, cache_prompt: true };
      delete body.stream_options;
      return body;
    };
    async function control(name, payload, description, endpoint = "/v1/chat/completions") {
      const filename = `controls/${name}.json`;
      await saveExport(filename, payload);
      cases.push({ name, file: filename, endpoint, description });
    }
    await control("01-original-error", makeControl(firstPayload), "First tool error, before the model first claimed the user repeated the request. That initial false claim was not consistently reproduced.");
    const firstSuccess = makeControl(firstPayload);
    firstSuccess.messages.at(-1).content = "Script completed\nWall time 0.0 seconds\nOutput:\nNo matching workflows found.";
    await control("02-success-control", firstSuccess, "Only the last error result is replaced with a successful empty catalog result.");
    await control("03-second-error-with-claim", makeControl(secondErrorPayload), "Contains the model's earlier false claim; server replay repeated it.");
    const withoutClaim = makeControl(secondErrorPayload);
    let removedClaims = 0;
    for (const message of withoutClaim.messages) if (typeof message.reasoning_content === "string" && message.reasoning_content.includes("The user repeated the request. ")) {
      message.reasoning_content = message.reasoning_content.replace("The user repeated the request. ", ""); removedClaims++;
    }
    assert.equal(removedClaims, 1);
    await control("04-second-error-without-claim", withoutClaim, "Exactly one false sentence removed from assistant reasoning; replay instead invented that the session context had been wiped.");
    for (const seed of [42, 43]) await control(`05-first-error-temperature1-seed${seed}`, { ...makeControl(firstPayload), temperature: 1, seed }, "First error, stochastic control: neither previous test reproduced the initial false repetition claim.");
    const secondSuccess = makeControl(secondErrorPayload);
    secondSuccess.messages.at(-1).content = "Script completed\nWall time 0.0 seconds\nOutput:\nNo matching workflows found.";
    await control("06-second-success-with-claim", secondSuccess, "Keeps earlier false reasoning but replaces the final error with success; replay still claimed the user repeated the request.");
    await control("07-raw-completion-with-claim", { prompt: secondErrorPrompt, n_predict: 192, temperature: 0, seed: 42, cache_prompt: true, stream: false, stop: ["<|im_end|>"] }, "Raw completion bypassing Chat Completions conversion; replay repeated the false claim.", "/completion");
    await saveExport("source-session.jsonl", sourceSession);
    await saveExport("server-snapshot.json", { capturedAt: new Date().toISOString(), alias: props.model_alias, path: props.model_path, build: props.build_info,
      capabilities: props.chat_template_caps, speculative: props.default_generation_settings?.params?.["speculative.types"], template: props.chat_template });
    await saveExport("README.txt", `Экспорт проблемного чата Pi Desktop: ${chat.id}\n${chat.title}\n\nВАЖНО: это восстановленные запросы для реплея, а НЕ сетевой лог исходного прогона.\nИстория, аргументы, результаты и reasoning_content восстановлены из source-session.jsonl и преобразованы установленным SDK.\nПрименён текущий преобразователь служебного контекста. Использованы текущие настройки модели, preserve_thinking=true и reasoning_effort=medium.\nИсторические runtime-переопределения системного промпта и before_provider_request не были записаны: их побайтовая идентичность исходному запросу не гарантируется.\n\nreconstructed/: тела, перехваченные при локальном SDK-реплее каждой границы инструмента; max_tokens=1, stream=true.\nrendered/: результат /apply-template текущего сервера для каждого восстановленного тела.\ncontrols/: готовые тела контрольных запросов, совпадающие по способу построения с выполненными тестами: максимум 192 токена, stream=false, seed=42, temperature=0, кроме явно отмеченных вариантов.\nДля controls/07-* используется /completion, для остальных — /v1/chat/completions.\nЗаменять надо только адрес сервера; Authorization задаётся отдельно. Ключи API и заголовки в экспорт не включены.\n\nПример PowerShell для одного контрольного запроса:\n$headers = @{ Authorization = "Bearer $env:LLAMA_API_KEY" }\n$body = [System.IO.File]::ReadAllText((Resolve-Path '.\\controls\\03-second-error-with-claim.json'))\nInvoke-RestMethod -Uri "$env:LLAMA_BASE_URL/v1/chat/completions" -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) | ConvertTo-Json -Depth 100\n\nНе исполняйте tool_calls из ответа: тестируетcя текст модели, а не реальные инструменты. Не запускайте все варианты одновременно: на сервере один слот.\nПервопричина первой ложной фразы не установлена. Доказан механизм её закрепления; ожидаемые наблюдения приведены в manifest.json, но не выдаются за новые результаты тестов.\nПри экспорте генерация не запускается; используются локальный ответ-заглушка SDK и /props, /apply-template.\n`);
    await saveExport("manifest.json", { format: 1, exportedAt: new Date().toISOString(), chatId: chat.id, title: chat.title,
      provenance: "Post-hoc reconstruction, not historical HTTP capture", historicalRuntimeSystemPromptCaptured: false, historicalProviderHookOutputCaptured: false,
      sessionSha256: createHash("sha256").update(sourceSession).digest("hex"), sdk: { agent: JSON.parse(await fs.readFile(path.join(agent, "package.json"), "utf8")).version,
        ai: JSON.parse(await fs.readFile(path.join(ai, "package.json"), "utf8")).version }, boundaries, cases, files: structuredClone(exported) });
    console.log(`EXPORTED ${exported.length} files to ${exportDir}; no inference performed by export.`);
  }
  if (process.argv.includes("--infer") || process.argv.includes("--snowball")) {
    const variants = process.argv.includes("--snowball") ? ["second-error-with-claim", "second-error-without-claim", "first-error-seed42", "first-error-seed43"] : ["original-error", "success-control"];
    for (const variant of variants) {
      const slots = await api("/slots");
      if (slots.some(s => s.is_processing)) throw Error("Model server became busy; inference audit stopped");
      const body = structuredClone(variant.startsWith("second-error") ? secondErrorPayload : firstPayload);
      if (variant === "success-control") body.messages.at(-1).content = "Script completed\nWall time 0.0 seconds\nOutput:\nNo matching workflows found.";
      if (variant === "second-error-without-claim") for (const message of body.messages) {
        if (typeof message.reasoning_content === "string") message.reasoning_content = message.reasoning_content.replace("The user repeated the request. ", "");
      }
      const result = await api("/v1/chat/completions", { ...body, model: configured.id, stream: false, stream_options: undefined,
        max_tokens: 192, temperature: variant.startsWith("first-error-seed") ? 1 : 0, seed: variant.endsWith("seed43") ? 43 : 42, cache_prompt: true });
      const message = result.choices?.[0]?.message;
      console.log(JSON.stringify({ variant, finish: result.choices?.[0]?.finish_reason, reasoning: message?.reasoning_content, content: message?.content, toolCalls: message?.tool_calls, usage: result.usage }));
    }
  }
  if (process.argv.includes("--raw-control")) {
    if ((await api("/slots")).some(s => s.is_processing)) throw Error("Model server became busy");
    const raw = await api("/completion", { prompt: secondErrorPrompt, n_predict: 192, temperature: 0, seed: 42, cache_prompt: true, stream: false,
      stop: ["<|im_end|>"] });
    console.log(JSON.stringify({ variant: "raw-completion-with-claim", content: raw.content, predicted: raw.tokens_predicted }));
    if ((await api("/slots")).some(s => s.is_processing)) throw Error("Model server became busy");
    const body = structuredClone(secondErrorPayload);
    body.messages.at(-1).content = "Script completed\nWall time 0.0 seconds\nOutput:\nNo matching workflows found.";
    const success = await api("/v1/chat/completions", { ...body, model: configured.id, stream: false, stream_options: undefined, max_tokens: 192,
      temperature: 0, seed: 42, cache_prompt: true });
    console.log(JSON.stringify({ variant: "second-success-with-claim", reasoning: success.choices?.[0]?.message?.reasoning_content, content: success.choices?.[0]?.message?.content }));
  }
} finally { mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); }
