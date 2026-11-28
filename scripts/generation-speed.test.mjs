import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as immediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import http from "node:http";
const { default: speedAddon, SlotSpeedWindow } = await import(process.env.PI_TEST_APP_ROOT
  ? pathToFileURL(path.join(process.env.PI_TEST_APP_ROOT, "resources/pi-llama-generation-speed/index.js"))
  : new URL("../resources/pi-llama-generation-speed/index.js", import.meta.url));

const slot = (tokens, task = 7, extra = {}) => [{ id: 0, id_task: task, is_processing: true, next_token: [{ n_decoded: tokens }], ...extra }];
const chunk = (content, extra = {}) => ({ choices: [{ delta: { content }, finish_reason: null }], ...extra });
const final = { choices: [{ delta: {}, finish_reason: "stop" }], timings: { predicted_n: 100, predicted_ms: 2000, predicted_per_second: 50 } };
const wire = value => `data: ${JSON.stringify(value)}\n\n`;
const settle = async () => { for (let i = 0; i < 5; i++) await immediate(); };

function harness(t, slots = () => slot(10), capabilities = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saved = globalThis.fetch, hooks = new Map(), statuses = [], working = [], posts = [], gets = [], metrics = [], streams = [], metadata = [];
  globalThis.fetch = async (url, init) => {
    if (init?.method !== "POST" && /\/(models|props)$/.test(String(url))) {
      metadata.push({ url: String(url), init });
      if (capabilities.fail) throw new Error("Metadata unavailable");
      return String(url).endsWith("/models")
        ? json({ data: [{ id: "fixture-model", owned_by: capabilities.owner ?? "other" }] })
        : json({ build_info: capabilities.version ?? "0.29.0 (fixture)" });
    }
    if (String(url).endsWith("/metrics")) {
      metrics.push({ url: String(url), init });
      // Absent by default: stock llama.cpp has no such route and must not be polled.
      return capabilities.metrics === undefined
        ? new Response("missing", { status: 404 })
        : capabilities.metrics(metrics.length, init);
    }
    if (String(url).endsWith("/slots")) {
      gets.push({ url: String(url), init });
      return slots(gets.length, init);
    }
    posts.push({ url, init });
    const stream = { bytes: "", controller: undefined };
    streams.push(stream);
    const response = new Response(new ReadableStream({ start(controller) { stream.controller = controller; } }), { headers: { "content-type": "text/event-stream" } });
    return capabilities.headers ? capabilities.headers(response) : response;
  };
  const mockFetch = globalThis.fetch;
  speedAddon({ on: (name, fn) => hooks.set(name, fn) });
  const ctx = { hasUI: true, ui: {
    setStatus: (key, text) => statuses.push({ key, text }),
    setWorkingMessage: text => working.push(text),
  } };
  const start = () => hooks.get("before_agent_start")({}, ctx);
  hooks.get("session_start")({}, ctx); start();
  t.after(() => {
    hooks.get("session_shutdown")();
    assert.equal(globalThis.fetch, mockFetch);
    globalThis.fetch = saved;
    for (const stream of streams) { try { stream.controller.close(); } catch {} }
  });
  return {
    hooks, ctx, statuses, working, posts, gets, metrics, streams, start, metadata,
    async open(signal, fields = {}) {
      const response = await fetch("http://server:8181/proxy/v1/chat/completions", { method: "POST", signal,
        headers: { Authorization: "Bearer fixture-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "unchanged input" }], ...fields }) });
      const stream = streams.at(-1);
      stream.read = response.text();
      return stream;
    },
    emit(stream, value) { const text = wire(value); stream.bytes += text; stream.controller.enqueue(new TextEncoder().encode(text)); },
    async tick(ms) { t.mock.timers.tick(ms); await settle(); },
    async close(stream) { stream.bytes += "data: [DONE]\n\n"; stream.controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); stream.controller.close(); assert.equal(await stream.read, stream.bytes); await settle(); },
  };
}
const json = value => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
// Measured on Strata 0.1.59: the active slot carries no next_token counters.
const bareSlot = [{ id: 0, n_ctx: 262144, is_processing: true, n_prompt_tokens: 63 }];

test("server counts use a sliding time window, including real zero speed", () => {
  const window = new SlotSpeedWindow();
  assert.equal(window.sample(slot(10), 1000), undefined);
  assert.equal(window.sample(slot(30), 2000), 20);
  assert.equal(window.sample(slot(90), 4000), 80 / 3);
  assert.equal(window.sample(slot(150), 5000), 40);
  assert.equal(window.sample(slot(150), 9000), 0);
});

test("idle, multiple slots, malformed counters, rewind and task changes cannot produce a foreign measurement", () => {
  for (const bad of [[], [...slot(20), ...slot(30, 8)], slot(20, 7, { is_processing: false }), slot(-1), slot(20, -1), slot(20, 8), slot(9)]) {
    const window = new SlotSpeedWindow(); window.sample(slot(10), 100);
    assert.equal(window.sample(bad, 200), undefined);
    assert.equal(window.stopped, true);
    assert.equal(window.sample(slot(1000), 300), undefined);
  }
});

test("stock llama streaming timings keep priority, unchanged messages and byte-exact output", async t => {
  const h = harness(t, () => { throw Error("No slot polling for native timings"); });
  const stream = await h.open();
  h.emit(stream, chunk("Привет", { timings: { predicted_n: 10, predicted_ms: 500, predicted_per_second: 20 } }));
  await settle(); await h.tick(4000);
  assert.equal(h.gets.length, 0);
  assert.ok(h.statuses.some(s => s.text === "⚡ TPS: 20.0 tok/s"));
  assert.deepEqual(JSON.parse(h.posts[0].init.body).messages, [{ role: "user", content: "unchanged input" }]);
  assert.equal(JSON.parse(h.posts[0].init.body).timings_per_token, true);
  h.emit(stream, final); await h.close(stream);
  h.hooks.get("agent_end")({}, h.ctx);
  assert.equal(h.statuses.at(-1).text, "⚡ Средний TPS: 50.0 tok/s");
});

test("Gufo token records report this response with two busy slots, including grouped tokens", async t => {
  const h = harness(t, () => { throw Error("Token records need no slot matching"); }, { owner: "gufo" });
  let clock = 1000;
  t.mock.method(performance, "now", () => clock);
  t.mock.method(Date, "now", () => 100000 + clock);
  const record = count => ({ choices: [{ index: 0, delta: { reasoning_content: "Мысли" },
    logprobs: { content: Array.from({ length: count }, () => ({ token: "token", logprob: -1 })) }, finish_reason: null }] });
  const stream = await h.open(undefined, { model: "fixture-model" });
  const request = JSON.parse(h.posts[0].init.body);
  assert.equal(request.logprobs, true); assert.equal(request.top_logprobs, 0);
  assert.deepEqual(request.messages, [{ role: "user", content: "unchanged input" }]);
  assert.equal(h.metadata.length, 2);
  for (const get of h.metadata) {
    assert.equal(new URL(get.url).origin, "http://server:8181");
    assert.equal(get.init.headers.get("authorization"), "Bearer fixture-secret");
    assert.equal(get.init.redirect, "error");
  }
  h.emit(stream, record(3)); await settle();
  clock = 2000;
  h.emit(stream, record(7)); await settle();
  assert.equal(h.statuses.at(-1).text, "⚡ TPS: 7.0 tok/s", "Counts records, not characters or chunks");
  await h.tick(5000); assert.equal(h.gets.length, 0);
  clock = 3000;
  h.emit(stream, chunk("answer", { timings: { predicted_n: 40, predicted_ms: 2000 } })); await settle();
  assert.equal(h.statuses.at(-1).text, "⚡ TPS: 20.0 tok/s", "Native timings retain priority");
  h.emit(stream, final); await h.close(stream);
  const next = await h.open(undefined, { model: "fixture-model" });
  assert.equal(h.metadata.length, 2, "Capability is cached, not probed per token/request");
  assert.equal(JSON.parse(h.posts[1].init.body).logprobs, true);
  await h.close(next);
});

test("other servers, older Gufo and failed capability reads keep existing request semantics", async t => {
  const h = harness(t, () => json(slot(10)), { owner: "gufo", version: "0.28.0" });
  const old = await h.open(undefined, { model: "fixture-model" });
  assert.equal(JSON.parse(h.posts[0].init.body).logprobs, undefined);
  await h.close(old);
  const explicit = await h.open(undefined, { model: "fixture-model", logprobs: false });
  assert.equal(JSON.parse(h.posts[1].init.body).logprobs, false);
  assert.equal(h.metadata.length, 2);
  await h.close(explicit);
});

test("capability failure never retries generation or changes user-supplied token metadata options", async t => {
  const h = harness(t, () => json(slot(10)), { fail: true });
  const stream = await h.open(undefined, { model: "fixture-model" });
  assert.equal(h.posts.length, 1);
  assert.equal(JSON.parse(h.posts[0].init.body).logprobs, undefined);
  h.emit(stream, chunk("answer")); await h.close(stream);
  const explicit = await h.open(undefined, { model: "fixture-model", logprobs: true, top_logprobs: 5 });
  assert.equal(JSON.parse(h.posts[1].init.body).top_logprobs, 5);
  await h.close(explicit);
});

test("a non-Gufo server keeps native timing requests unchanged", async t => {
  const h = harness(t, () => { throw Error("Native timing uses no slots"); }, { owner: "llamacpp" });
  const stream = await h.open(undefined, { model: "fixture-model", temperature: 0.7 });
  const sent = JSON.parse(h.posts[0].init.body);
  assert.equal(sent.logprobs, undefined); assert.equal(sent.temperature, 0.7);
  h.emit(stream, chunk("answer", { timings: { predicted_n: 10, predicted_ms: 500 } })); await settle();
  assert.equal(h.statuses.at(-1).text, "⚡ TPS: 20.0 tok/s");
  await h.close(stream);
});

test("Bubo polling begins after output, authenticates same-origin GETs and stops at final chunk", async t => {
  const h = harness(t, n => json(slot(10 + n * 20)));
  const stream = await h.open();
  h.emit(stream, { choices: [{ delta: { role: "assistant" }, finish_reason: null }] });
  await settle(); await h.tick(5000); assert.equal(h.gets.length, 0, "No polling during queue/prefill");
  h.emit(stream, chunk("Answer")); await settle(); await h.tick(1000);
  assert.equal(h.gets.length, 1);
  assert.equal(h.gets[0].url, "http://server:8181/proxy/v1/slots");
  assert.equal(h.gets[0].init.headers.get("authorization"), "Bearer fixture-secret");
  assert.equal(h.gets[0].init.headers.get("content-type"), null);
  assert.equal(h.gets[0].init.redirect, "error");
  await h.tick(750); assert.equal(h.gets.length, 2);
  assert.ok(h.statuses.some(s => /TPS: [\d.]+ tok\/s/.test(s.text)));
  h.emit(stream, final); await settle();
  await h.tick(5000); assert.equal(h.gets.length, 2);
  await h.close(stream); h.hooks.get("agent_end")({}, h.ctx);
  assert.equal(h.statuses.at(-1).text, "⚡ Средний TPS: 50.0 tok/s");
});

test("reasoning and streamed tool arguments also start the fallback", async t => {
  const h = harness(t, () => json(slot(10)));
  const stream = await h.open();
  h.emit(stream, { choices: [{ delta: { reasoning_content: "Thinking" }, finish_reason: null }] });
  await settle(); await h.tick(1000); assert.equal(h.gets.length, 1);
  await h.close(stream);
  const tool = await h.open();
  h.emit(tool, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{" } }] }, finish_reason: null }] });
  await settle(); await h.tick(1000); assert.equal(h.gets.length, 2);
  await h.close(tool);
});

test("native timings arriving late cancel fallback polling", async t => {
  const h = harness(t, n => json(slot(n * 20)));
  const stream = await h.open(); h.emit(stream, chunk("start")); await settle(); await h.tick(1000);
  h.emit(stream, chunk("next", { timings: { predicted_n: 10, predicted_ms: 500 } })); await settle();
  await h.tick(5000); assert.equal(h.gets.length, 1);
  await h.close(stream);
});

test("unsupported slots or malformed JSON never fail the generation or retry the POST", async t => {
  const h = harness(t, () => new Response("missing", { status: 404 }));
  const stream = await h.open(); h.emit(stream, chunk("still works")); await settle(); await h.tick(1000);
  await h.tick(5000);
  assert.deepEqual(h.gets.map(get => new URL(get.url).pathname), ["/proxy/v1/slots", "/slots"],
    "Forks mount the route at the server root, so both candidates are tried once");
  assert.equal(h.metrics.length, 2, "The web telemetry probe covers both mounts as well");
  assert.equal(h.posts.length, 1);
  await h.close(stream);
});

test("Abort cancels an in-flight telemetry request without another poll", async t => {
  let pollSignal;
  const h = harness(t, (_n, init) => new Promise((_resolve, reject) => {
    pollSignal = init.signal;
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }));
  const controller = new AbortController(), stream = await h.open(controller.signal);
  h.emit(stream, chunk("start")); await settle(); await h.tick(1000);
  assert.equal(pollSignal.aborted, false);
  controller.abort(); await settle(); assert.equal(pollSignal.aborted, true);
  await h.tick(5000); assert.equal(h.gets.length, 1);
  await h.close(stream);
});

test("task change and concurrent local responses stop rather than rebinding to another job", async t => {
  const h = harness(t, n => json(slot(20 * n, n === 1 ? 7 : 8)));
  const one = await h.open(); h.emit(one, chunk("one")); await settle(); await h.tick(1000); await h.tick(750);
  assert.ok(!h.statuses.some(s => /TPS: [\d.]+ tok\/s/.test(s.text)), "No speed from a new task");
  await h.tick(5000); assert.equal(h.gets.length, 2);
  const two = await h.open(); h.emit(two, chunk("two")); await settle(); await h.tick(5000);
  assert.equal(h.gets.length, 2);
  await h.close(one); await h.close(two);
});

test("concurrency clears an already displayed slot speed, even before the second response emits output", async t => {
  const h = harness(t, n => json(slot(n * 10)));
  const one = await h.open(); h.emit(one, chunk("one")); await settle(); await h.tick(1000); await h.tick(750);
  assert.match(h.statuses.at(-1).text, /TPS: [\d.]+ tok\/s/);
  const two = await h.open();
  assert.equal(h.statuses.at(-1).text, "⚡ TPS: —");
  await h.tick(5000); assert.equal(h.gets.length, 2);
  await h.close(one); await h.close(two);
});

test("a malformed telemetry body clears stale speed but preserves the generation stream", async t => {
  const h = harness(t, n => n < 3 ? json(slot(n * 10)) : new Response("not JSON"));
  const stream = await h.open(); h.emit(stream, chunk("text")); await settle();
  await h.tick(1000); await h.tick(750);
  assert.match(h.statuses.at(-1).text, /TPS: [\d.]+ tok\/s/);
  await h.tick(750); assert.equal(h.statuses.at(-1).text, "⚡ TPS: —");
  await h.tick(5000); assert.equal(h.gets.length, 3);
  h.emit(stream, final); await h.close(stream);
});

test("a server publishing web telemetry takes over the status from unreadable slots", async t => {
  const live = [
    { state: "reading", tok_s: null }, { state: "reading", tok_s: null }, { state: "reading", tok_s: null },
    { state: "generating", tok_s: 37.5 }, { state: "generating", tok_s: 39.25 },
  ];
  const h = harness(t, () => json(bareSlot), { metrics: n => json({ live: live[Math.min(n - 1, live.length - 1)] }) });
  let clock = 1000;
  t.mock.method(performance, "now", () => clock);
  t.mock.method(Date, "now", () => 100000 + clock);
  const stream = await h.open();
  h.emit(stream, { choices: [{ delta: { role: "assistant" }, finish_reason: null }] });
  await settle();
  assert.equal(h.metrics.length, 1, "The web counters only exist during prefill, so polling starts there");
  assert.equal(h.working.at(-1), "Prefilling... reading the prompt");
  await h.tick(1000); await settle();
  h.emit(stream, chunk("Answer")); await settle(); await h.tick(1000); await settle();
  assert.equal(h.working.at(-1), undefined, "The first output token hands the working line back");
  assert.equal(h.metrics[0].url, "http://server:8181/proxy/v1/metrics");
  assert.equal(h.metrics[0].init.headers.get("authorization"), "Bearer fixture-secret");
  assert.equal(h.metrics[0].init.headers.get("content-type"), null);
  assert.equal(h.metrics[0].init.redirect, "error");
  assert.ok(!h.statuses.some(s => /TPS: [\d.]+ tok\/s/.test(s.text)), "Prefill reports no decode speed");
  await h.tick(750); await settle();
  assert.equal(h.statuses.at(-1).text, "⚡ TPS: 37.5 tok/s");
  clock = 2000;
  await h.tick(750); await settle();
  assert.equal(h.statuses.at(-1).text, "⚡ TPS: 39.3 tok/s");
  assert.equal(h.gets.length, 1, "The unusable slot route is not polled again");
  assert.deepEqual(JSON.parse(h.posts[0].init.body).messages, [{ role: "user", content: "unchanged input" }]);
  assert.equal(JSON.parse(h.posts[0].init.body).logprobs, undefined, "No sampling options were added");
  const reads = h.metrics.length;
  h.emit(stream, final); await settle();
  await h.tick(5000); assert.equal(h.metrics.length, reads, "The final chunk stops polling");
  assert.ok(reads >= 4, "Polling ran while the response streamed");
  assert.deepEqual(h.metrics.map(entry => new URL(entry.url).pathname), Array(reads).fill("/proxy/v1/metrics"),
    "The mount that answered is reused for every poll");
  await h.close(stream);
});

test("a server without web telemetry is probed once and generation stays untouched", async t => {
  const h = harness(t, () => new Response("missing", { status: 404 }));
  const one = await h.open();
  h.emit(one, chunk("still generating")); await settle(); await h.tick(1000); await settle();
  assert.equal(h.metrics.length, 2, "Capability probed once across both mounts");
  await h.tick(5000); assert.equal(h.metrics.length, 2, "An absent shape is not repolled");
  await h.close(one);
  const two = await h.open();
  h.emit(two, chunk("second")); await settle(); await h.tick(1000); await settle(); await h.tick(5000);
  assert.equal(h.metrics.length, 2, "The next response reuses the cached answer");
  assert.equal(h.posts.length, 2, "Generation was never retried or altered");
  await h.close(two);
});

test("native timings keep priority over web telemetry", async t => {
  const h = harness(t, () => json(bareSlot), { metrics: () => json({ live: { state: "generating", tok_s: 99 } }) });
  const stream = await h.open();
  h.emit(stream, chunk("text", { timings: { predicted_n: 10, predicted_ms: 500, predicted_per_second: 20 } }));
  await settle(); await h.tick(5000);
  assert.equal(h.metrics.length, 1, "One probe, then native timings own the status field");
  assert.equal(h.statuses.at(-1).text, "⚡ TPS: 20.0 tok/s");
  await h.close(stream);
});

test("a second concurrent response clears the shared server metric instead of rebinding", async t => {
  const h = harness(t, () => json(bareSlot), { metrics: () => json({ live: { state: "generating", tok_s: 30 } }) });
  const one = await h.open();
  h.emit(one, chunk("one")); await settle(); await h.tick(1000); await settle(); await h.tick(750); await settle();
  assert.equal(h.statuses.at(-1).text, "⚡ TPS: 30.0 tok/s");
  const two = await h.open();
  assert.equal(h.statuses.at(-1).text, "⚡ TPS: —", "A server-wide figure cannot be attributed");
  const reads = h.metrics.length;
  await h.tick(5000);
  assert.equal(h.metrics.length, reads, "Neither response keeps polling a shared server metric");
  await h.close(one); await h.close(two);
});

test("agent end, shutdown and a new run stop pending polling", async t => {
  const h = harness(t, n => json(slot(10 * n)));
  const old = await h.open(); h.emit(old, chunk("old")); await settle(); await h.tick(1000);
  h.start(); await h.tick(5000); assert.equal(h.gets.length, 1);
  h.emit(old, chunk("late", { timings: { predicted_n: 10, predicted_ms: 10 } })); await settle();
  assert.equal(h.statuses.at(-1).text, "⚡ TPS: —", "Old run cannot update the new run");
  await h.close(old);
  const fresh = await h.open(); h.emit(fresh, chunk("new")); await settle();
  h.hooks.get("agent_end")({}, h.ctx); await h.tick(5000); assert.equal(h.gets.length, 1);
  await h.close(fresh);
});

test("a real stalled HTTP telemetry body times out without interrupting SSE", { timeout: 10000 }, async t => {
  const saved = globalThis.fetch, hooks = new Map(), statuses = [];
  let answer, telemetryClosed, count = 0;
  const closed = new Promise(resolve => { telemetryClosed = resolve; });
  const server = http.createServer((req, res) => {
    if (req.url.endsWith("/metrics")) {
      res.writeHead(404); // Stock llama.cpp has no web telemetry route on either mount.
      res.end();
    } else if (req.url === "/v1/slots") {
      count++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write("["); // headers arrive, but JSON body never finishes
      res.on("close", telemetryClosed);
    } else {
      answer = res;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(wire(chunk("still generating")));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  speedAddon({ on: (name, handler) => hooks.set(name, handler) });
  t.after(async () => {
    hooks.get("session_shutdown")(); globalThis.fetch = saved;
    answer?.destroy(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const ctx = { hasUI: true, ui: { setStatus: (_key, text) => statuses.push(text), setWorkingMessage: () => {} } };
  hooks.get("before_agent_start")({}, ctx);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
    method: "POST", body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "fixture" }] }),
  });
  const output = response.text();
  let deadline;
  try {
    await Promise.race([closed, new Promise((_resolve, reject) => { deadline = setTimeout(() => reject(Error("telemetry did not time out")), 6000); })]);
  } finally { clearTimeout(deadline); }
  await settle(); assert.equal(count, 1);
  answer.end(wire(final) + "data: [DONE]\n\n");
  assert.equal(await output, wire(chunk("still generating")) + wire(final) + "data: [DONE]\n\n");
  hooks.get("agent_end")({}, ctx);
  assert.equal(statuses.at(-1), "⚡ Средний TPS: 50.0 tok/s");
});

const shownLines = working => working.filter(line => line !== undefined);

test("Gufo prefill uses one active slot among idle sessions before output arrives", async t => {
  const live = { id: 0, id_task: 1846, is_processing: true, n_prompt_tokens: 8000,
    n_prompt_tokens_cache: 1000, n_prompt_tokens_processed: 1000, next_token: [{ n_decoded: 0 }] };
  const h = harness(t, () => json([live, { id: 1, is_processing: false }]), { owner: "gufo" });
  const stream = await h.open(undefined, { model: "fixture-model" });
  await settle(); await h.tick(750);
  assert.match(h.working.at(-1), /Server prompt processing.*25%/);
  live.n_prompt_tokens_processed = 7000;
  await h.tick(750);
  assert.equal(h.working.at(-1), "Server: preparing context…", "100% is not a completed first token");
  h.emit(stream, chunk("answer")); await settle();
  assert.equal(h.working.at(-1), undefined);
  const reads = h.gets.length;
  await h.tick(750); assert.equal(h.gets.length, reads);
  await h.close(stream);
});

test("Gufo slot prefill stops at ambiguity or task changes and stream progress wins", async t => {
  let slots = slot(0, 11, { n_prompt_tokens: 100, n_prompt_tokens_cache: 10, n_prompt_tokens_processed: 10 });
  const h = harness(t, () => json(slots), { owner: "gufo" });
  const one = await h.open(undefined, { model: "fixture-model" });
  await settle(); await h.tick(750); assert.match(h.working.at(-1), /20%/);
  slots = slot(0, 12, { n_prompt_tokens: 100, n_prompt_tokens_cache: 10, n_prompt_tokens_processed: 50 });
  await h.tick(750); assert.equal(h.working.at(-1), undefined);
  const reads = h.gets.length; await h.tick(3000); assert.equal(h.gets.length, reads);
  await h.close(one);
  slots = [...slots, ...slot(0, 13)];
  const two = await h.open(undefined, { model: "fixture-model" });
  await settle(); await h.tick(750); assert.equal(h.working.at(-1), undefined);
  await h.close(two);
  slots = slot(0, 14, { n_prompt_tokens: 100, n_prompt_tokens_cache: 10, n_prompt_tokens_processed: 10 });
  const three = await h.open(undefined, { model: "fixture-model" });
  h.emit(three, { prompt_progress: { total: 100, processed: 80, time_ms: 100 } });
  await settle(); await h.tick(750); assert.match(h.working.at(-1), /80%/);
  await h.close(three);
});

test("prefill remains visible while the completion server withholds HTTP headers", async t => {
  let releaseHeaders;
  const h = harness(t, () => json(bareSlot), {
    headers: response => new Promise(resolve => { releaseHeaders = () => resolve(response); }),
    metrics: () => json({ live: { state: "reading", prompt_read: 2000, prompt_total: 8000, elapsed_s: 1 } }),
  });
  const opening = h.open();
  await settle();
  try {
    assert.equal(h.posts.length, 1);
    assert.match(h.working.at(-1) ?? "", /Prefilling.*25%/);
    const reads = h.metrics.length;
    await h.tick(750);
    assert.ok(h.metrics.length > reads, "progress continues before completion headers arrive");
  } finally {
    releaseHeaders();
    const stream = await opening;
    h.emit(stream, chunk("Answer")); await settle();
    assert.equal(h.working.at(-1), undefined);
    await h.close(stream);
  }
});

test("a failed completion request clears pre-header progress and stops its polling", async t => {
  let fail;
  const h = harness(t, () => json(bareSlot), {
    headers: () => new Promise((_resolve, reject) => { fail = reject; }),
    metrics: () => json({ live: { state: "reading", prompt_read: 100, prompt_total: 1000 } }),
  });
  const opening = h.open();
  const failed = assert.rejects(opening, /fixture connection failed/);
  await settle();
  fail(new Error("fixture connection failed")); await failed;
  const reads = h.metrics.length;
  await h.tick(5000);
  assert.equal(h.working.at(-1), undefined);
  assert.equal(h.metrics.length, reads);
});

test("prompt_progress from the stream draws the bar and hands the field back on the first token", async t => {
  const h = harness(t, () => { throw Error("No slot polling for a stream that reports its own progress"); },
    { metrics: () => json({ live: { state: "reading", phase: "reading the prompt" } }) });
  const stream = await h.open();
  const sent = JSON.parse(h.posts[0].init.body);
  assert.equal(sent.return_progress, true, "Servers hide prompt progress without this flag");
  assert.equal(sent.stream_options.include_usage, true, "The final usage chunk must keep arriving");
  assert.deepEqual(sent.messages, [{ role: "user", content: "unchanged input" }], "User content is untouched");
  h.emit(stream, { prompt_progress: { total: 1000, processed: 250, time_ms: 500, cache: 0 } });
  await settle();
  assert.match(h.working.at(-1), /^Prefilling\.\.\. [█░]+\s+25% · \d+s · 500\.0 tok\/s$/);
  h.emit(stream, { prompt_progress: { total: 1000, processed: 750, time_ms: 1000, cache: 0 } });
  await settle();
  assert.match(h.working.at(-1), /\s75% · 1000\.0 tok\/s$/);
  h.emit(stream, chunk("Ответ")); await settle();
  assert.equal(h.working.at(-1), undefined, "Generation owns the working line again");
  await h.close(stream);
});

test("web telemetry counters draw the same bar while the stream stays silent about prefill", async t => {
  const h = harness(t, () => { throw Error("No slot polling before output"); },
    { metrics: () => json({ live: { state: "reading", prompt_read: 2000, prompt_total: 8000, prefill_tok_s_mean: 1500, elapsed_s: 1.3 } }) });
  const stream = await h.open();
  await settle();
  assert.match(h.working.at(-1), /^Prefilling\.\.\. [█░]+\s+25% · 4s · 1500\.0 tok\/s$/);
  h.emit(stream, chunk("Ответ")); await settle();
  assert.equal(h.working.at(-1), undefined, "The first token ends the prefill reading");
  await h.close(stream);
});

test("a server reporting another phase invents no prefill progress", async t => {
  const h = harness(t, () => { throw Error("No slot polling during queue"); },
    { metrics: () => json({ live: { state: "idle", tok_s: null } }) });
  const stream = await h.open();
  await settle(); await h.tick(1000); await settle();
  assert.equal(shownLines(h.working).length, 0, "Queue and idle states stay silent");
  h.emit(stream, chunk("text")); await settle(); await h.close(stream);
});

test("stream progress wins over the shared server metric", async t => {
  const h = harness(t, () => { throw Error("unused"); },
    { metrics: () => json({ live: { state: "reading", prompt_read: 100, prompt_total: 1000, elapsed_s: 1 } }) });
  const stream = await h.open();
  h.emit(stream, { prompt_progress: { total: 900, processed: 900, time_ms: 300 } });
  await settle(); await h.tick(750); await settle();
  assert.match(h.working.at(-1), /\s100%/);
  h.emit(stream, chunk("x")); await settle(); await h.close(stream);
});

test("an aborted request cannot leave the bar on the screen", async t => {
  const h = harness(t, () => { throw Error("unused"); }, { metrics: () => json({ live: { state: "reading" } }) });
  const controller = new AbortController(), stream = await h.open(controller.signal);
  stream.read?.catch(() => {});
  h.emit(stream, { prompt_progress: { total: 100, processed: 10, time_ms: 100 } });
  await settle();
  assert.match(h.working.at(-1), /Prefilling/);
  controller.abort(); await settle();
  assert.equal(h.working.at(-1), undefined, "Abort drops the bar instead of leaving it until the next run");
});
