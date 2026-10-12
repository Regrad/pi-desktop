import test from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import net from "node:net";
import { checkServerIdentity } from "node:tls";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { X509Certificate } from "node:crypto";
import { createWebAccess } from "../resources/web-access/server.mjs";
import { hashPassword, verifyPassword, normalizeSettings } from "../resources/web-access/security.mjs";

async function freePort() {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

test("password hashing and strict configuration", async () => {
  const credential = await hashPassword("Тестовый пароль 123!");
  assert.equal(await verifyPassword("Тестовый пароль 123!", credential), true);
  assert.equal(await verifyPassword("Неверный пароль 123!", credential), false);
  assert.equal(credential.hash.length, 64);
  await assert.rejects(hashPassword("short"));
  assert.throws(() => normalizeSettings({ localEnabled: true, remoteEnabled: false, address: "https://host", port: 1369, username: "pi" }));
  assert.throws(() => normalizeSettings({ localEnabled: true, remoteEnabled: false, address: "host", port: 0, username: "pi" }));
  assert.throws(() => normalizeSettings({ localEnabled: true, remoteEnabled: false, address: "host", port: 1369, username: "" }));
});

test("damaged device registry is preserved, remote access fails closed without stopping desktop", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-web-damaged-device-test-"));
  await mkdir(path.join(directory, "web-access"));
  await writeFile(path.join(directory, "web-access", "devices.json"), "broken registry");
  const service = await createWebAccess({ dataDir: directory, rendererDir: directory, backend: { call: async () => undefined, media: async () => new Response(null) } });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  assert.equal(service.status().running, false); assert.equal(service.status().remoteEnabled, false);
  assert(service.status().error.includes("devices.json"));
  await assert.rejects(service.configure({ localEnabled: false, remoteEnabled: true, address: "127.0.0.1", port: 1369, username: "pi", password: "Тестовый пароль 123!" }), /devices.json/);
  assert.equal(await readFile(path.join(directory, "web-access", "devices.json"), "utf8"), "broken registry");
});

test("real HTTPS: certificate persistence, login, CSRF, separate modes, logout and shutdown", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-web-test-"));
  const renderer = path.join(directory, "renderer"); await mkdir(renderer);
  await writeFile(path.join(renderer, "index.html"), "<p>CHAT TEST</p>");
  const calls = [];
  let service;
  t.after(async () => { await service?.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  const backend = {
    call: async (method, args) => { calls.push({ method, args }); return { method, args }; },
    media: async () => new Response("audio-test", { headers: { "Content-Type": "audio/ogg" } }),
  };
  service = await createWebAccess({ dataDir: directory, rendererDir: renderer, backend, bindAddress: "127.0.0.1" });
  assert.equal(service.status().running, false);
  const port = await freePort();
  const settings = { localEnabled: true, remoteEnabled: false, address: "127.0.0.1", port, username: "pi", password: "Тестовый пароль 123!" };
  const status = await service.configure(settings);
  assert.equal(status.running, true, status.error);
  const certificate = JSON.parse(await readFile(path.join(directory, "web-access", "certificate.json"), "utf8"));
  const stored = JSON.parse(await readFile(path.join(directory, "web-access", "settings.json"), "utf8"));
  assert.equal(stored.password, undefined);
  assert(!JSON.stringify(stored).includes(settings.password));
  assert.equal(status.fingerprint, new X509Certificate(certificate.cert).fingerprint256);
  assert(new X509Certificate(certificate.cert).checkIP("127.0.0.1"));
  let cookie, csrf;
  const request = (url, { method = "GET", body, headers = {}, ca = certificate.cert } = {}) => new Promise((resolve, reject) => {
    const req = https.request({ hostname: "127.0.0.1", port, path: url, method, ca, agent: false, checkServerIdentity: (_name, peer) => checkServerIdentity("127.0.0.1", peer),
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(method === "POST" ? { Origin: `https://127.0.0.1:${port}`, "Content-Type": "application/json", ...(csrf ? { "X-Pi-CSRF": csrf } : {}) } : {}), ...headers },
    }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  await assert.rejects(request("/", { ca: [] }));
  assert.equal((await request("/api/session")).status, 401);
  assert.match((await request("/app/")).text, /Вход/);
  assert.equal((await request("/api/login", { method: "POST", body: { username: "pi", password: settings.password }, headers: { Origin: "https://evil.test" } })).status, 403);
  assert.equal((await request("/api/login", { method: "POST", body: { username: "pi", password: "wrong" } })).status, 401);
  const login = await request("/api/login", { method: "POST", body: { username: "pi", password: settings.password } });
  assert.equal(login.status, 200);
  const setCookie = login.headers["set-cookie"][0];
  assert.match(setCookie, /HttpOnly; Secure; SameSite=Strict/);
  cookie = setCookie.split(";")[0];
  const session = JSON.parse((await request("/api/session")).text); csrf = session.csrf;
  assert.equal(session.localEnabled, true); assert.equal(session.remoteEnabled, false);
  assert.match((await request("/app/")).text, /CHAT TEST/);
  assert.equal((await request("/api/rpc", { method: "POST", body: { mode: "local", method: "bootstrap", args: [] }, headers: { "X-Pi-CSRF": "wrong" } })).status, 403);
  assert.equal((await request("/api/rpc", { method: "POST", body: { mode: "local", method: "bootstrap", args: [] } })).status, 200);
  assert.equal(calls.length, 1);
  const stream = https.request({ hostname: "127.0.0.1", port, path: "/api/events", ca: certificate.cert, agent: false, headers: { Cookie: cookie } });
  const received = new Promise((resolve, reject) => {
    stream.once("error", reject);
    stream.once("response", res => {
      assert.equal(res.statusCode, 200);
      let data = "", published = false;
      res.on("data", bytes => {
        data += bytes.toString();
        if (!published && data.includes(": connected")) { published = true; service.publish("pi:event", { conversationId: "test", event: { type: "message_update", text: "Текст" } }); }
        if (data.includes('"text":"Текст"')) { resolve(); stream.destroy(); }
      });
    });
  });
  stream.end(); await received;
  assert.equal((await request("/api/rpc", { method: "POST", body: { mode: "remote", method: "bootstrap", args: [] } })).status, 403);
  assert.equal((await request("/api/media/music/test.ogg")).text, "audio-test");
  assert.equal((await request("/app/%2e%2e%2fweb-access%2fcertificate.json")).status, 404);
  assert.equal((await request("/api/session", { headers: { Host: `evil.test:${port}` } })).status, 403);
  assert.equal((await request("/api/logout", { method: "POST" })).status, 200);
  assert.equal((await request("/api/session")).status, 401);
  const remoteOnly = await service.configure({ ...settings, password: "", localEnabled: false, remoteEnabled: true });
  assert.equal(remoteOnly.running, true);
  assert.equal(remoteOnly.fingerprint, status.fingerprint);
  cookie = undefined; csrf = undefined;
  const login2 = await request("/api/login", { method: "POST", body: { username: "pi", password: settings.password } });
  cookie = login2.headers["set-cookie"][0].split(";")[0];
  csrf = JSON.parse((await request("/api/session")).text).csrf;
  assert.equal((await request("/api/rpc", { method: "POST", body: { mode: "local", method: "bootstrap", args: [] } })).status, 403);
  assert.equal((await request("/api/rpc", { method: "POST", body: { mode: "remote", method: "sendPrompt", args: [] } })).status, 503);
  assert.equal((await request("/api/media/music/test.ogg")).status, 403);
  assert.equal((await request("/api/events")).status, 403);
  assert.equal(calls.length, 1, "remote request MUST NOT fall back to the host");
  await service.configure({ ...settings, password: "", localEnabled: true, remoteEnabled: true });
  assert.equal((await request("/api/session")).status, 401, "configuration changes revoke sessions");
  cookie = undefined; csrf = undefined;
  for (let i = 0; i < 8; i++) assert.equal((await request("/api/login", { method: "POST", body: { username: "pi", password: "wrong" } })).status, 401);
  assert.equal((await request("/api/login", { method: "POST", body: { username: "pi", password: settings.password } })).status, 429);
  await service.configure({ ...settings, password: "", localEnabled: false, remoteEnabled: false });
  assert.equal(service.status().running, false);
  await service.close();
  service = await createWebAccess({ dataDir: directory, rendererDir: renderer, backend, bindAddress: "127.0.0.1" });
  assert.equal(service.status().running, false, "disabled modes survive restart");
  const restarted = await service.configure({ ...settings, password: "" });
  assert.equal(restarted.fingerprint, status.fingerprint, "certificate identity survives restart");
  const rotated = await service.configure({ ...settings, password: "", renewCertificate: true });
  assert.notEqual(rotated.fingerprint, status.fingerprint, "explicit renewal changes identity");
  await assert.rejects(request("/api/session"), "old certificate must not authenticate the renewed server");
  const renewed = JSON.parse(await readFile(path.join(directory, "web-access", "certificate.json"), "utf8"));
  assert.equal((await request("/api/session", { ca: renewed.cert })).status, 401);
});

test("damaged optional configuration never stops desktop startup", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-web-corrupt-"));
  await mkdir(path.join(directory, "web-access"));
  await writeFile(path.join(directory, "web-access", "settings.json"), "{bad");
  const service = await createWebAccess({ dataDir: directory, rendererDir: directory, backend: { call: async () => assert.fail(), media: async () => assert.fail() } });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(service.status().running, false);
  assert.equal(service.status().localEnabled, false);
  assert.match(service.status().error, /Повреждены/);
});
