import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const appRoot = process.env.PI_TEST_APP_ROOT || process.cwd();
const { PiRpcProcess } = await import(pathToFileURL(path.join(appRoot, "dist-electron/electron/pi-rpc-process.js")));
const tempRoot = process.platform === "win32" ? "C:/AI_Temp" : tmpdir();

for (const context of ["ordinary chat", "additional project folders", "explicit global file"]) {
  test(`customization reaches model requests and reloads: ${context}`, { timeout: 30000 }, async () => {
    await mkdir(tempRoot, { recursive: true });
    const folder = await mkdtemp(path.join(tempRoot, "pi-customization-"));
    const agentDir = path.join(folder, "agent");
    await mkdir(agentDir);
    const globalFile = path.join(agentDir, "APPEND_SYSTEM.md");
    const projectContext = "Additional directories supplied by the user: C:/fixture-project";
    await writeFile(globalFile, "CUSTOM_RULE_BEFORE: Запрашивай разрешение перед правками.", "utf8");
    await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
    const captured = [];
    const server = http.createServer(async (req, res) => {
      if (req.method !== "POST") { res.writeHead(404).end(); return; }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      captured.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [
        { index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" },
      ] })}\n\ndata: [DONE]\n\n`);
    });
    let rpc;
    try {
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "fixture",
        models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 256 }],
      } } }));
      let settle;
      rpc = new PiRpcProcess({
        executablePath: process.env.PI_TEST_EXECUTABLE || process.execPath,
        enginePath: path.join(appRoot, "resources/pi-engine/worker.mjs"),
        cwd: folder, agentDir, sessionsDir: path.join(folder, "sessions"), sessionId: "customization-fixture",
        provider: "fixture", model: "fixture", isolatedExtensions: [],
        appendSystemPrompt: context === "additional project folders" ? projectContext
          : context === "explicit global file" ? globalFile : undefined,
        mcpEntryPath: "unused", mcpDirectTools: [], onExtensionUi() {}, onExit() {},
        onEvent(event) { if (event.type === "agent_settled") settle?.(); },
      });
      const prompt = async () => {
        const done = new Promise(resolve => { settle = resolve; });
        await rpc.request("prompt", { message: "Read the instructions." });
        await done;
        const request = captured.at(-1);
        assert.ok(request, "No request reached the fixture provider");
        return request.messages.filter(message => ["system", "developer"].includes(message.role))
          .map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
      };
      const checkProject = system => {
        if (context === "additional project folders") assert.ok(system.includes(projectContext));
      };
      await rpc.start();
      let system = await prompt();
      assert.equal(system.split("CUSTOM_RULE_BEFORE").length - 1, 1, "Global rules must appear exactly once");
      assert.ok(system.includes("Запрашивай разрешение перед правками."));
      checkProject(system);

      await writeFile(globalFile, "CUSTOM_RULE_AFTER: Updated rules.", "utf8");
      await rpc.request("reload");
      system = await prompt();
      assert.equal(system.split("CUSTOM_RULE_AFTER").length - 1, 1);
      assert.ok(!system.includes("CUSTOM_RULE_BEFORE"), "Reload kept obsolete rules");
      checkProject(system);

      await writeFile(globalFile, "", "utf8");
      await rpc.request("reload");
      system = await prompt();
      assert.ok(!system.includes("CUSTOM_RULE_AFTER"), "Clearing customization kept obsolete rules");
      assert.ok(!system.includes(globalFile), "A file path leaked into the system prompt");
      checkProject(system);
    } finally {
      await rpc?.stop();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      assert.ok(path.resolve(folder).startsWith(path.resolve(tempRoot) + path.sep));
      await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}
