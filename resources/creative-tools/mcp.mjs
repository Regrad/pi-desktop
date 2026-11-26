// Invoked only when the model explicitly connects the corresponding MCP server.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, access, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readEditorSettings, resolveEditor, materializeResources } from "./runtime.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const name = process.argv[2];
const agentDir = process.env.PI_CODING_AGENT_DIR;
if (!agentDir) throw new Error("Pi Desktop agent directory is required.");

try {
  const settings = await readEditorSettings(agentDir, name);
  const executable = await resolveEditor(name, settings);
  if (name === "blender") {
    const { startBlenderServer } = await import("./blender.mjs");
    await startBlenderServer(executable);
  } else if (name === "aseprite") {
    const packageDir = path.join(root, "node_modules", "@pebbly", "aseprite-ai-artist");
    const version = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8")).version;
    // Aseprite's Lua interpreter cannot read ASAR. Materialize these optional
    // resources once, on demand; the distributed application stays packed.
    let resourceRoot = packageDir;
    if (root.includes(`${path.sep}app.asar${path.sep}`)) {
      const cacheRoot = path.join(path.dirname(agentDir), "runtime", "creative-tools");
      resourceRoot = path.join(cacheRoot, `aseprite-${version}`);
      try { await access(path.join(resourceRoot, "headless", "runner.lua")); }
      catch {
        await mkdir(cacheRoot, { recursive: true });
        const staging = `${resourceRoot}-${randomUUID()}`;
        await mkdir(staging);
        try {
          for (const item of ["headless", "extension", "skills", "rules", "knowledge", "templates", "LICENSE", "package.json"])
            await materializeResources(path.join(packageDir, item), path.join(staging, item));
          await rename(staging, resourceRoot);
        }
        catch (error) { if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes(error.code)) throw error; await access(path.join(resourceRoot, "headless", "runner.lua")); }
        finally { await rm(staging, { recursive: true, force: true }); }
      }
    }
    // Upstream's npm entry currently names a missing dist/index.js. Use its
    // published server module without patching the dependency.
    const { createServer } = await import(pathToFileURL(path.join(packageDir, "dist", "server.js")).href);
    const scratchRoot = process.env.PI_DESKTOP_CREATIVE_TEMP || path.join(tmpdir(), "pi-desktop-creative");
    await mkdir(scratchRoot, { recursive: true });
    process.env.ASEPRITE_USER_FOLDER = await mkdtemp(path.join(scratchRoot, "pi-aseprite-"));
    const { server, live } = createServer({ root: resourceRoot, asepritePath: executable,
      headless: settings.mode !== "window", autoSpawnBridge: settings.mode === "window" });
    const shutdown = () => { live.close(); void server.close(); };
    process.stdin.once("end", shutdown);
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    await server.connect(new StdioServerTransport());
  } else {
    const args = settings.mode === "window" ? ["mcp", "--connect", "127.0.0.1:7979", "--launch"] : ["mcp"];
    const child = spawn(executable, args, { stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
    process.stdin.pipe(child.stdin);
    child.stdin.on("error", () => {});
    const stop = () => { child.stdin.end(); child.kill(); };
    process.stdin.once("end", stop);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    child.once("error", error => { process.stderr.write(`${error.message}\n`); process.stdin.unpipe(child.stdin); process.stdin.destroy(); process.exitCode = 1; });
    child.once("exit", code => { process.stdin.unpipe(child.stdin); process.stdin.destroy(); process.exitCode = code ?? 1; });
  }
} catch (error) {
  process.stderr.write(`[Pi Desktop ${name}] ${error.message}\n`);
  process.exitCode = 1;
}
