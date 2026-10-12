import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";

/** Pi subprocess capabilities are device-scoped and never published to browsers. */
export async function createPrivateBridge(broker, enabled) {
  const tokens = new Map();
  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { if (!res.destroyed) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); } };
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const supplied = Buffer.from(token);
    let deviceId;
    for (const [id, credential] of tokens) {
      const expected = Buffer.from(credential);
      if (supplied.length === expected.length && timingSafeEqual(supplied, expected)) { deviceId = id; break; }
    }
    if (!deviceId || !enabled() || req.headers.origin || req.headers["sec-fetch-site"] || req.headers.host !== `127.0.0.1:${server.address().port}` || req.method !== "POST" || req.url !== "/invoke") return send(403, { error: "Forbidden" });
    const controller = new AbortController(); res.on("close", () => { if (!res.writableEnded) controller.abort(); });
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 16 * 1024 * 1024) throw new Error("Request too large"); chunks.push(chunk); }
      const { operation, args, timeout } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (typeof operation !== "string" || !args || typeof args !== "object") throw new Error("Invalid invocation");
      const result = await broker.invoke(deviceId, operation, args, { signal: controller.signal, timeout });
      send(200, { result });
    } catch (error) { send(400, { error: error.message }); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.maxConnections = 32;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    revoke(deviceId) { tokens.delete(deviceId); },
    credential(deviceId) {
      if (!tokens.has(deviceId)) tokens.set(deviceId, randomBytes(32).toString("hex"));
      return { url: `http://127.0.0.1:${server.address().port}/invoke`, token: tokens.get(deviceId) };
    },
    async close() { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); tokens.clear(); },
  };
}
