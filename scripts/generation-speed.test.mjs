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

function harness(t, slots = () => slot(10)) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const saved = globalThis.fetch, hooks = new Map(), statuses = [], posts = [], gets = [], streams = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/slots")) {
      gets.push({ url: String(url), init });
      return slots(gets.length, init);
    }
    posts.push({ url, init });
    const stream = { bytes: "", controller: undefined };
    streams.push(stream);
    return new Response(new ReadableStream({ start(controller) { stream.controller = controller; } }), { headers: { "content-type": "text/event-stream" } });
  };
  const mockFetch = globalThis.fetch;
  speedAddon({ on: (name, fn) => hooks.set(name, fn) });
  const ctx = { hasUI: true, ui: { setStatus: (key, text) => statuses.push({ key, text }) } };
  const start = () => hooks.get("before_agent_start")({}, ctx);
  hooks.get("session_start")({}, ctx); start();
  t.after(() => {
    hooks.get("session_shutdown")();
    assert.equal(globalThis.fetch, mockFetch);
    globalThis.fetch = saved;
    for (const stream of streams) { try { stream.controller.close(); } catch {} }
  });
  return {
    hooks, ctx, statuses, posts, gets, streams, start,
    async open(signal) {
      const response = await fetch("http://server:8181/proxy/v1/chat/completions", { method: "POST", signal,
        headers: { Authorization: "Bearer fixture-secret", "Content-Type": "application/json" },
        body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "unchanged input" }] }) });
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
  await h.tick(5000); assert.equal(h.gets.length, 1); assert.equal(h.posts.length, 1);
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
    if (req.url === "/v1/slots") {
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
  const ctx = { hasUI: true, ui: { setStatus: (_key, text) => statuses.push(text) } };
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
