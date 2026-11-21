import { lookup } from "node:dns";
import { lookup as resolveHostname } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch } from "undici";
import ipaddr from "ipaddr.js";

export function isPublicAddress(address) {
  const range = ipaddr.process(address).range();
  return range === "unicast";
}

function lookupPublic(hostname, options, callback) {
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
      return callback(new Error("Page resolves to a private or reserved network address"));
    }
    const candidates = options.family ? addresses.filter(address => address.family === options.family) : addresses;
    if (!candidates.length) return callback(new Error("No matching public network address"));
    if (options.all) return callback(null, candidates);
    return callback(null, candidates[0].address, candidates[0].family);
  });
}

const publicTransport = new Agent({ connect: { lookup: lookupPublic } });
const configuredProviderTransport = new Agent();
const maxBytes = 2 * 1024 * 1024;

function httpUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Only HTTP and HTTPS URLs without embedded credentials are supported");
  }
  return url;
}

export function publicUrl(value) {
  const url = httpUrl(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (url.href.length > 4096 || url.port || (isIP(hostname) ? !isPublicAddress(hostname) : !hostname.includes("."))) {
    throw new Error("Only public website URLs on standard HTTP and HTTPS ports are supported");
  }
  url.hash = "";
  return url;
}

export async function resolvePublicUrl(value) {
  const url = publicUrl(value);
  const addresses = await resolveHostname(url.hostname.replace(/^\[|\]$/g, ""), { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new Error("Page resolves to a private or reserved network address");
  }
  return url;
}

async function readBounded(response) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, bytes);
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("Page exceeds the reading limit");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function requestSignal(signal, milliseconds) {
  if (milliseconds === 0) return signal;
  const timeout = AbortSignal.timeout(Number.isSafeInteger(milliseconds) && milliseconds > 0 ? Math.min(milliseconds, 120_000) : 12_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function requestText(input, { configuredProvider = false, ...options } = {}) {
  const url = configuredProvider ? httpUrl(input) : publicUrl(input);
  const dispatcher = configuredProvider ? configuredProviderTransport : publicTransport;
  const response = await fetch(url, { ...options, redirect: "manual", dispatcher });
  if (!response.ok) {
    await response.body?.cancel();
    if ([301, 302, 303, 307, 308].includes(response.status)) throw new Error("Unexpected provider redirect");
    throw new Error(`HTTP ${response.status}`);
  }
  return (await readBounded(response)).toString("utf8");
}
