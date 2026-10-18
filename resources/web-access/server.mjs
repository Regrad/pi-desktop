import https from "node:https";
import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { atomicJson, certificateFor, hashPassword, normalizeSettings, readSettings, verifyPassword } from "./security.mjs";
import { createDeviceBroker } from "./device-broker.mjs";
import { createPrivateBridge } from "./private-bridge.mjs";

const cookieName = "__Host-pi-session";
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };
const loginPage = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Вход — Pi Desktop</title><link rel="stylesheet" href="/login.css"><main><h1>Pi Desktop</h1><form><label>Логин<input name="username" autocomplete="username" required maxlength="100"></label><label>Пароль<input name="password" type="password" autocomplete="current-password" required maxlength="1024"></label><button>Войти</button><p role="status"></p></form></main><script src="/login.js"></script></html>`;
const loginScript = `document.querySelector('form').addEventListener('submit',async e=>{e.preventDefault();const f=e.currentTarget,b=f.querySelector('button'),s=f.querySelector('[role=status]');b.disabled=true;s.textContent='';try{const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(f)))});if(!r.ok)throw Error(r.status===429?'Слишком много попыток. Подождите.':'Не удалось войти');location.replace('/app/')}catch(e){s.textContent=e.message}finally{b.disabled=false}});`;
const loginStyle = `body{font:16px system-ui;background:#f7f7f5;margin:0}main{max-width:340px;margin:10vh auto;padding:24px}label{display:block;margin:16px 0}input{display:block;box-sizing:border-box;width:100%;padding:10px;margin-top:5px}button{padding:10px 20px}p{color:#a22}`;

export async function createWebAccess({ dataDir, rendererDir, backend, remoteBackend, onDeviceDisconnected = () => {}, helperFile, bindAddress = "0.0.0.0" }) {
  let config;
  let server, certificate, error = "", closing = false, generation = 0;
  try { config = await readSettings(dataDir); }
  catch { config = { localEnabled: false, remoteEnabled: false, address: "pikawow.fun", port: 1369, username: "" }; error = "Повреждены настройки веб-доступа. Доступ отключён; сохраните настройки заново."; }
  let changing = Promise.resolve();
  const sessions = new Map(), attempts = new Map(), eventStreams = new Map();
  const publish = (channel, payload, deviceId) => {
    if (!(deviceId ? config.remoteEnabled : config.localEnabled) || !server?.listening || !eventStreams.size) return;
    const data = `data: ${JSON.stringify({ channel, payload })}\n\n`;
    for (const [id, stream] of eventStreams) {
      if (deviceId ? stream.piMode !== "remote" || stream.piDevice !== deviceId : stream.piMode !== "local") continue;
      if (!sessions.has(id) || Date.now() >= sessions.get(id).expires || stream.writableLength > 16 * 1024 * 1024) { stream.end(); eventStreams.delete(id); continue; }
      stream.write(data);
    }
  };
  let broker, bridge, brokerError = "";
  try { broker = await createDeviceBroker({ dataDir, onDisconnect: (id, reason) => { bridge?.revoke(id); onDeviceDisconnected(id, reason); publish("web:device", { connected: false, reason }, id); } }); }
  catch { brokerError = "Повреждён или недоступен data/web-access/devices.json. Удалённый режим отключён; файл сохранён для восстановления."; config.remoteEnabled = false; error = brokerError; }
  // Keep ordinary desktop/local access working without silently replacing device identities.
  if (!broker) broker = {
    info: () => undefined, deviceFromCookie: () => undefined,
    disconnectAll() {}, disconnectSession() {}, async close() {},
    invoke: async () => { throw new Error(brokerError); },
  };
  try { bridge = await createPrivateBridge(broker, () => config.remoteEnabled && Boolean(server?.listening)); }
  catch {
    brokerError = "Не удалось открыть локальный транспорт помощника. Удалённый режим отключён.";
    config.remoteEnabled = false; error = brokerError;
    bridge = { revoke() {}, credential() { throw new Error(brokerError); }, async close() {} };
  }
  const clientBackend = async deviceId => {
    if (!remoteBackend || !deviceId || !broker.info(deviceId)) throw new Error("Подключите управление клиентского ПК");
    return remoteBackend(deviceId, broker, bridge.credential(deviceId));
  };
  const sessionSweep = setInterval(() => {
    for (const [id, session] of sessions) if (session.expires <= Date.now()) { sessions.delete(id); eventStreams.get(id)?.end(); eventStreams.delete(id); broker.disconnectSession(id); }
    for (const [id, session] of sessions) if (Date.now() - session.lastBrowserSeen > 120000) broker.disconnectSession(id);
  }, 10000); sessionSweep.unref();
  let passwordChecks = 0, readingBodies = 0;
  const view = () => ({
    localEnabled: config.localEnabled, remoteEnabled: config.remoteEnabled,
    address: config.address, port: config.port, username: config.username,
    passwordConfigured: Boolean(config.credential), running: Boolean(server?.listening),
    url: `https://${config.address.includes(":") ? `[${config.address}]` : config.address}:${config.port}`,
    fingerprint: certificate?.fingerprint ?? "", validTo: certificate?.validTo ?? "", error,
    remoteReady: Boolean(remoteBackend && helperFile && !brokerError),
  });
  const stop = async () => {
    closing = true;
    generation++; attempts.clear();
    broker.disconnectAll();
    sessions.clear();
    for (const stream of eventStreams.values()) stream.end();
    eventStreams.clear();
    const previous = server; server = undefined;
    if (previous) await new Promise(resolve => { previous.close(resolve); previous.closeAllConnections(); });
    closing = false;
  };
  const start = async (renew = false) => {
    if (!config.localEnabled && !config.remoteEnabled) return;
    certificate = await certificateFor(dataDir, config.address, renew);
    const startedGeneration = generation;
    const service = https.createServer({ key: certificate.key, cert: certificate.cert, minVersion: "TLSv1.2", maxHeaderSize: 8192 }, async (req, res) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      // No HSTS: a self-signed certificate must remain manually verifiable.
      const send = (status, value, type = "application/json; charset=utf-8") => {
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(status, { "Content-Type": type });
        res.end(typeof value === "string" && !type.startsWith("application/json") ? value : JSON.stringify(value));
      };
      try {
        if (closing || generation !== startedGeneration) return send(503, { error: "Отключение" });
        const host = config.address.includes(":") ? `[${config.address}]` : config.address;
        const authority = config.port === 443 ? host : `${host}:${config.port}`;
        if (req.headers.host?.toLowerCase() !== authority) return send(403, { error: "Неверный адрес сервера" });
        const origin = `https://${authority}`;
        const url = new URL(req.url, origin);
        if (url.origin !== origin) return send(403, { error: "Неверный адрес" });
        if (req.headers.origin && req.headers.origin !== origin) return send(403, { error: "Другой источник запроса" });
        if (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(req.headers["sec-fetch-site"])) return send(403, { error: "Другой источник запроса" });
        const body = async (limit = 16 * 1024 * 1024) => {
          const contentType = req.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase();
          if (contentType !== "application/json") throw new Error("Нужен JSON");
          if (readingBodies >= 4) throw new Error("Сервер занят");
          readingBodies++;
          try {
          const chunks = []; let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > limit) throw new Error("Запрос слишком большой");
            chunks.push(chunk);
          }
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Нужен объект");
          return value;
          } finally { readingBodies--; }
        };
        if (req.method === "POST" && url.pathname === "/api/login") {
          if (req.headers.origin !== origin) return send(403, { error: "Неверный источник входа" });
          const ip = req.socket.remoteAddress;
          const now = Date.now();
          for (const [key, value] of attempts) if (now - value.since > 15 * 60000) attempts.delete(key);
          for (const [key, session] of sessions) if (now > session.expires) { sessions.delete(key); broker.disconnectSession(key); }
          const attempt = attempts.get(ip) ?? { since: now, count: 0 };
          if (attempt.count >= 8 || passwordChecks >= 2 || attempts.size >= 2000 || sessions.size >= 100) return send(429, { error: "Подождите перед новой попыткой" });
          attempt.count++; attempts.set(ip, attempt);
          passwordChecks++;
          let valid, credentials;
          try { credentials = await body(4096); valid = generation === startedGeneration && await verifyPassword(credentials.password, config.credential); }
          finally { passwordChecks--; }
          if (generation !== startedGeneration || !valid || credentials.username !== config.username) return send(401, { error: "Неверные данные входа" });
          attempts.delete(ip);
          const token = randomBytes(32).toString("hex");
          const deviceCookie = /(?:^|;\s*)__Host-pi-device=([^;]+)(?:;|$)/.exec(req.headers.cookie ?? "")?.[1];
          sessions.set(token, { csrf: randomBytes(32).toString("hex"), expires: now + 8 * 3600000, lastBrowserSeen: now, deviceId: broker.deviceFromCookie(deviceCookie) });
          res.setHeader("Set-Cookie", `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`);
          return send(200, { ok: true });
        }
        if (req.method === "GET" && url.pathname === "/login.js") return send(200, loginScript, mime[".js"]);
        if (req.method === "GET" && url.pathname === "/login.css") return send(200, loginStyle, mime[".css"]);
        const streamMedia = async response => {
          res.writeHead(response.status, Object.fromEntries(response.headers));
          if (!response.body) { res.end(); return; }
          const reader = response.body.getReader();
          res.on("close", () => { void reader.cancel().catch(() => {}); });
          while (true) {
            const { value, done } = await reader.read();
            if (done || res.destroyed) break;
            if (!res.write(value)) await new Promise(resolve => {
              const finish = () => { res.removeListener("drain", finish); res.removeListener("close", finish); resolve(); };
              res.once("drain", finish); res.once("close", finish);
            });
          }
          res.end();
        };
        // Native helper authenticates its reverse connection, never browser cookies.
        if (url.pathname.startsWith("/api/agent/")) {
          if (!config.remoteEnabled || !remoteBackend || req.headers.origin || req.headers["sec-fetch-site"]) return send(403, { error: "Удалённое управление отключено" });
          if (req.method === "POST" && url.pathname === "/api/agent/connect") {
            const input = await body(4096);
            if (generation !== startedGeneration) return send(503, { error: "Доступ отключён" });
            const connected = await broker.connect(input);
            const browser = sessions.get(connected.sessionId);
            if (!browser || browser.expires <= Date.now()) { broker.disconnectDevice(connected.deviceId); return send(401, { error: "Вход завершён" }); }
            browser.deviceId = connected.deviceId;
            publish("web:device", { connected: true }, connected.deviceId);
            return send(200, { token: connected.token });
          }
          const bearer = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? "")?.[1];
          const connection = broker.connection(bearer);
          const owner = sessions.get(connection.sessionId);
          if (!owner || owner.expires <= Date.now()) { broker.disconnectDevice(connection.deviceId); return send(401, { error: "Вход завершён" }); }
          if (req.method === "POST" && url.pathname === "/api/agent/poll") { await body(256); return send(200, await broker.poll(bearer)); }
          if (req.method === "POST" && url.pathname === "/api/agent/result") {
            const value = await body();
            if (generation !== startedGeneration) return send(503, { error: "Доступ отключён" });
            broker.result(bearer, value.id, value.result, value.error); return send(200, { ok: true });
          }
          const media = /^\/api\/agent\/media\/(image|music|model3d|video|artifact)\/([^/]+)$/.exec(url.pathname);
          if (media && ["GET", "HEAD"].includes(req.method)) return await streamMedia(await (await clientBackend(connection.deviceId)).media(media[1], decodeURIComponent(media[2]), req.method, req.headers.range));
          return send(404, { error: "Не найдено" });
        }
        const token = /(?:^|;\s*)__Host-pi-session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? "")?.[1];
        const session = sessions.get(token);
        if (!session || session.expires <= Date.now()) {
          if (token) { sessions.delete(token); broker.disconnectSession(token); }
          if (req.method === "GET" && !url.pathname.startsWith("/api/")) return send(200, loginPage, mime[".html"]);
          return send(401, { error: "Войдите в Pi Desktop" });
        }
        if (req.method === "POST" && (req.headers.origin !== origin || req.headers["x-pi-csrf"] !== session.csrf)) return send(403, { error: "Неверное подтверждение запроса" });
        session.lastBrowserSeen = Date.now();
        if (req.method === "GET" && url.pathname === "/api/session") {
          if (session.deviceId) res.setHeader("Set-Cookie", `__Host-pi-device=${broker.cookieFor(session.deviceId)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`);
          return send(200, { csrf: session.csrf, localEnabled: config.localEnabled, remoteEnabled: config.remoteEnabled, remoteReady: Boolean(remoteBackend && helperFile && !brokerError), device: broker.info(session.deviceId), fingerprint: certificate.fingerprint, url: origin });
        }
        if (req.method === "POST" && url.pathname === "/api/logout") {
          sessions.delete(token); eventStreams.get(token)?.end(); eventStreams.delete(token);
          broker.disconnectSession(token);
          res.setHeader("Set-Cookie", `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
          return send(200, { ok: true });
        }
        if (req.method === "POST" && url.pathname === "/api/device/pair") {
          if (!config.remoteEnabled || !remoteBackend) return send(403, { error: "Удалённый режим выключен" });
          return send(200, { token: broker.pair(token), fingerprint: certificate.fingerprint, url: origin });
        }
        if (req.method === "POST" && url.pathname === "/api/device/disconnect") { broker.disconnectSession(token); return send(200, { ok: true }); }
        if (req.method === "GET" && url.pathname === "/api/device/helper") {
          if (!config.remoteEnabled || !helperFile) return send(404, { error: "Помощник не собран" });
          const file = await stat(helperFile);
          if (!file.isFile()) return send(404, { error: "Помощник не собран" });
          res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": file.size, "Content-Disposition": 'attachment; filename="Pi Desktop Agent.exe"' });
          const stream = createReadStream(helperFile); stream.on("error", () => res.destroy()); res.on("close", () => stream.destroy()); stream.pipe(res); return;
        }
        if (req.method === "POST" && url.pathname === "/api/rpc") {
          const { method, args, mode } = await body();
          if (generation !== startedGeneration) return send(503, { error: "Доступ отключён" });
          if (!["local", "remote"].includes(mode)) return send(400, { error: "Выберите режим работы" });
          if (!(mode === "local" ? config.localEnabled : config.remoteEnabled)) return send(403, { error: "Этот режим выключен в Pi Desktop" });
          if (mode === "remote" && (!remoteBackend || !session.deviceId)) return send(503, { error: "Помощник клиентского компьютера ещё не подключён" });
          if (typeof method !== "string" || !Array.isArray(args) || args.length > 8) return send(400, { error: "Неверный вызов" });
          return send(200, { result: await (mode === "remote" ? await clientBackend(session.deviceId) : backend).call(method, args) });
        }
        if (req.method === "GET" && url.pathname === "/api/events") {
          const mode = url.searchParams.get("mode") ?? "local";
          if (!(["local", "remote"].includes(mode) && (mode === "local" ? config.localEnabled : config.remoteEnabled))) return send(403, { error: "Этот режим выключен" });
          if (mode === "remote" && !session.deviceId) return send(403, { error: "Подключите клиентский ПК" });
          eventStreams.get(token)?.end();
          eventStreams.set(token, res);
          res.piMode = mode; res.piDevice = session.deviceId;
          res.writeHead(200, { "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" });
          res.write(": connected\n\n");
          const timer = setInterval(() => {
            if (!sessions.has(token) || Date.now() >= session.expires) { res.end(); return; }
            res.write(": heartbeat\n\n");
            session.lastBrowserSeen = Date.now();
          }, 20000);
          res.on("close", () => { clearInterval(timer); if (eventStreams.get(token) === res) eventStreams.delete(token); });
          return;
        }
        if (["GET", "HEAD"].includes(req.method) && url.pathname.startsWith("/api/media/")) {
          const mode = url.searchParams.get("mode") ?? "local";
          if (!(["local", "remote"].includes(mode) && (mode === "local" ? config.localEnabled : config.remoteEnabled))) return send(403, { error: "Этот режим выключен" });
          const match = /^\/api\/media\/(image|music|model3d|video|artifact)\/([^/]+)$/.exec(url.pathname);
          if (!match) return send(404, { error: "Файл не найден" });
          return await streamMedia(await (mode === "remote" ? await clientBackend(session.deviceId) : backend).media(match[1], decodeURIComponent(match[2]), req.method, req.headers.range));
        }
        if (req.method === "GET" && url.pathname === "/") { res.writeHead(302, { Location: "/app/" }); res.end(); return; }
        if (req.method === "GET" && url.pathname.startsWith("/app/")) {
          const name = decodeURIComponent(url.pathname.slice(5)) || "index.html";
          const root = await realpath(rendererDir);
          const file = await realpath(path.resolve(root, name));
          const relative = path.relative(root, file);
          if (relative.startsWith("..") || path.isAbsolute(relative) || !(await stat(file)).isFile() || !mime[path.extname(file)]) return send(404, { error: "Не найдено" });
          res.writeHead(200, { "Content-Type": mime[path.extname(file)] });
          const stream = createReadStream(file);
          stream.on("error", () => res.destroy()); res.on("close", () => stream.destroy()); stream.pipe(res); return;
        }
        send(404, { error: "Не найдено" });
      } catch {
        if (res.headersSent) res.destroy();
        else send(400, { error: "Не удалось выполнить запрос" });
      }
    });
    service.requestTimeout = 30000; service.headersTimeout = 10000;
    service.keepAliveTimeout = 5000; service.maxConnections = 128;
    await new Promise((resolve, reject) => {
      service.once("error", reject);
      service.listen(config.port, bindAddress, () => { service.removeListener("error", reject); resolve(); });
    });
    service.on("error", () => { error = "Ошибка HTTPS-сервера"; });
    server = service;
  };
  try { await start(); } catch (failure) { error = failure.message; }
  return {
    status: view,
    configure(input) {
      const update = async () => {
        const next = normalizeSettings(input);
        if (next.remoteEnabled && brokerError) throw new Error(brokerError);
        const credential = input.password ? await hashPassword(input.password) : config.credential;
        if ((next.localEnabled || next.remoteEnabled) && !credential) throw new Error("Задайте пароль от 12 символов");
        await stop();
        await atomicJson(path.join(dataDir, "web-access", "settings.json"), { ...next, credential });
        config = { ...next, credential }; certificate = undefined; error = brokerError;
        try { await start(input.renewCertificate === true); } catch (failure) { error = failure.message; }
        return view();
      };
      const pending = changing.then(update);
      changing = pending.catch(() => {});
      return pending;
    },
    publish,
    close: async () => { await changing; clearInterval(sessionSweep); await stop(); await broker.close(); await bridge.close(); },
  };
}
