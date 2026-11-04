import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import remoteExecution from "../resources/remote-execution/index.ts";

test("Pi remote tools delegate all filesystem/command/desktop actions; client rules refresh per turn", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-remote-tools-test-"));
  const music = Buffer.alloc(9 * 1024 * 1024, 42);
  const commands = [], files = new Map([["C:\\CLIENT\\test.txt", Buffer.from("old\n")], ["C:\\CLIENT\\AGENTS.md", Buffer.from("Client rule ONE")], ["C:\\CLIENT\\track.flac", music]]);
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer private-capability");
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const invocation = JSON.parse(Buffer.concat(chunks).toString()); commands.push(invocation);
    const { operation, args } = invocation;
    let result;
    switch (operation) {
      case "stat": result = { exists: files.has(args.path) || args.path === "C:\\CLIENT", directory: args.path === "C:\\CLIENT", size: files.get(args.path)?.length, stamp: "unchanged" }; break;
      case "readChunk": assert.equal(args.stamp, "unchanged"); assert.equal(args.size, files.get(args.path).length); result = { data: files.get(args.path).subarray(args.offset, args.offset + 256 * 1024).toString("base64") }; break;
      case "read": result = { exists: files.has(args.path), data: files.get(args.path)?.toString("base64") }; break;
      case "mkdir": result = {}; break;
      case "write": {
        const before = files.get(args.path);
        if (args.expectedHash) assert.equal(args.expectedHash, createHash("sha256").update(before).digest("hex"));
        files.set(args.path, Buffer.from(args.content));
        result = { mutation: { path: args.path, before: before ? { kind: "text", text: before.toString() } : { kind: "missing" }, after: { kind: "text", text: args.content } } }; break;
      }
      case "ls": result = { names: ["test.txt"] }; break;
      case "find": result = { files: ["test.txt"] }; break;
      case "grep": result = { output: "CLIENT ONLY MATCH", truncated: false }; break;
      case "exec": result = { output: "CLIENT POWERSHELL OUTPUT", exitCode: 0 }; assert.equal(args.timeout, args.command === "LONG_COMMAND" ? 1200 : args.command === "Get-Location" ? 60 : 3600); assert.equal(invocation.timeout, args.timeout * 1000 + 10000); assert.equal(args.env, undefined); break;
      case "computer": result = { data: "client-image", width: 100, height: 80, x: -100, y: 0 }; break;
      default: throw new Error(`Unexpected helper operation ${operation}`);
    }
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ result }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const settings = { PI_DESKTOP_REMOTE_URL: `http://127.0.0.1:${server.address().port}`, PI_DESKTOP_REMOTE_TOKEN: "private-capability", PI_DESKTOP_REMOTE_CWD: "C:\\CLIENT", PI_DESKTOP_REMOTE_DEVICE: "test-device", PI_DESKTOP_DATA_DIR: directory };
  const previous = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]])); Object.assign(process.env, settings);
  t.after(async () => { for (const key of Object.keys(settings)) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key]; await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  const tools = new Map(), handlers = new Map();
  remoteExecution({ registerTool: tool => tools.set(tool.name, tool), on: (name, handler) => handlers.set(name, handler) });
  const call = (name, args) => tools.get(name).execute("test-call", args, undefined, undefined, {});
  assert((await call("read", { path: "test.txt" })).content[0].text.includes("old"));
  const edited = await call("edit", { path: "test.txt", edits: [{ oldText: "old", newText: "new" }] });
  assert.equal(edited.details.desktopFileMutation.before.text, "old\n");
  assert.equal(edited.details.desktopFileMutation.after.text, "new\n");
  await call("write", { path: "other.txt", content: "created" }); assert(files.has("C:\\CLIENT\\other.txt"));
  assert((await call("ls", { path: "." })).content[0].text.includes("test.txt"));
  assert((await call("find", { pattern: "*.txt" })).content[0].text.includes("test.txt"));
  assert.equal((await call("grep", { pattern: "new" })).content[0].text, "CLIENT ONLY MATCH");
  assert((await call("bash", { command: "Get-Location" })).content[0].text.includes("CLIENT POWERSHELL OUTPUT"));
  assert((await call("bash", { command: "LONG_COMMAND", timeout: 1200 })).content[0].text.includes("CLIENT POWERSHELL OUTPUT"));
  assert((await call("bash", { command: "cmake --build build" })).content[0].text.includes("CLIENT POWERSHELL OUTPUT"));
  assert((await call("bash", { command: ".\\compile.ps1" })).content[0].text.includes("CLIENT POWERSHELL OUTPUT"));
  assert.equal((await call("computer_use", { action: "screenshot" })).content[0].data, "client-image");
  const turn = await handlers.get("before_agent_start")({ systemPrompt: "GLOBAL HOST RULE" });
  assert(turn.systemPrompt.includes("GLOBAL HOST RULE")); assert(turn.systemPrompt.includes("Client rule ONE"));
  files.set("C:\\CLIENT\\AGENTS.md", Buffer.from("Client rule TWO"));
  const next = await handlers.get("before_agent_start")({ systemPrompt: "GLOBAL HOST RULE" });
  assert(next.systemPrompt.includes("Client rule TWO")); assert(!next.systemPrompt.includes("Client rule ONE"));
  assert.equal(tools.has("execute_elevated"), true);
  assert(commands.every(command => !command.args.env));
  assert.equal(commands.some(command => command.operation === "readChunk"), false); // Listing/ordinary work copies no media.
  const cover = { toolName: "media_cover_music", input: { audio: "C:\\CLIENT\\track.flac" } };
  await handlers.get("tool_call")(cover);
  assert(cover.input.audio.startsWith(path.join(directory, "remote-inputs", "test-device")));
  assert((await readFile(cover.input.audio)).equals(music));
  const transferred = commands.filter(command => command.operation === "readChunk").length;
  await handlers.get("tool_call")(cover); // Own approved server copy is reused, not guessed/read on host.
  assert.equal(commands.filter(command => command.operation === "readChunk").length, transferred);
});
