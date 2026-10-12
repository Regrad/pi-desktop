import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startControlApi } from "../resources/control-api/server.mjs";

test("local API authentication, visible selection, jobs, questions, diff and MCP", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pi-control-test-"));
  const snapshots = new Map();
  const selected = [];
  const prompts = [];
  const replies = [];
  let counter = 0;
  const api = await startControlApi({ dataDir, backend: {
    projects: () => [{ id: "project", paths: ["C:/workspace"] }],
    chats: () => [...snapshots.values()].map((s) => s.conversation),
    create: async (projectId) => {
      const snapshot = { conversation: { id: `chat-${++counter}`, projectId }, state: { isStreaming: false }, messages: [], extensionUi: { pendingDialogs: [] } };
      snapshots.set(snapshot.conversation.id, snapshot);
      return snapshot;
    },
    inspect: async (id) => { if (!snapshots.has(id)) throw new Error("Unknown chat"); return snapshots.get(id); },
    select: async (id) => { selected.push(id); },
    attachments: async (paths) => paths.map((p) => ({ path: p })),
    prompt: async (id, message, attachments) => {
      assert.equal(selected.at(-1), id, "chat must be visible before prompt");
      if (message === "fail") throw new Error("Model unavailable");
      prompts.push({ id, message, attachments });
      const snapshot = snapshots.get(id);
      snapshot.state.isStreaming = true;
      snapshot.run = { startedAt: new Date().toISOString() };
    },
    abort: async (id) => { const s = snapshots.get(id); s.state.isStreaming = false; s.run.completedAt = new Date().toISOString(); },
    reply: (id, response) => { replies.push({ id, response }); snapshots.get(id).extensionUi.pendingDialogs = []; },
  } });
  const request = (route, body, headers = {}) => fetch(api.connection.url + route, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${api.connection.token}`, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = async (route, body) => (await request(route, body)).json();
  let client;
  try {
    const credentialsPath = path.join(dataDir, "control-api", "connection.json");
    assert.deepEqual(JSON.parse(await readFile(credentialsPath, "utf8")), api.connection);
    assert.equal((await fetch(api.connection.url + "/projects")).status, 403);
    assert.equal((await request("/projects", undefined, { Origin: "http://evil.example" })).status, 403);
    const wrongHostStatus = await new Promise((resolve, reject) => {
      const req = http.get(api.connection.url + "/projects", { headers: { Host: "evil.example", Authorization: `Bearer ${api.connection.token}` } }, (response) => { response.resume(); resolve(response.statusCode); });
      req.on("error", reject);
    });
    assert.equal(wrongHostStatus, 403);
    assert.equal((await request("/tasks", { message: "x", paths: ["relative.png"] })).status, 400);
    assert.equal((await request("/tasks", { message: " " })).status, 400);
    const task = await json("/tasks", { message: "Implement only the requested change", projectId: "project" });
    assert.ok(task.id);
    assert.equal(prompts.length, 1);
    assert.equal((await json(`/tasks/${task.id}`)).status, "running");
    assert.equal((await request("/tasks", { message: "duplicate", conversationId: task.conversationId })).status, 409);
    const snapshot = snapshots.get(task.conversationId);
    snapshot.extensionUi.pendingDialogs = [{ id: "question", method: "confirm", title: "Proceed?" }];
    assert.equal((await json(`/tasks/${task.id}`)).status, "needs_input");
    assert.equal((await request(`/tasks/${task.id}/reply`, { id: "wrong", confirmed: true })).status, 400);
    await json(`/tasks/${task.id}/reply`, { id: "question", confirmed: true, ignored: "not forwarded" });
    assert.equal(replies[0].response.confirmed, true);
    assert.equal(replies[0].response.ignored, undefined);
    snapshot.state.isStreaming = false;
    snapshot.messages.push({ role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "Done" }], stopReason: "stop" });
    snapshot.run.completedAt = new Date().toISOString();
    snapshot.run.diff = { additions: 1, deletions: 0, incomplete: false, files: [{ path: "C:/workspace/a.ts", status: "modified", additions: 1, deletions: 0, hunks: [{ lines: ["+change"] }] }] };
    const result = await json(`/tasks/${task.id}`);
    assert.equal(result.status, "completed");
    assert.equal(result.result, "Done");
    assert.equal(result.diff, undefined);
    assert.equal(result.changes.files[0].hunks, undefined);
    assert.match((await json(`/tasks/${task.id}?diff=true`)).diff, /change/);
    await json("/select", { conversationId: task.conversationId });
    const followUp = await json("/tasks", { conversationId: task.conversationId, message: "Next task" });
    assert.equal((await json(`/tasks/${followUp.id}`)).result, undefined, "old answer is not a new result");
    await json(`/tasks/${followUp.id}/abort`, {});
    assert.equal((await json(`/tasks/${followUp.id}`)).status, "aborted");
    const compacted = await json("/tasks", { conversationId: task.conversationId, message: "Task with compaction" });
    snapshot.messages = [{ role: "assistant", timestamp: Date.now(), content: [{ type: "text", text: "New result after compaction" }] }];
    snapshot.state.isStreaming = false;
    snapshot.run.completedAt = new Date().toISOString();
    snapshot.run.diff = { files: [], additions: 0, deletions: 0, incomplete: false };
    api.settled(task.conversationId, snapshot);
    snapshot.messages.push({ role: "assistant", content: [{ type: "text", text: "Manual next turn" }] });
    assert.equal((await json(`/tasks/${compacted.id}`)).result, "New result after compaction");
    const failed = await json("/tasks", { message: "fail" });
    assert.equal((await json(`/tasks/${failed.id}`)).status, "failed");

    client = new Client({ name: "test", version: "1" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.resolve("resources/control-api/mcp.mjs"), credentialsPath] }));
    const catalog = await client.listTools();
    assert.equal(catalog.tools.length, 7);
    const projects = await client.callTool({ name: "pi_desktop_projects", arguments: {} });
    assert.equal(JSON.parse(projects.content[0].text)[0].id, "project");
    const mcpStatus = await client.callTool({ name: "pi_desktop_status", arguments: { taskId: task.id } });
    assert.equal(JSON.parse(mcpStatus.content[0].text).result, "Done", "later tasks must not overwrite earlier results");
    const invalid = await client.callTool({ name: "pi_desktop_status", arguments: { taskId: "../../projects" } });
    assert.equal(invalid.isError, true);
  } finally {
    await client?.close();
    await api.close();
    await assert.rejects(readFile(path.join(dataDir, "control-api", "connection.json")), { code: "ENOENT" });
    await rm(dataDir, { recursive: true, force: true });
  }
});
