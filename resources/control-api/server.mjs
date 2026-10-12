import http from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";

// Local bearer capability: never listen on the LAN or accept browser requests.
export async function startControlApi({ dataDir, backend }) {
  const token = randomBytes(32).toString("hex");
  const jobs = new Map();
  const discovery = path.join(dataDir, "control-api", "connection.json");
  let closing = false;
  const limitedText = (value, limit = 8000) => String(value ?? "").slice(0, limit);
  const messageKey = (message) => createHash("sha256").update(JSON.stringify(message)).digest("hex");
  const textContent = (message) => {
    if (typeof message?.content === "string") return message.content;
    return (message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
  };
  const summarize = (job, snapshot, includeDiff = false) => {
    if (!job.result) {
      const answers = snapshot.messages.filter((m) => m.role === "assistant" && !job.baseline.has(messageKey(m)));
      const latest = answers.at(-1);
      const settled = snapshot.run?.completedAt && Date.parse(snapshot.run.completedAt) >= Date.parse(job.startedAt);
      const busy = !job.error && (job.pending || snapshot.state.isStreaming || snapshot.state.isCompacting || (!settled && !job.aborted) || (settled && !snapshot.run.diff && !snapshot.run.diffError && !job.aborted));
      const questions = snapshot.extensionUi.pendingDialogs;
      const status = job.error ? "failed" : questions.length ? "needs_input" : busy ? "running" : job.aborted || latest?.stopReason === "aborted" ? "aborted" : latest?.stopReason === "error" ? "failed" : "completed";
      const diff = snapshot.run?.diff;
      const result = {
        id: job.id, conversationId: job.conversationId, status, startedAt: job.startedAt,
        result: busy ? undefined : limitedText(textContent(latest)),
        error: job.error ?? latest?.errorMessage, questions, diffError: snapshot.run?.diffError,
        changes: diff ? { additions: diff.additions, deletions: diff.deletions, incomplete: diff.incomplete,
          files: diff.files.map(({ path, status, additions, deletions }) => ({ path, status, additions, deletions })) } : undefined,
      };
      if (["completed", "failed", "aborted"].includes(status)) {
        // Preserve this task's result before the same chat starts another task.
        job.result = result;
        job.diff = limitedText(JSON.stringify(diff), 64000);
        job.baseline.clear();
      }
      if (!job.result) return result;
    }
    return { ...job.result, ...(includeDiff ? { diff: job.diff } : {}) };
  };
  const server = http.createServer(async (req, res) => {
    const send = (code, value) => {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    const supplied = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (req.headers.origin || req.headers["sec-fetch-site"] ||
        req.headers.host !== `127.0.0.1:${server.address()?.port}` ||
        supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      send(403, { error: "Forbidden" }); return;
    }
    if (closing) { send(503, { error: "Shutting down" }); return; }
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/projects") {
        send(200, backend.projects()); return;
      }
      if (req.method === "GET" && url.pathname === "/chats") {
        send(200, backend.chats()); return;
      }
      let body = {};
      if (req.method === "POST") {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024) { send(413, { error: "Request too large" }); return; }
          chunks.push(chunk);
        }
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected object");
      }
      if (req.method === "POST" && url.pathname === "/tasks") {
        if (jobs.size >= 1000) { send(503, { error: "Task capacity reached; restart Pi Desktop" }); return; }
        if (typeof body.message !== "string" || !body.message.trim()) throw new Error("message is required");
        if (body.projectId !== undefined && typeof body.projectId !== "string") throw new Error("Invalid projectId");
        if (body.conversationId !== undefined && typeof body.conversationId !== "string") throw new Error("Invalid conversationId");
        if (body.paths !== undefined && (!Array.isArray(body.paths) || body.paths.length > 20 || body.paths.some((p) => typeof p !== "string" || !path.isAbsolute(p)))) throw new Error("Use up to 20 absolute attachment paths");
        const attachments = await backend.attachments(body.paths ?? []);
        const snapshot = body.conversationId
          ? await backend.inspect(body.conversationId)
          : await backend.create(body.projectId);
        const conversationId = snapshot.conversation.id;
        for (const previous of jobs.values()) {
          if (previous.conversationId !== conversationId) continue;
          const previousStatus = summarize(previous, snapshot).status;
          if (previousStatus === "running" || previousStatus === "needs_input") {
            send(409, { error: "Conversation is busy" }); return;
          }
        }
        if (snapshot.state.isStreaming || [...jobs.values()].some((j) => j.conversationId === conversationId && j.pending)) {
          send(409, { error: "Conversation is busy" }); return;
        }
        const id = randomUUID();
        const job = { id, conversationId, baseline: new Set(snapshot.messages.filter((m) => m.role === "assistant").map(messageKey)), pending: true, startedAt: new Date().toISOString() };
        jobs.set(id, job);
        try { await backend.select(conversationId); }
        catch (error) { jobs.delete(id); throw error; }
        // Do not wait for the model in the HTTP request. Rejects are retained for status.
        Promise.resolve().then(() => job.aborted ? undefined : backend.prompt(conversationId, body.message, attachments)).catch((error) => {
          job.error = limitedText(error.message, 2000);
        }).finally(() => { job.pending = false; });
        send(202, { id, conversationId }); return;
      }
      if (req.method === "POST" && url.pathname === "/select") {
        if (typeof body.conversationId !== "string") throw new Error("conversationId is required");
        await backend.select(body.conversationId);
        send(200, { ok: true }); return;
      }
      const match = /^\/tasks\/([^/]+)(?:\/(abort|reply))?$/.exec(url.pathname);
      const job = match && jobs.get(match[1]);
      if (!job) { send(404, { error: "Not found" }); return; }
      const snapshot = await backend.inspect(job.conversationId);
      if (req.method === "GET" && !match[2]) {
        send(200, summarize(job, snapshot, url.searchParams.get("diff") === "true")); return;
      }
      if (job.result) { send(409, { error: "Task already settled" }); return; }
      if (req.method === "POST" && match[2] === "abort") {
        job.aborted = true;
        await backend.abort(job.conversationId);
        send(200, { ok: true }); return;
      }
      if (req.method === "POST" && match[2] === "reply") {
        const question = snapshot.extensionUi.pendingDialogs.find((q) => q.id === body.id);
        if (!question) throw new Error("Unknown pending question");
        if (body.cancelled !== undefined && typeof body.cancelled !== "boolean") throw new Error("cancelled must be boolean");
        if (!body.cancelled) {
          if (question.method === "confirm" && typeof body.confirmed !== "boolean") throw new Error("confirmed must be boolean");
          if (["input", "editor", "select"].includes(question.method) && typeof body.value !== "string") throw new Error("value must be string");
          if (question.method === "select" && !question.options?.includes(body.value)) throw new Error("Select an offered option");
          if (question.method === "custom" && typeof body.customInput !== "string") throw new Error("customInput must be string");
        }
        // Forward only the response fields supported by Pi RPC.
        backend.reply(job.conversationId, { id: body.id, value: body.value, confirmed: body.confirmed, cancelled: body.cancelled, customInput: body.customInput });
        send(200, { ok: true }); return;
      }
      send(405, { error: "Method not allowed" });
    } catch (error) { send(400, { error: limitedText(error.message, 2000) }); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxConnections = 32;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const connection = { url: `http://127.0.0.1:${server.address().port}`, token, pid: process.pid };
  try {
    await mkdir(path.dirname(discovery), { recursive: true });
    await writeFile(discovery, JSON.stringify(connection, null, 2), { mode: 0o600 });
  } catch (error) { server.close(); throw error; }
  return {
    connection,
    settled(conversationId, snapshot) {
      for (const job of jobs.values()) {
        if (job.conversationId !== conversationId || job.result) continue;
        job.pending = false;
        summarize(job, snapshot);
      }
    },
    async close() {
      closing = true;
      await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
      await unlink(discovery).catch((error) => { if (error.code !== "ENOENT") throw error; });
    },
  };
}
