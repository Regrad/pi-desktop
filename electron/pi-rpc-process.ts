import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionUiRequest } from "../shared/types.js";

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface PiRpcProcessOptions {
  executablePath: string;
  cliPath: string;
  cwd: string;
  agentDir: string;
  sessionsDir: string;
  sessionId: string;
  sessionFile?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  appendSystemPrompt?: string;
  mcpEntryPath: string;
  mcpDirectTools: string[];
  onEvent: (event: JsonObject) => void;
  onExtensionUi: (request: ExtensionUiRequest) => void;
  onExit: (error?: Error) => void;
}

export class PiRpcProcess {
  private process?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<string, PendingRequest>();
  private stderr = "";

  constructor(private readonly options: PiRpcProcessOptions) {}

  async start(): Promise<void> {
    if (this.process) return;
    const args = [
      this.options.cliPath,
      "--mode",
      "rpc",
      "--approve",
      "--session-dir",
      this.options.sessionsDir,
    ];
    if (this.options.sessionFile) {
      args.push("--session", this.options.sessionFile);
    } else {
      args.push("--session-id", this.options.sessionId);
    }
    if (this.options.provider) args.push("--provider", this.options.provider);
    if (this.options.model) args.push("--model", this.options.model);
    if (this.options.thinkingLevel) args.push("--thinking", this.options.thinkingLevel);
    if (this.options.appendSystemPrompt) {
      args.push("--append-system-prompt", this.options.appendSystemPrompt);
    }

    const child = spawn(this.options.executablePath, args, {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PI_CODING_AGENT_DIR: this.options.agentDir,
        PI_DESKTOP_EXECUTABLE: this.options.executablePath,
        PI_DESKTOP_MCP_ENTRY: this.options.mcpEntryPath,
        NO_UPDATE_NOTIFIER: "1",
        ...(this.options.mcpDirectTools.length
          ? { MCP_DIRECT_TOOLS: this.options.mcpDirectTools.join(",") }
          : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;
    this.attachJsonlReader(child.stdout);
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-32_000);
    });
    child.once("error", (error) => this.handleExit(error));
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGTERM") this.handleExit();
      else this.handleExit(new Error(`Pi завершился с кодом ${code ?? signal}. ${this.stderr}`));
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => resolve(), 250);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("exit", (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timeout);
          reject(new Error(`Не удалось запустить Pi (${code}). ${this.stderr}`));
        }
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.process = undefined;
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async request<T = unknown>(type: string, payload: JsonObject = {}, timeoutMs = 86_400_000): Promise<T> {
    const child = this.process;
    if (!child || child.killed) throw new Error("Процесс Pi не запущен");
    const id = `desktop-${++this.sequence}`;
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Pi не ответил на команду ${type}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });
    child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`);
    return promise;
  }

  sendExtensionUiResponse(response: JsonObject): void {
    const child = this.process;
    if (!child || child.killed) return;
    child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", ...response })}\n`);
  }

  private attachJsonlReader(stream: NodeJS.ReadableStream): void {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    stream.on("data", (chunk: Buffer | string) => {
      buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
      while (true) {
        const index = buffer.indexOf("\n");
        if (index === -1) break;
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (line) this.handleLine(line);
      }
    });
    stream.on("end", () => {
      buffer += decoder.end();
      if (buffer) this.handleLine(buffer.replace(/\r$/, ""));
    });
  }

  private handleLine(line: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      return;
    }
    if (message.type === "response" && typeof message.id === "string") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.success === false) pending.reject(new Error(String(message.error ?? "Ошибка Pi")));
      else pending.resolve(message.data);
      return;
    }
    if (message.type === "extension_ui_request") {
      this.options.onExtensionUi(message as unknown as ExtensionUiRequest);
      return;
    }
    this.options.onEvent(message);
  }

  private handleExit(error?: Error): void {
    if (!this.process && !error) return;
    this.process = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error ?? new Error("Процесс Pi завершён"));
    }
    this.pending.clear();
    this.options.onExit(error);
  }
}
