import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeviceBroker } from "../resources/web-access/device-broker.mjs";
import { createPrivateBridge } from "../resources/web-access/private-bridge.mjs";
import { collectMediaGrants } from "../resources/web-access/media-grants.mjs";

test("device authentication, persistent cookies, isolated reverse commands, cancellation without replay", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-device-test-"));
  let broker = await createDeviceBroker({ dataDir: directory });
  t.after(async () => { await broker.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  const identify = (deviceId = randomUUID(), secret = "a".repeat(64)) => ({ deviceId, secret, name: "CLIENT", cwd: "C:\\Users\\test", os: "windows" });
  const firstIdentity = identify();
  const pair = broker.pair("browser1");
  const first = await broker.connect({ token: pair, ...firstIdentity });
  await assert.rejects(broker.connect({ token: pair, ...firstIdentity }));
  const second = await broker.connect({ token: broker.pair("browser2"), ...identify() });
  const cookie = broker.cookieFor(first.deviceId);
  assert.equal(broker.deviceFromCookie(cookie), first.deviceId);
  assert.equal(broker.deviceFromCookie(cookie.replace(first.deviceId, second.deviceId)), undefined);
  assert.equal(broker.deviceFromCookie(cookie + "extra"), undefined);
  await assert.rejects(broker.connect({ token: broker.pair("attacker"), ...firstIdentity, secret: "b".repeat(64) }));
  await assert.rejects(broker.invoke(randomUUID(), "write", {}), /Серверный ПК/);

  const write = broker.invoke(first.deviceId, "write", { path: "C:\\file.txt", content: "one" });
  const { command } = await broker.poll(first.token);
  assert.equal(command.operation, "write");
  assert.equal(broker.result(second.token, command.id, { wrong: true }), false);
  broker.result(first.token, command.id, { saved: true });
  assert.deepEqual(await write, { saved: true });
  assert.equal(broker.result(first.token, command.id, { saved: false }), false);
  const waiting = broker.poll(first.token);
  const abort = new AbortController();
  const exec = broker.invoke(first.deviceId, "exec", {}, { signal: abort.signal });
  const executable = (await waiting).command;
  assert.notEqual(executable.id, command.id); // Original write was not replayed.
  abort.abort(); await assert.rejects(exec, /автоматического повтора нет/);
  assert.equal((await broker.poll(first.token)).command.operation, "cancel");
  assert.equal(broker.result(first.token, executable.id, { late: true }), false);
  const pending = broker.invoke(second.deviceId, "write");
  broker.disconnectSession("browser2"); await assert.rejects(pending);
  assert.equal(broker.info(second.deviceId).connected, false);
  assert.equal(broker.info(first.deviceId).connected, true);
  await broker.close(); broker = await createDeviceBroker({ dataDir: directory });
  assert.equal(broker.deviceFromCookie(cookie), first.deviceId);
  const reconnect = await broker.connect({ token: broker.pair("new-browser"), ...firstIdentity });
  assert.equal(reconnect.deviceId, first.deviceId);
});

test("private Pi transport is authenticated, device scoped and fail-closed", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-private-test-"));
  const broker = await createDeviceBroker({ dataDir: directory }); let enabled = true;
  const bridge = await createPrivateBridge(broker, () => enabled);
  t.after(async () => { await bridge.close(); await broker.close(); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  const device = await broker.connect({ token: broker.pair("browser"), deviceId: randomUUID(), secret: "f".repeat(64), name: "CLIENT", cwd: "C:\\Users\\test", os: "windows" });
  const { url, token } = bridge.credential(device.deviceId);
  const request = (extra = {}) => fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...extra }, body: JSON.stringify({ operation: "read", args: { path: "C:\\file.txt" } }) });
  assert.equal((await request({ Authorization: "Bearer wrong" })).status, 403);
  assert.equal((await request({ Origin: "http://evil.test" })).status, 403);
  const call = request(); const { command } = await broker.poll(device.token);
  assert.equal(command.args.path, "C:\\file.txt");
  broker.result(device.token, command.id, { exists: true, data: "YQ==" });
  assert.equal((await call).status, 200);
  bridge.revoke(device.deviceId); assert.equal((await request()).status, 403);
  assert.notEqual(bridge.credential(device.deviceId).token, token);
  enabled = false; assert.equal((await request()).status, 403);
});

test("media grants exclude arbitrary text, nested paths and file content", () => {
  const root = path.resolve("fixture-data"); const grants = new Set();
  collectMediaGrants({ files: [path.join(root, "music-generation", "own.flac"), path.join(root, "image-generation", "own.png")], text: path.join(root, "image-generation", "not-owned.png"), before: { text: path.join(root, "image-generation", "bad.png") }, path: path.join(root, "3d-generation", "subfolder", "bad.glb") }, root, grants);
  assert.deepEqual([...grants].sort(), ["image/own.png", "music/own.flac"]);
});
