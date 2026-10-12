import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicJson } from "./security.mjs";

const digest = value => createHash("sha256").update(value).digest("hex");
const equal = (left, right) => typeof left === "string" && typeof right === "string" && left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));

/** Authenticated reverse transport. A command is dequeued once, never replayed. */
export async function createDeviceBroker({ dataDir, onDisconnect = () => {} }) {
  const file = path.join(dataDir, "web-access", "devices.json");
  let registry = { devices: {}, cookieKey: randomBytes(32).toString("hex") };
  try { registry = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; await atomicJson(file, registry); }
  if (!/^[a-f0-9]{64}$/.test(registry.cookieKey) || !registry.devices || typeof registry.devices !== "object" || Array.isArray(registry.devices) || Object.entries(registry.devices).some(([id, value]) => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id) || !value || !/^[a-f0-9]{64}$/.test(value.secretHash) || typeof value.cwd !== "string" || typeof value.name !== "string")) throw new Error("Повреждена привязка устройств");
  const pairs = new Map(), connections = new Map(), byDevice = new Map();
  let saves = Promise.resolve();
  const save = () => {
    const value = structuredClone(registry);
    const next = saves.then(() => atomicJson(file, value)); saves = next.catch(() => {}); return next;
  };
  const cookieFor = id => `${id}.${createHmac("sha256", registry.cookieKey).update(id).digest("hex")}`;
  const deviceFromCookie = cookie => {
    const match = /^([a-f0-9-]{36})\.([a-f0-9]{64})$/.exec(cookie ?? "");
    return match && registry.devices[match[1]] && equal(cookieFor(match[1]), cookie) ? match[1] : undefined;
  };
  const disconnect = (connection, reason = "Клиентский компьютер отключён") => {
    if (!connection || !connections.has(connection.token)) return;
    connections.delete(connection.token);
    if (byDevice.get(connection.deviceId) === connection) byDevice.delete(connection.deviceId);
    connection.poll?.({ stop: true }); connection.poll = undefined;
    for (const pending of connection.pending.values()) { clearTimeout(pending.timer); pending.cleanup(); pending.reject(new Error(reason)); }
    connection.pending.clear(); connection.queue = [];
    onDisconnect(connection.deviceId, reason);
  };
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [token, pair] of pairs) if (pair.expires < now) pairs.delete(token);
    for (const connection of connections.values()) if (now - connection.lastSeen > 60000) disconnect(connection, "Потеряно соединение с клиентским компьютером; команды не повторяются автоматически");
  }, 10000); sweep.unref();
  const requireConnection = token => {
    const connection = connections.get(token);
    if (!connection) throw new Error("Подключение помощника завершено");
    connection.lastSeen = Date.now(); return connection;
  };
  return {
    cookieFor, deviceFromCookie,
    info(id) { const value = registry.devices[id]; return value ? { id, name: value.name, cwd: value.cwd, drives: value.drives ?? [path.win32.parse(value.cwd).root], connected: byDevice.has(id) } : undefined; },
    pair(sessionId) {
      if (pairs.size >= 100) throw new Error("Слишком много ожидающих подключений");
      const token = randomBytes(32).toString("hex");
      pairs.set(token, { sessionId, expires: Date.now() + 120000 }); return token;
    },
    async connect(input) {
      const pair = pairs.get(input.token); pairs.delete(input.token);
      if (!pair || pair.expires < Date.now()) throw new Error("Приглашение истекло. Нажмите подключение на сайте заново.");
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.deviceId ?? "") || !/^[a-f0-9]{64}$/.test(input.secret ?? "") || input.os !== "windows" || typeof input.cwd !== "string" || !/^[a-z]:[\\/]/i.test(input.cwd) || typeof input.name !== "string" || input.name.length > 100) throw new Error("Неверные данные помощника");
      const known = registry.devices[input.deviceId];
      if (input.drives !== undefined && (!Array.isArray(input.drives) || input.drives.length > 26 || input.drives.some(drive => typeof drive !== "string" || !/^[a-z]:\\$/i.test(drive)))) throw new Error("Неверные диски клиентского ПК");
      if (known && !equal(known.secretHash, digest(input.secret))) throw new Error("Не подтверждена принадлежность устройства");
      registry.devices[input.deviceId] = { name: input.name, cwd: input.cwd, drives: input.drives, secretHash: digest(input.secret) };
      await save();
      disconnect(byDevice.get(input.deviceId), "Подключено новое соединение этого устройства");
      const token = randomBytes(32).toString("hex");
      const connection = { deviceId: input.deviceId, sessionId: pair.sessionId, token, lastSeen: Date.now(), queue: [], pending: new Map() };
      connections.set(token, connection); byDevice.set(input.deviceId, connection);
      return { token, deviceId: input.deviceId, sessionId: pair.sessionId };
    },
    connection(token) { return requireConnection(token); },
    async poll(token) {
      const connection = requireConnection(token);
      if (connection.poll) throw new Error("Помощник уже ожидает команду");
      if (connection.queue.length) return { command: connection.queue.shift() };
      return new Promise(resolve => {
        const finish = value => { clearTimeout(timer); connection.poll = undefined; resolve(value); };
        const timer = setTimeout(() => finish({ heartbeat: true }), 20000);
        connection.poll = finish;
      });
    },
    result(token, id, result, error) {
      const connection = requireConnection(token);
      const pending = connection.pending.get(id);
      if (!pending) return false; // Late/duplicate results never cause execution.
      connection.pending.delete(id); clearTimeout(pending.timer); pending.cleanup();
      error ? pending.reject(new Error(String(error).slice(0, 2000))) : pending.resolve(result);
      return true;
    },
    invoke(deviceId, operation, args = {}, { signal, timeout = 180000 } = {}) {
      const connection = byDevice.get(deviceId);
      if (!connection) return Promise.reject(new Error("Клиентский компьютер не подключён. Серверный ПК не используется вместо него."));
      if (connection.pending.size >= 32 || signal?.aborted) return Promise.reject(new Error("Вызов отменён или помощник занят"));
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const cancel = () => {
          connection.pending.delete(id); clearTimeout(timer); cleanup();
          connection.queue = connection.queue.filter(command => command.id !== id);
          const command = { id: randomUUID(), operation: "cancel", args: { id } };
          connection.poll ? connection.poll({ command }) : connection.queue.push(command);
          reject(new Error("Команда отменена. Если запись уже началась, её результат может быть неизвестен; автоматического повтора нет."));
        };
        const cleanup = () => signal?.removeEventListener("abort", cancel);
        const timer = setTimeout(cancel, Math.min(Math.max(timeout, 1000), 3600000));
        signal?.addEventListener("abort", cancel, { once: true });
        connection.pending.set(id, { resolve, reject, timer, cleanup });
        const command = { id, operation, args };
        connection.poll ? connection.poll({ command }) : connection.queue.push(command);
      });
    },
    disconnectDevice(id) { disconnect(byDevice.get(id)); },
    disconnectSession(id) {
      for (const [token, pair] of pairs) if (pair.sessionId === id) pairs.delete(token);
      for (const connection of connections.values()) if (connection.sessionId === id) disconnect(connection);
    },
    disconnectAll() { pairs.clear(); for (const connection of connections.values()) disconnect(connection); },
    async close() { clearInterval(sweep); this.disconnectAll(); await saves; },
  };
}
