import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createWebAccess } from "../resources/web-access/server.mjs";

test("HTTPS pairing, independent devices, scoped RPC/media/SSE and logout revocation", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-web-remote-test-"));
  const renderer = path.join(directory, "renderer"); await mkdir(renderer);
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
  const calls = [], disconnected = [], streams = [];
  const service = await createWebAccess({ dataDir: directory, rendererDir: renderer, bindAddress: "127.0.0.1",
    backend: { call: async () => { assert.fail("REMOTE must never call HOST backend"); }, media: async () => { assert.fail("REMOTE must never read HOST media directly"); } },
    remoteBackend: async (id, broker) => ({ call: async (method, args) => { calls.push({ id, method, args }); if (method === "write") return broker.invoke(id, "write", args[0]); return { deviceId: id }; }, media: async (_kind, filename) => new Response(filename === `${id}.flac` ? `audio:${id}` : null, { status: filename === `${id}.flac` ? 200 : 404 }) }),
    onDeviceDisconnected: id => disconnected.push(id),
  });
  t.after(async () => { streams.forEach(stream => stream.destroy()); await service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  await service.configure({ localEnabled: false, remoteEnabled: true, address: "127.0.0.1", port, username: "pi", password: "Тестовый пароль 123!" });
  const cert = JSON.parse(await readFile(path.join(directory, "web-access", "certificate.json"), "utf8"));
  const origin = `https://127.0.0.1:${port}`;
  const request = (url, { method = "GET", body, browser, agent, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = https.request({ hostname: "127.0.0.1", port, path: url, method, ca: cert.cert, agent: false, headers: { ...(browser ? { Cookie: browser.cookie } : {}), ...(agent ? { Authorization: `Bearer ${agent}` } : {}), ...(method === "POST" ? { "Content-Type": "application/json", ...(!agent ? { Origin: origin } : {}), ...(browser?.csrf ? { "X-Pi-CSRF": browser.csrf } : {}) } : {}), ...headers } }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("end", () => { const text = Buffer.concat(chunks).toString(); resolve({ status: res.statusCode, headers: res.headers, text, value: (() => { try { return JSON.parse(text); } catch { return undefined; } })() }); });
    }); req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const login = async () => { const response = await request("/api/login", { method: "POST", body: { username: "pi", password: "Тестовый пароль 123!" } }); const browser = { cookie: response.headers["set-cookie"][0].split(";")[0] }; browser.csrf = (await request("/api/session", { browser })).value.csrf; return browser; };
  const firstBrowser = await login(), secondBrowser = await login();
  const rpc = (browser, mode = "remote", method = "bootstrap", args = []) => request("/api/rpc", { method: "POST", browser, body: { mode, method, args } });
  assert.equal((await rpc(firstBrowser)).status, 503);
  assert.equal((await rpc(firstBrowser, "local")).status, 403);
  const connect = async browser => {
    const invite = (await request("/api/device/pair", { method: "POST", browser })).value;
    const deviceId = randomUUID();
    const connected = await request("/api/agent/connect", { method: "POST", agent: "not-needed", headers: { "Content-Type": "application/json; charset=utf-8" }, body: { token: invite.token, deviceId, secret: "c".repeat(64), os: "windows", cwd: "C:\\Users\\test", name: "CLIENT" } });
    assert.equal(connected.status, 200, connected.text);
    return { deviceId, token: connected.value.token };
  };
  const first = await connect(firstBrowser), second = await connect(secondBrowser);
  const state = await request("/api/session", { browser: firstBrowser }); assert.equal(state.value.device.id, first.deviceId);
  assert(state.headers["set-cookie"][0].startsWith("__Host-pi-device="));
  assert.equal((await rpc(firstBrowser)).value.result.deviceId, first.deviceId);
  assert.equal((await rpc(secondBrowser)).value.result.deviceId, second.deviceId);
  assert.equal((await request(`/api/media/music/${first.deviceId}.flac?mode=remote`, { browser: firstBrowser })).status, 200);
  assert.equal((await request(`/api/media/music/${first.deviceId}.flac?mode=remote`, { browser: secondBrowser })).status, 404);
  assert.equal((await request(`/api/agent/media/music/${second.deviceId}.flac`, { agent: first.token })).status, 404);
  assert.equal((await request("/api/agent/poll", { method: "POST", agent: first.token, body: {}, headers: { Origin: origin } })).status, 403);
  const writing = rpc(firstBrowser, "remote", "write", [{ path: "C:\\owned.txt", content: "one" }]);
  assert.equal((await request("/api/agent/poll", { method: "POST", agent: first.token, body: {}, headers: { "Content-Type": "text/plain" } })).status, 400);
  const polled = await request("/api/agent/poll", { method: "POST", agent: first.token, body: {}, headers: { "Content-Type": "application/json; charset=utf-8" } });
  assert.equal(polled.value.command.operation, "write");
  await request("/api/agent/result", { method: "POST", agent: first.token, headers: { "Content-Type": "application/json; charset=utf-8" }, body: { id: polled.value.command.id, result: { written: true } } });
  assert.equal((await writing).value.result.written, true);

  const events = await new Promise((resolve, reject) => {
    const req = https.get({ hostname: "127.0.0.1", port, path: "/api/events?mode=remote", ca: cert.cert, agent: false, headers: { Cookie: firstBrowser.cookie } }, res => { streams.push(req); const buffer = []; res.on("data", chunk => { buffer.push(chunk); if (buffer.join("").includes(": connected")) resolve(buffer); }); }); req.on("error", reject);
  });
  service.publish("pi:event", { private: "second" }, second.deviceId);
  service.publish("pi:event", { private: "first" }, first.deviceId);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert(events.join("").includes('"first"')); assert(!events.join("").includes('"second"'));
  await request("/api/logout", { method: "POST", browser: firstBrowser });
  assert(disconnected.includes(first.deviceId)); assert(!disconnected.includes(second.deviceId));
  assert((await request("/api/agent/poll", { method: "POST", agent: first.token, body: {} })).status >= 400);
  assert.equal((await rpc(firstBrowser)).status, 401);
  assert.equal((await rpc(secondBrowser)).status, 200);
  assert.equal(calls.filter(call => call.method === "write").length, 1);
});
