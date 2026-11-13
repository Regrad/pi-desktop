import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { startControlApi } from "../resources/control-api/server.mjs";

test("portable PowerShell client relocates, discovers API and preserves UTF-8", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-portable-client-"));
  let script = path.join(temporary, "Invoke-PiDesktop.ps1");
  await cp("resources/control-api/Invoke-PiDesktop.ps1", script);
  const snapshot = { conversation: { id: "portable-chat" }, messages: [], state: { isStreaming: false }, extensionUi: { pendingDialogs: [] } };
  let prompt;
  let reply;
  let selected;
  const api = await startControlApi({ dataDir: path.join(temporary, "data"), backend: {
    projects: () => [{ id: "p", name: "Проект после переноса" }],
    chats: () => [snapshot.conversation],
    inspect: async () => snapshot,
    create: async () => snapshot,
    attachments: async () => [],
    select: async (id) => { selected = id; },
    prompt: async (_id, message) => { prompt = message; snapshot.state.isStreaming = true; snapshot.run = { startedAt: new Date().toISOString() }; },
    reply: (_id, response) => { reply = response; snapshot.extensionUi.pendingDialogs = []; },
    abort: async () => { snapshot.state.isStreaming = false; snapshot.run.completedAt = new Date().toISOString(); },
  } });
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  const invoke = async (args) => {
    const command = `& ${quote(script)} ${args}`;
    return new Promise((resolve, reject) => {
      const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], { windowsHide: true });
      let stdout = "", stderr = "";
      const timer = setTimeout(() => { child.kill(); reject(new Error("PowerShell test timed out")); }, 15000);
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
      child.on("error", (error) => { clearTimeout(timer); reject(error); });
      child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  };
  try {
    let result = await invoke("-Action projects");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout)[0].name, "Проект после переноса");
    assert.equal(result.stdout.includes(api.connection.token), false);
    const application = path.join(temporary, "app"); await mkdir(application);
    await cp(script, path.join(application, "Invoke-PiDesktop.ps1")); script = path.join(application, "Invoke-PiDesktop.ps1");
    result = await invoke("-Action projects"); assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout)[0].name, "Проект после переноса");
    result = await invoke("-Action select -ConversationId 'portable-chat'");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(selected, "portable-chat");
    result = await invoke("-Action start -ProjectId 'p' -Message 'Проверь проект, без правок'");
    assert.equal(result.code, 0, result.stderr);
    const task = JSON.parse(result.stdout);
    assert.equal(prompt, "Проверь проект, без правок");
    result = await invoke(`-Action status -TaskId ${quote(task.id)}`);
    assert.equal(JSON.parse(result.stdout).status, "running");
    snapshot.extensionUi.pendingDialogs = [{ id: "q", method: "confirm" }];
    result = await invoke(`-Action reply -TaskId ${quote(task.id)} -QuestionId 'q' -Confirmed $false`);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(reply.confirmed, false);
    result = await invoke(`-Action abort -TaskId ${quote(task.id)}`);
    assert.equal(result.code, 0, result.stderr);
    result = await invoke(`-Action status -TaskId ${quote(task.id)}`);
    assert.equal(JSON.parse(result.stdout).status, "aborted");
    // A stale/malicious connection must not redirect the bearer key off localhost.
    const connectionPath = path.join(temporary, "data/control-api/connection.json");
    await writeFile(connectionPath, JSON.stringify({ ...api.connection, url: "http://example.com" }));
    result = await invoke("-Action projects");
    assert.notEqual(result.code, 0);
    assert.equal(result.stderr.includes(api.connection.token), false);
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    for (const name of ["CONNECT_CODEX.md", "Invoke-PiDesktop.ps1"]) {
      assert.ok(packageJson.build.extraFiles.some((entry) => entry.to === name), `${name} must be shipped beside executable`);
    }
    assert.equal(await readFile("CONNECT_CODEX.md", "utf8"), await readFile("release/Pi Desktop/app/CONNECT_CODEX.md", "utf8"));
    assert.equal(await readFile("resources/control-api/Invoke-PiDesktop.ps1", "utf8"), await readFile("release/Pi Desktop/app/Invoke-PiDesktop.ps1", "utf8"));
  } finally { await api.close(); await rm(temporary, { recursive: true, force: true }); }
});
