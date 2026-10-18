import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createLsToolDefinition, createFindToolDefinition, createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import path from "node:path";
import { readFile, mkdir, open, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { defaultShellTimeout } from "../pi-rpc-bridge/shell-timeout-policy.js";

export default function remoteExecution(pi: ExtensionAPI) {
  const url = process.env.PI_DESKTOP_REMOTE_URL;
  const token = process.env.PI_DESKTOP_REMOTE_TOKEN;
  const cwd = process.env.PI_DESKTOP_REMOTE_CWD;
  const device = process.env.PI_DESKTOP_REMOTE_DEVICE;
  const dataDir = process.env.PI_DESKTOP_DATA_DIR;
  if (!url || !token || !cwd || !device || !dataDir) throw new Error("Не задана изолированная конфигурация удалённого ПК");
  const invoke = async (operation: string, args: Record<string, unknown>, signal?: AbortSignal, timeout?: number) => {
    const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ operation, args, timeout }), signal });
    const body = await response.json() as { result: any; error?: string };
    if (!response.ok) throw new Error(body.error || "Клиентский компьютер недоступен");
    return body.result;
  };
  const buffer = async (file: string) => {
    const result = await invoke("read", { path: file });
    if (!result.exists) throw new Error(`ENOENT: файл на клиентском ПК не найден: ${file}`);
    if (result.unsupported) throw new Error("Файл превышает лимит чтения помощника (8 МБ)");
    return Buffer.from(result.data, "base64");
  };
  const pullFile = async (source: string) => {
    const metadata = await invoke("stat", { path: source });
    if (!metadata.exists || metadata.directory || !Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > 512 * 1024 * 1024) throw new Error("Исходник отсутствует или превышает 512 МБ");
    const folder = path.join(dataDir, "remote-inputs", device); await mkdir(folder, { recursive: true });
    const temporary = path.join(folder, `${randomUUID()}.part`);
    const file = await open(temporary, "wx", 0o600); const hash = createHash("sha256");
    try {
      for (let offset = 0; offset < metadata.size;) {
        const chunk = await invoke("readChunk", { path: source, offset, size: metadata.size, stamp: metadata.stamp });
        const bytes = Buffer.from(chunk.data, "base64");
        if (!bytes.length || bytes.length > 256 * 1024 || offset + bytes.length > metadata.size) throw new Error("Повреждена передача исходника");
        hash.update(bytes); await file.writeFile(bytes); offset += bytes.length;
      }
      await file.close();
      const extension = /^\.[a-z0-9]{1,10}$/i.test(path.win32.extname(source)) ? path.win32.extname(source) : ".bin";
      const target = path.join(folder, hash.digest("hex") + extension);
      await rename(temporary, target); permittedOutput.add(path.resolve(target)); return target;
    } catch (error) { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw error; }
  };
  const permittedOutput = new Set<string>();
  const uploadRoot = process.env.PI_DESKTOP_REMOTE_UPLOAD_DIR;
  const isPermitted = (file: string) => permittedOutput.has(path.resolve(file)) || Boolean(uploadRoot && path.dirname(path.resolve(file)) === path.resolve(uploadRoot));
  const localOrRemoteRead = (file: string) => isPermitted(file) ? readFile(file) : buffer(file);
  const read = createReadToolDefinition(cwd, { operations: {
    readFile: localOrRemoteRead,
    access: async file => { if (isPermitted(file)) return; if (!(await invoke("stat", { path: file })).exists) throw new Error(`Файл не найден: ${file}`); },
    detectImageMimeType: async file => {
      const bytes = await localOrRemoteRead(file);
      if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
      if (bytes[0] === 255 && bytes[1] === 216) return "image/jpeg";
      if (bytes.subarray(0,4).toString() === "RIFF" && bytes.subarray(8,12).toString() === "WEBP") return "image/webp";
      return null;
    },
  }});
  pi.registerTool(read);
  // SDK edit semantics; the helper captures snapshots while holding the write lock.
  for (const name of ["edit", "write"] as const) {
    const definition = name === "edit" ? createEditToolDefinition(cwd) : createWriteToolDefinition(cwd);
    pi.registerTool({ ...definition, async execute(id: string, parameters: any, signal: AbortSignal | undefined, update: any, context: any) {
      let mutation: any;
      let expectedHash: string | undefined;
      const writeFile = async (file: string, content: string) => {
        const result = await invoke("write", { path: file, content, ...(name === "edit" ? { expectedHash } : {}) }, signal);
        mutation = result.mutation;
      };
      const tool = name === "edit" ? createEditToolDefinition(cwd, { operations: {
        readFile: async file => { const bytes = await buffer(file); expectedHash = createHash("sha256").update(bytes).digest("hex"); return bytes; },
        access: async file => { if (!(await invoke("stat", { path: file }, signal)).exists) throw new Error("Файл не найден"); }, writeFile,
      }}) : createWriteToolDefinition(cwd, { operations: {
        mkdir: async dir => { await invoke("mkdir", { path: dir }, signal); }, writeFile,
      }});
      const result = await tool.execute(id, parameters, signal, update, context);
      return { ...result, details: { ...result.details, desktopFileMutation: mutation } };
    }} as any);
  }
  pi.registerTool(createLsToolDefinition(cwd, { operations: {
    exists: async file => (await invoke("stat", { path: file })).exists,
    stat: async file => { const value = await invoke("stat", { path: file }); if (!value.exists) throw new Error("Файл не найден"); return { isDirectory: () => value.directory }; },
    readdir: async file => (await invoke("ls", { path: file })).names,
  }}));
  pi.registerTool(createFindToolDefinition(cwd, { operations: {
    exists: async file => (await invoke("stat", { path: file })).exists,
    glob: async (pattern, directory, options) => (await invoke("find", { pattern, cwd: directory, limit: options.limit, ignore: options.ignore })).files,
  }}));
  const bash = createBashToolDefinition(cwd, { exposeSessionEnvironment: false, operations: {
    exec: async (command, directory, options) => {
      const seconds = options.timeout ?? defaultShellTimeout(command);
      const result = await invoke("exec", { command, cwd: directory, timeout: seconds }, options.signal, seconds * 1000 + 10000);
      options.onData(Buffer.from(result.output, "utf8")); return { exitCode: result.exitCode };
    },
  }});
  pi.registerTool({ ...bash, promptSnippet: "Execute PowerShell commands on the client Windows PC", description: "Execute PowerShell commands on the CLIENT Windows computer. This is not bash; use PowerShell syntax. No command executes on the Pi host. Timeout defaults to 60 seconds for simple inspections and 3600 seconds for other commands, including builds and scripts. An explicit timeout overrides the default.",
    async execute(id, parameters, signal, update, context) {
      const result = await bash.execute(id, { ...parameters, timeout: parameters.timeout === undefined ? defaultShellTimeout(parameters.command) : parameters.timeout }, signal, update, context);
      if (result.details?.fullOutputPath) permittedOutput.add(path.resolve(result.details.fullOutputPath));
      return result;
    },
  });
  // SDK grep still spawns host ripgrep even with filesystem overrides: never use it remotely.
  pi.registerTool({ name: "grep", label: "Поиск на клиентском ПК", description: "Search text files on the client PC (bounded search, skips common generated directories; does not promise full .gitignore semantics).",
    parameters: Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), glob: Type.Optional(Type.String()), ignoreCase: Type.Optional(Type.Boolean()), literal: Type.Optional(Type.Boolean()), context: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }),
    async execute(_id, input, signal) { const result = await invoke("grep", { ...input, cwd, path: path.win32.resolve(cwd, input.path ?? ".") }, signal); return { content: [{ type: "text", text: result.output }], details: { matchLimitReached: result.truncated ? input.limit ?? 100 : undefined } }; },
  });
  pi.registerTool({ name: "computer_use", label: "Клиентский компьютер", description: "Control the CLIENT desktop: screenshot, mouse move/click/scroll, keyboard key or text. Screenshot is the client screen, never the server screen.",
    parameters: Type.Object({ action: Type.Union([Type.Literal("screenshot"),Type.Literal("move"),Type.Literal("click"),Type.Literal("scroll"),Type.Literal("key"),Type.Literal("text")]), x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()), button: Type.Optional(Type.String()), delta: Type.Optional(Type.Number()), key: Type.Optional(Type.String()), text: Type.Optional(Type.String()) }),
    async execute(_id, args, signal) { const result = await invoke("computer", args, signal); return args.action === "screenshot" ? { content: [{ type: "image", mimeType: "image/png", data: result.data }], details: { width: result.width, height: result.height, x: result.x, y: result.y } } : { content: [{ type: "text", text: "Выполнено на клиентском ПК" }], details: {} }; },
  });
  pi.registerTool({ name: "execute_elevated", label: "Команда с правами администратора", description: "Request Windows UAC for this exact PowerShell command on the client PC. Requires approval on that PC. Never bypasses Windows policy.",
    parameters: Type.Object({ command: Type.String(), cwd: Type.Optional(Type.String()) }),
    async execute(_id, args, signal) { const result = await invoke("execElevated", { ...args, cwd: args.cwd ?? cwd }, signal, 3600000); return { content: [{ type: "text", text: result.output }], details: { exitCode: result.exitCode } }; },
  });
  pi.on("before_agent_start", async event => {
    const ancestors: string[] = [];
    let directory = cwd;
    while (true) { ancestors.unshift(directory); const parent = path.win32.dirname(directory); if (parent === directory) break; directory = parent; }
    const instructions: string[] = [];
    for (const directory of ancestors) {
      const file = path.win32.join(directory, "AGENTS.md");
      const result = await invoke("read", { path: file });
      if (result.unsupported || result.data && result.data.length > 1400000) throw new Error(`Инструкции ${file} превышают 1 МБ`);
      if (result.exists) instructions.push(`Project instructions from CLIENT ${file}:\n${new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(result.data, "base64"))}`);
    }
    return { systemPrompt: `${event.systemPrompt}\n\nEXECUTION TARGET: CLIENT Windows PC. Client working directory: ${cwd}. Client project directories: ${process.env.PI_DESKTOP_REMOTE_ROOTS ?? cwd}. All filesystem/command/computer tools target that client. Commands use PowerShell. The Pi host runs inference and ComfyUI only; its cwd is a session storage location, not the target workspace. Do not execute or search on the host. Arbitrary host addons are disabled unless explicitly remote-safe.\n${instructions.join("\n\n")}` };
  });
  const grantPaths = (value: unknown) => {
    if (typeof value === "string") {
      if (["image-generation", "music-generation", "3d-generation"].some(folder => path.dirname(path.resolve(value)) === path.resolve(dataDir, folder))) permittedOutput.add(path.resolve(value));
      return;
    }
    if (Array.isArray(value)) { value.forEach(grantPaths); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (!["data", "text", "before", "after"].includes(key)) grantPaths(item);
    }
  };
  pi.on("session_start", (_event, context) => { for (const entry of context.sessionManager.getEntries()) if (entry.type === "message" && entry.message.role === "toolResult" && /^(comfyui_|desktop_show_image$)/.test(entry.message.toolName)) grantPaths(entry.message); });
  pi.on("tool_result", async event => {
    if (/^(comfyui_|desktop_show_image$)/.test(event.toolName)) { grantPaths(event.content); grantPaths(event.details); }
    // Supports installed older editable ComfyUI add-ons too: materialize the selected image on the client.
    if (event.toolName === "desktop_get_image_path" && !event.isError) {
      const file = (event.details as { files?: string[] })?.files?.[0];
      if (file && (isPermitted(file) || ["chat-attachments", "remote-inputs"].some(folder => path.resolve(file).startsWith(path.resolve(dataDir, folder) + path.sep)))) {
        const bytes = await readFile(file);
        const copied = await invoke("saveAttachment", { data: bytes.toString("base64"), extension: path.extname(file) });
        return { content: [{ type: "text", text: `Selected image path on CLIENT: ${copied.path}. Use this path for scripts/cropping on the client PC.` }], details: { files: [copied.path], displayInAnswer: false } };
      }
    }
  });
  pi.on("tool_call", async event => {
    if (!event.toolName.startsWith("comfyui_") && !["desktop_show_image", "desktop_get_image_path"].includes(event.toolName)) return;
    const map = async (value: unknown, key: string): Promise<unknown> => {
      if (Array.isArray(value)) return Promise.all(value.map(item => map(item, key)));
      if (typeof value !== "string" || !/^(?:image|images|mask|audio|reference_audio|file|path|abc_file|.*_path|.*_audio)$/.test(key) || !path.win32.isAbsolute(value)) return value;
      if (isPermitted(value)) return value;
      return pullFile(value);
    };
    for (const key of Object.keys(event.input)) event.input[key] = await map(event.input[key], key);
  });
}
