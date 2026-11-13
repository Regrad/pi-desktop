// Node-only Pi Desktop boundary: validation is always active; private capture
// is opt-in and never writes authorization headers or changes the model input.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const key = Symbol.for("pi-desktop/request-diagnostics/v1");
const state = globalThis[key] ??= { context: new AsyncLocalStorage() };
const visible = value => typeof value === "string" && /[^\s\u200B-\u200D\u2060\uFEFF]/u.test(value);
function hasInput(content) {
  return visible(content) || (Array.isArray(content) && content.some(part =>
    part?.type === "text" ? visible(part.text)
      : part?.type === "image_url" ? visible(part.image_url?.url)
        : part?.type === "input_audio" ? visible(part.input_audio?.data)
          : part?.type === "file" && (visible(part.file?.file_id) || visible(part.file?.file_data))));
}

export function assertDesktopRequest(params) {
  const reject = message => {
    const context = state.context.getStore();
    if (context) context.guardError = message;
    throw new Error(message);
  };
  if (!params || !Array.isArray(params.messages) || !params.messages.length)
    reject("Pi Desktop: empty model request blocked (no messages).");
  const users = params.messages.filter(message => message?.role === "user");
  if (!users.length || users.some(message => !hasInput(message.content)))
    reject("Pi Desktop: empty model request blocked (missing or blank user input). History was not sent.");
}

function configuration() {
  if (process.env.PI_DESKTOP_REQUEST_TRACE_DIR)
    return { directory: path.resolve(process.env.PI_DESKTOP_REQUEST_TRACE_DIR), maximumRequests: 64 };
  try {
    const config = JSON.parse(readFileSync(process.env.PI_DESKTOP_REQUEST_TRACE_CONFIG
      || "C:/AI_Temp/pi-desktop-request-trace.json", "utf8"));
    if (config.enabled === true && path.isAbsolute(config.directory)
      && Date.parse(config.expiresAt) > Date.now()) return config;
  } catch { /* No opt-in file: normal operation has no capture. */ }
}

const json = value => JSON.stringify(value, null, 2) + "\n";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const safeUrl = input => { const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url); return url.origin + url.pathname; };

// Installed before add-ons wrap fetch, so their final body changes (including
// timings_per_token) are captured too. AsyncLocalStorage isolates concurrent
// responses and keeps the request ID out of model messages and HTTP headers.
if (!state.installed) {
  state.installed = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const trace = state.context.getStore();
    if (!trace || !safeUrl(input).endsWith("/chat/completions")) return originalFetch(input, init);
    const requestBytes = input instanceof Request
      ? Buffer.from(await new Request(input, init).arrayBuffer())
      : typeof init?.body === "string" || init?.body instanceof Uint8Array ? Buffer.from(init.body)
        : undefined;
    if (!requestBytes) throw new Error("Pi Desktop capture: unsupported HTTP body; no request was sent.");
    // Repeat validation at the actual transport boundary, after fetch wrappers.
    assertDesktopRequest(JSON.parse(requestBytes.toString("utf8")));
    if (!trace.directory) return originalFetch(input, init);
    const number = ++trace.attempt;
    const directory = path.join(trace.directory, `http-${String(number).padStart(2, "0")}`);
    await mkdir(directory);
    await writeFile(path.join(directory, "request.body.json"), requestBytes, { flag: "wx" });
    const meta = { requestId: trace.id, startedAt: new Date().toISOString(), url: safeUrl(input),
      requestBytes: requestBytes.length, requestSha256: digest(requestBytes), complete: false };
    await writeFile(path.join(directory, "transport.json"), json(meta));
    let response;
    try { response = await originalFetch(input, init); }
    catch (error) {
      await writeFile(path.join(directory, "transport.json"), json({ ...meta, error: String(error), endedAt: new Date().toISOString() }));
      throw error;
    }
    meta.status = response.status;
    meta.contentType = response.headers.get("content-type");
    if (!response.body) {
      await writeFile(path.join(directory, "transport.json"), json({ ...meta, complete: true, responseBytes: 0 }));
      return response;
    }
    const file = await open(path.join(directory, "response.body.raw"), "wx");
    const reader = response.body.getReader(), hash = createHash("sha256");
    let size = 0, ended = false;
    const finish = async (complete, error) => {
      if (ended) return; ended = true;
      await file.close();
      await writeFile(path.join(directory, "transport.json"), json({ ...meta, complete,
        responseBytes: size, responseSha256: hash.digest("hex"), endedAt: new Date().toISOString(),
        ...(error ? { error: String(error) } : {}) }));
    };
    const body = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { await finish(true); controller.close(); return; }
          // FileHandle.write may perform a partial write; writeFile completes it.
          await file.writeFile(value); hash.update(value); size += value.byteLength;
          controller.enqueue(value);
        } catch (error) {
          await reader.cancel(error).catch(() => {});
          await finish(false, error); controller.error(error);
        }
      },
      async cancel(reason) { try { await reader.cancel(reason); } finally { await finish(false, reason || "cancelled"); } },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export function desktopRequestDiagnostics(model, options) {
  const config = configuration();
  let trace;
  return {
    async run(callback) {
      if (!config) return state.context.run({}, callback);
      await mkdir(config.directory, { recursive: true });
      const count = (await readdir(config.directory)).filter(name => name.startsWith("request-")).length;
      const maximum = Number.isSafeInteger(config.maximumRequests) && config.maximumRequests > 0 ? config.maximumRequests : 32;
      if (count >= maximum) return state.context.run({}, callback);
      const id = randomUUID(), directory = path.join(config.directory, `request-${Date.now()}-${id}`);
      await mkdir(directory);
      trace = { id, directory, attempt: 0 };
      await writeFile(path.join(directory, "identity.json"), json({ requestId: id, startedAt: new Date().toISOString(),
        conversationId: process.env.PI_DESKTOP_CONVERSATION_ID, sessionId: options?.sessionId,
        provider: model.provider, model: model.id, capture: "fetch body and response bytes; SDK assembled output; no authorization headers" }));
      return state.context.run(trace, callback);
    },
    async finish(output) {
      // The OpenAI transport wraps local fetch errors as "Connection error".
      // Retain the actual local validation failure instead of suggesting a
      // network fault or provoking an agent-level connection retry.
      const guardError = state.context.getStore()?.guardError;
      if (guardError && output.stopReason === "error") output.errorMessage = guardError;
      if (trace) await writeFile(path.join(trace.directory, "sdk-output.json"), json(output));
    },
  };
}
