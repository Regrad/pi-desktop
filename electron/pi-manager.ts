import path from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { existsSync } from "node:fs";
import type {
  Attachment,
  ConversationRecord,
  ConversationSnapshot,
  ModelInfo,
  RuntimeState,
  ThinkingLevel,
} from "../shared/types.js";
import { DataStore } from "./data-store.js";
import { PiRpcProcess } from "./pi-rpc-process.js";
import { RunDiffTracker } from "./run-diff-tracker.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";

type JsonObject = Record<string, unknown>;

interface RuntimeRecord {
  rpc: PiRpcProcess;
  snapshot?: ConversationSnapshot;
  diffTracker?: Promise<RunDiffTracker>;
}

export class PiManager {
  private readonly runtimes = new Map<string, RuntimeRecord>();

  constructor(
    private readonly store: DataStore,
    private readonly getWindow: () => BrowserWindow | null,
  ) {}

  async createConversation(projectId?: string): Promise<ConversationSnapshot> {
    const conversation = await this.store.createConversation(projectId);
    return this.startConversation(conversation);
  }

  async openConversation(conversationId: string): Promise<ConversationSnapshot> {
    await this.store.activateConversation(conversationId);
    const running = this.runtimes.get(conversationId);
    if (running?.snapshot) return structuredClone(running.snapshot);
    return this.startConversation(this.store.getConversation(conversationId));
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.stopConversation(conversationId);
    const conversation = this.store.getConversation(conversationId);
    if (conversation.sessionFile && existsSync(conversation.sessionFile)) {
      await shell.trashItem(this.store.assertManagedSessionFile(conversation.sessionFile));
    }
    await this.store.deleteConversation(conversationId);
  }

  async archiveConversation(conversationId: string): Promise<void> {
    await this.stopConversation(conversationId);
    await this.store.setConversationArchived(conversationId, true);
  }

  async restoreConversation(conversationId: string): Promise<void> {
    await this.store.setConversationArchived(conversationId, false);
  }

  async removeProject(projectId: string): Promise<void> {
    const ids = await this.store.removeProject(projectId);
    await Promise.all(ids.map((id) => this.stopConversation(id)));
  }

  async sendPrompt(
    conversationId: string,
    message: string,
    attachments: Attachment[],
    behavior?: "steer" | "followUp",
  ): Promise<void> {
    const runtime = await this.ensureRuntime(conversationId);
    const conversation = this.store.getConversation(conversationId);
    let startedDiffTracker = false;
    if (!runtime.diffTracker) {
      runtime.diffTracker = RunDiffTracker.start(
        await this.store.getConversationWorkspacePaths(conversation),
      );
      startedDiffTracker = true;
      await runtime.diffTracker;
    }
    const imageAttachments = attachments.filter((item) => item.mimeType?.startsWith("image/") && item.data);
    const fileAttachments = attachments.filter((item) => !item.mimeType?.startsWith("image/") || !item.data);
    const fileList = fileAttachments.map((item) => `- ${item.path}`).join("\n");
    const preparedMessage = fileList
      ? `${message}\n\nAttached files available in the workspace or filesystem:\n${fileList}`
      : message;
    const images = imageAttachments.map((item) => ({
      type: "image",
      data: item.data,
      mimeType: item.mimeType,
    }));
    if (conversation.title === "Новый чат") {
      const title = message.replace(/\s+/g, " ").trim().slice(0, 64) || "Новый чат";
      await this.updateConversation(conversationId, { title });
      await runtime.rpc.request("set_session_name", { name: title });
    }
    const payload = { message: preparedMessage, ...(images.length ? { images } : {}) };
    try {
      if (behavior === "steer") await runtime.rpc.request("steer", payload);
      else if (behavior === "followUp") await runtime.rpc.request("follow_up", payload);
      else await runtime.rpc.request("prompt", payload);
    } catch (error) {
      if (startedDiffTracker) runtime.diffTracker = undefined;
      throw error;
    }
  }

  async abort(conversationId: string): Promise<void> {
    const runtime = await this.ensureRuntime(conversationId);
    await runtime.rpc.request("abort");
  }

  async setModel(conversationId: string, provider: string, modelId: string): Promise<RuntimeState> {
    const runtime = await this.ensureRuntime(conversationId);
    await runtime.rpc.request("set_model", { provider, modelId });
    await this.updateConversation(conversationId, { provider, model: modelId });
    return this.refreshState(conversationId, runtime);
  }

  async setThinkingLevel(conversationId: string, level: ThinkingLevel): Promise<RuntimeState> {
    const runtime = await this.ensureRuntime(conversationId);
    await runtime.rpc.request("set_thinking_level", { level });
    await this.updateConversation(conversationId, { thinkingLevel: level });
    return this.refreshState(conversationId, runtime);
  }

  async renameConversation(conversationId: string, title: string): Promise<void> {
    const normalized = title.trim();
    if (!normalized) return;
    const conversation = this.store.getConversation(conversationId);
    const runtime = this.runtimes.get(conversationId);
    if (runtime) {
      await runtime.rpc.request("set_session_name", { name: normalized });
    } else if (conversation.sessionFile && existsSync(conversation.sessionFile)) {
      const cwd = await this.store.getConversationWorkingDirectory(conversation);
      SessionManager.open(conversation.sessionFile, this.store.getSessionDir(cwd), cwd).appendSessionInfo(normalized);
    }
    await this.updateConversation(conversationId, { title: normalized });
  }

  respondToExtensionUi(conversationId: string, response: JsonObject): void {
    this.runtimes.get(conversationId)?.rpc.sendExtensionUiResponse(response);
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.rpc.stop()));
    this.runtimes.clear();
  }

  private async ensureRuntime(conversationId: string): Promise<RuntimeRecord> {
    const running = this.runtimes.get(conversationId);
    if (running) return running;
    await this.startConversation(this.store.getConversation(conversationId));
    return this.runtimes.get(conversationId)!;
  }

  private async startConversation(conversation: ConversationRecord): Promise<ConversationSnapshot> {
    const existing = this.runtimes.get(conversation.id);
    if (existing?.snapshot) return structuredClone(existing.snapshot);
    const cwd = await this.store.getConversationWorkingDirectory(conversation);
    const project = conversation.projectId ? this.store.getProject(conversation.projectId) : undefined;
    const appendSystemPrompt = project && project.paths.length > 1
      ? [
          "Additional directories supplied by the user for this project:",
          ...project.paths.slice(1).map((projectPath) => `- ${projectPath}`),
          `The primary Pi working directory remains ${project.path}. Treat the listed paths only as additional project context and use absolute paths to access them.`,
        ].join("\n")
      : undefined;
    await this.updateConversation(conversation.id, { status: "starting" });

    const cliPath = path.join(
      app.getAppPath(),
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "dist",
      "cli.js",
    );
    const rpc = new PiRpcProcess({
      executablePath: process.execPath,
      cliPath,
      cwd,
      agentDir: this.store.agentDir,
      sessionsDir: this.store.getSessionDir(cwd),
      sessionId: conversation.id,
      sessionFile: conversation.sessionFile,
      provider: conversation.provider,
      model: conversation.model,
      thinkingLevel: conversation.thinkingLevel,
      appendSystemPrompt,
      onEvent: (event) => void this.handleEvent(conversation.id, event),
      onExtensionUi: (request) => {
        const sanitizedRequest = request.method === "setStatus"
          ? { ...request, statusText: sanitizeStatusText(request.statusText) }
          : request.method === "setWorkingMessage"
            ? { ...request, workingText: sanitizeStatusText(request.workingText) }
            : request;
        this.getWindow()?.webContents.send("pi:extension-ui", { conversationId: conversation.id, request: sanitizedRequest });
      },
      onExit: (error) => {
        this.runtimes.delete(conversation.id);
        void this.updateConversation(conversation.id, { status: error ? "error" : "idle" });
        if (error) {
          this.getWindow()?.webContents.send("pi:event", {
            conversationId: conversation.id,
            event: { type: "runtime_error", error: error.message },
          });
        }
      },
    });
    const record: RuntimeRecord = { rpc };
    this.runtimes.set(conversation.id, record);
    try {
      await rpc.start();
      const [stateData, messagesData, modelsData, levelsData, commandsData] = await Promise.all([
        rpc.request<JsonObject>("get_state"),
        rpc.request<{ messages: unknown[] }>("get_messages"),
        rpc.request<{ models: ModelInfo[] }>("get_available_models"),
        rpc.request<{ levels: ThinkingLevel[] }>("get_available_thinking_levels"),
        rpc.request<{ commands: Array<{ name: string; description?: string; source: string }> }>("get_commands"),
      ]);
      const state = this.normalizeState(stateData);
      const updated = await this.updateConversation(conversation.id, {
        status: state.isStreaming ? "working" : "idle",
        sessionFile: state.sessionFile,
        provider: state.model?.provider,
        model: state.model?.id,
        thinkingLevel: state.thinkingLevel,
      });
      record.snapshot = {
        conversation: updated,
        state,
        messages: messagesData.messages ?? [],
        models: modelsData.models ?? [],
        thinkingLevels: levelsData.levels ?? ["off"],
        commands: commandsData.commands ?? [],
      };
      return structuredClone(record.snapshot);
    } catch (error) {
      this.runtimes.delete(conversation.id);
      await rpc.stop();
      await this.updateConversation(conversation.id, { status: "error" });
      throw error;
    }
  }

  private async handleEvent(conversationId: string, event: JsonObject): Promise<void> {
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) return;
    if (event.type === "agent_start") {
      await this.updateConversation(conversationId, { status: "working" });
    } else if (event.type === "agent_settled") {
      await this.updateConversation(conversationId, { status: "idle" });
      await this.refreshState(conversationId, runtime);
      const tracker = runtime.diffTracker;
      runtime.diffTracker = undefined;
      this.getWindow()?.webContents.send("pi:event", { conversationId, event });
      if (tracker) {
        try {
          const diff = await (await tracker).finish();
          this.getWindow()?.webContents.send("pi:event", {
            conversationId,
            event: { type: "desktop_run_diff", diff },
          });
        } catch (error) {
          this.getWindow()?.webContents.send("pi:event", {
            conversationId,
            event: { type: "desktop_diff_error", error: error instanceof Error ? error.message : String(error) },
          });
        }
      }
      return;
    } else if (event.type === "message_end" && runtime.snapshot && event.message) {
      runtime.snapshot.messages.push(event.message);
    }
    this.getWindow()?.webContents.send("pi:event", { conversationId, event });
  }

  private async refreshState(conversationId: string, runtime: RuntimeRecord): Promise<RuntimeState> {
    const state = this.normalizeState(await runtime.rpc.request<JsonObject>("get_state"));
    if (runtime.snapshot) runtime.snapshot.state = state;
    return state;
  }

  private normalizeState(value: JsonObject): RuntimeState {
    const model = value.model && typeof value.model === "object" ? (value.model as ModelInfo) : null;
    return {
      model,
      thinkingLevel: (value.thinkingLevel as ThinkingLevel | undefined) ?? "off",
      isStreaming: Boolean(value.isStreaming),
      sessionFile: typeof value.sessionFile === "string" ? value.sessionFile : undefined,
      sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
      sessionName: typeof value.sessionName === "string" ? value.sessionName : undefined,
    };
  }

  private async updateConversation(
    conversationId: string,
    changes: Partial<ConversationRecord>,
  ): Promise<ConversationRecord> {
    const updated = await this.store.updateConversation(conversationId, changes);
    const runtime = this.runtimes.get(conversationId);
    if (runtime?.snapshot) runtime.snapshot.conversation = updated;
    this.getWindow()?.webContents.send("desktop:conversation-changed", updated);
    return updated;
  }

  private async stopConversation(conversationId: string): Promise<void> {
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) return;
    this.runtimes.delete(conversationId);
    await runtime.rpc.stop();
  }
}

function sanitizeStatusText(value?: string): string | undefined {
  if (!value) return value;
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
