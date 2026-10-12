import { randomBytes, scrypt as scryptCallback, timingSafeEqual, X509Certificate } from "node:crypto";
import { promisify } from "node:util";
import { isIP } from "node:net";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { generate } from "selfsigned";

const scrypt = promisify(scryptCallback);
export const defaults = Object.freeze({ localEnabled: false, remoteEnabled: false, address: "pikawow.fun", port: 1369, username: "" });

export function normalizeSettings(input) {
  if (!input || typeof input !== "object" || typeof input.localEnabled !== "boolean" || typeof input.remoteEnabled !== "boolean") throw new Error("Неверные настройки веб-доступа");
  const address = String(input.address ?? "").trim().toLowerCase();
  if (!address || address.length > 253 || (!isIP(address) && address.split(".").some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) throw new Error("Укажите домен или IP без протокола, пути и порта");
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Порт должен быть от 1024 до 65535");
  const username = String(input.username ?? "").trim();
  if (username.length > 100 || /[\x00-\x1f]/.test(username)) throw new Error("Неверный логин");
  if ((input.localEnabled || input.remoteEnabled) && !username) throw new Error("Задайте логин");
  return { localEnabled: input.localEnabled, remoteEnabled: input.remoteEnabled, address, port, username };
}

export async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12 || Buffer.byteLength(password) > 1024) throw new Error("Пароль должен содержать от 12 символов (до 1024 байт)");
  const salt = randomBytes(32).toString("hex");
  const hash = await scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { salt, hash: hash.toString("hex") };
}

export async function verifyPassword(password, credential) {
  if (typeof password !== "string" || Buffer.byteLength(password) > 1024) return false;
  const hash = await scrypt(password, credential.salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const expected = Buffer.from(credential.hash, "hex");
  return expected.length === hash.length && timingSafeEqual(expected, hash);
}

export async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporary, file);
}

export async function readSettings(dataDir) {
  try {
    const value = JSON.parse(await readFile(path.join(dataDir, "web-access", "settings.json"), "utf8"));
    const settings = normalizeSettings(value);
    if ((settings.localEnabled || settings.remoteEnabled) && (!/^[a-f0-9]{64}$/.test(value.credential?.salt ?? "") || !/^[a-f0-9]{64}$/.test(value.credential?.hash ?? ""))) throw new Error("Повреждены данные входа");
    return { ...settings, credential: value.credential };
  } catch (error) {
    if (error.code === "ENOENT") return { ...defaults };
    throw error;
  }
}

export async function certificateFor(dataDir, address, renew = false) {
  const file = path.join(dataDir, "web-access", "certificate.json");
  let value;
  try { if (!renew) value = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  // Do not silently replace a trusted identity after corruption/expiry.
  if (value?.address === address) {
    const certificate = new X509Certificate(value.cert);
    if (Date.parse(certificate.validTo) <= Date.now()) throw new Error("Сертификат истёк. Создайте новый и заново сверяйте отпечаток на клиентах.");
    return { ...value, fingerprint: certificate.fingerprint256, validTo: certificate.validTo };
  }
  const issued = await generate([{ name: "commonName", value: address }], {
    keyType: "ec", curve: "P-256", algorithm: "sha256",
    notBeforeDate: new Date(Date.now() - 5 * 60000),
    notAfterDate: new Date(Date.now() + 365 * 86400000),
    extensions: [
      { name: "basicConstraints", cA: false, critical: true },
      { name: "keyUsage", digitalSignature: true, critical: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [isIP(address) ? { type: 7, ip: address } : { type: 2, value: address }] },
    ],
  });
  value = { address, cert: issued.cert, key: issued.private };
  await atomicJson(file, value);
  const certificate = new X509Certificate(value.cert);
  return { ...value, fingerprint: certificate.fingerprint256, validTo: certificate.validTo };
}
