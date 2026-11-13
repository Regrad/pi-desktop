import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import type { ExtensionUiRequest } from "../shared/types.js";

type JsonObject = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface PiRpcProcessOptions {
  executablePath: string;
  enginePath: string;
  cwd: string;
  agentDir: string;
  sessionsDir: string;
  sessionId: string;
  sessionFile?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  appendSystemPrompt?: string;
  goalExtensionPath?: string;
  planExtensionPath?: string;
  planningExtensionPath?: string;
  notebookExtensionPath?: string;
  skillsExtensionPath?: string;
  skillsProject?: boolean;
  browserExtensionPath?: string;
  goalStatePath?: string;
  appRoot?: string;
  isolatedExtensions?: string[];
  remoteEnvironment?: Record<string, string>;
  mcpEntryPath: string;
  mcpDirectTools: string[];
  onEvent: (event: JsonObject) => void;
  onGoalRequest?: (request: JsonObject) => Promise<unknown>;
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
    this.stderr = "";
    const extensions = [
      this.options.planningExtensionPath,
      // Keep skills before desktop prompt handlers.
      this.options.skillsExtensionPath,
      ...(this.options.appRoot ? ['builtin:codemode', path.join(this.options.appRoot, 'resources', 'tool-routing', 'index.js')] : []),
      this.options.goalExtensionPath, this.options.planExtensionPath,
      this.options.notebookExtensionPath, this.options.browserExtensionPath,
      ...(this.options.isolatedExtensions ?? []),
    ].filter((entry): entry is string => Boolean(entry));
    const engineOptions = {
      cwd: this.options.cwd, agentDir: this.options.agentDir,
      sessionsDir: this.options.sessionsDir, sessionId: this.options.sessionId,
      sessionFile: this.options.sessionFile, provider: this.options.provider,
      model: this.options.model, thinkingLevel: this.options.thinkingLevel,
      appendSystemPrompt: this.options.appendSystemPrompt,
      extensions, isolated: Boolean(this.options.isolatedExtensions),
    };
    const args = [this.options.enginePath];

    const child = spawn(this.options.executablePath, args, {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PI_CODING_AGENT_DIR: this.options.agentDir,
        PI_DESKTOP_DATA_DIR: path.dirname(this.options.agentDir),
        ...(this.options.appRoot ? { PI_DESKTOP_APP_ROOT: this.options.appRoot } : {}),
        PI_DESKTOP_TOOL_ROUTING: this.options.appRoot ? "1" : "0",
        PI_DESKTOP_EXECUTABLE: this.options.executablePath,
        PI_DESKTOP_MCP_ENTRY: this.options.mcpEntryPath,
        NO_UPDATE_NOTIFIER: "1",
        ...this.options.remoteEnvironment,
        PI_DESKTOP_ENGINE_OPTIONS: JSON.stringify(engineOptions),
        PI_DESKTOP_CONVERSATION_ID: this.options.sessionId,
        PI_DESKTOP_SKILLS_PROJECT: this.options.skillsProject ? "1" : "0",
        ...(this.options.goalStatePath ? { PI_DESKTOP_GOAL_STATE_FILE: this.options.goalStatePath } : {}),
        ...(this.options.mcpDirectTools.length
          ? { MCP_DIRECT_TOOLS: this.options.mcpDirectTools.join(",") }
          : {}),
      },
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      windowsHide: true,
    }) as ChildProcessWithoutNullStreams;
    this.process = child;
    child.on("message", (message: unknown) => {
      if (this.process !== child) return;
      if (!message || typeof message !== "object") return;
      const request = message as JsonObject;
      if (request.type !== "desktop_goal_request" || typeof request.id !== "string") return;
      void Promise.resolve().then(() => {
        if (!this.options.onGoalRequest) throw new Error("Goal controller unavailable");
        return this.options.onGoalRequest(request);
      }).then(data => {
        if (child.connected) child.send({ type: "desktop_goal_response", id: request.id, data });
      }, error => {
        if (child.connected) child.send({ type: "desktop_goal_response", id: request.id, error: String(error) });
      });
    });
    this.attachJsonlReader(child.stdout, child);
    child.stdin.on("error", (error) => this.handleExit(error, child));
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.process !== child) return;
      this.stderr = `${this.stderr}${chunk.toString("utf8")}`.slice(-32_000);
    });
    child.once("error", (error) => this.handleExit(error, child));
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGTERM") this.handleExit(undefined, child);
      else this.handleExit(new Error(`Pi завершился с кодом ${code ?? signal}. ${this.stderr}`), child);
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
          reject(new Error(`Не удалось запустить движок Pi (${code}). ${this.stderr}`));
        }
      });
    });
  }

  async stop(): Promise<void> {
    const child = this.process;
    if (!child) return;
    this.process = undefined;
    this.rejectPending(new Error("Движок Pi остановлен"));
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
    if (!child || child.killed) throw new Error("Движок Pi не запущен");
    const id = `desktop-${++this.sequence}`;
    const command = `${JSON.stringify({ ...payload, id, type })}\n`;
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
    const rejectWrite = (error?: Error | null) => {
      if (!error) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    };
    try { child.stdin.write(command, rejectWrite); }
    catch (error) { rejectWrite(error instanceof Error ? error : new Error(String(error))); }
    return promise;
  }

  sendExtensionUiResponse(response: JsonObject): void {
    const child = this.process;
    if (!child || child.killed) return;
    child.stdin.write(`${JSON.stringify({ ...response, type: "extension_ui_response" })}\n`);
  }

  private attachJsonlReader(stream: NodeJS.ReadableStream, child: ChildProcessWithoutNullStreams): void {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    stream.on("data", (chunk: Buffer | string) => {
      if (this.process !== child) return;
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
      if (this.process !== child) return;
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

  private handleExit(error?: Error, child = this.process): void {
    if (!child || this.process !== child) return;
    this.process = undefined;
    this.rejectPending(error ?? new Error("Движок Pi завершён"));
    if (error && child.exitCode === null && child.signalCode === null && !child.killed) {
      // A broken stdin is terminal for RPC, but does not itself stop the child.
      try { child.kill("SIGTERM"); } catch { /* Still report the original transport failure. */ }
    }
    this.options.onExit(error);
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}
