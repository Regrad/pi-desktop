import path from "node:path";
import { app, BrowserWindow, shell } from "electron";
import { existsSync } from "node:fs";
import type {
  Attachment,
  ConversationRun,
  ConversationRecord,
  ConversationSnapshot,
  ExtensionState,
  ExtensionUiRequest,
  ExtensionUiState,
  ModelInfo,
  ProjectRecord,
  QueuedPrompt,
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
  extensionUi: ExtensionUiState;
  extensionErrors: ExtensionState["errors"];
  eventQueue: Promise<void>;
  activeRun?: ConversationRun;
}

function createExtensionUiState(): ExtensionUiState {
  return {
    statuses: {},
    widgets: [],
    headerLines: [],
    footerLines: [],
    workingVisible: true,
    pendingDialogs: [],
  };
}

function createEmptyExtensionState(): ExtensionState {
  return {
    extensionPaths: [],
    activeTools: [],
    tools: [],
    commandDiagnostics: [],
    shortcutDiagnostics: [],
    errors: [],
  };
}

export class PiManager {
  private readonly runtimes = new Map<string, RuntimeRecord>();
  private cachedCommands: ConversationSnapshot["commands"] = [];
  private cachedExtensionState: ExtensionState = createEmptyExtensionState();

  constructor(
    private readonly store: DataStore,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly onConversationSettled?: (conversation: ConversationRecord) => void,
  ) {}

  async createConversation(projectId?: string): Promise<ConversationSnapshot> {
    const conversation = await this.store.createConversation(projectId);
    return this.previewConversation(conversation);
  }

  async openConversation(conversationId: string): Promise<ConversationSnapshot> {
    await this.store.activateConversation(conversationId);
    const running = this.runtimes.get(conversationId);
    if (running?.snapshot) {
      if (running.snapshot.state.isStreaming) await this.refreshRuntimeSnapshot(running);
      running.snapshot.queuedPrompts = this.store.getQueuedPrompts(conversationId);
      return structuredClone(running.snapshot);
    }
    return this.previewConversation(this.store.getConversation(conversationId));
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

  async renameProject(projectId: string, name: string): Promise<ProjectRecord> {
    return this.store.renameProject(projectId, name);
  }

  async sendPrompt(
    conversationId: string,
    message: string,
    attachments: Attachment[],
    behavior?: "steer" | "followUp",
  ): Promise<void> {
    const runtime = await this.ensureRuntime(conversationId);
    if (runtime.snapshot) {
      this.getWindow()?.webContents.send("pi:event", {
        conversationId,
        event: { type: "desktop_state", state: structuredClone(runtime.snapshot.state) },
      });
    }
    const conversation = this.store.getConversation(conversationId);
    if (!runtime.snapshot?.state.isStreaming && (!runtime.activeRun || runtime.activeRun.completedAt)) {
      runtime.activeRun = { startedAt: new Date().toISOString() };
      if (runtime.snapshot) runtime.snapshot.run = structuredClone(runtime.activeRun);
      await this.store.saveConversationRun(conversationId, runtime.activeRun);
      this.getWindow()?.webContents.send("pi:event", {
        conversationId,
        event: { type: "desktop_run_started", run: runtime.activeRun },
      });
    }
    let startedDiffTracker = false;
    if (!runtime.diffTracker) {
      this.getWindow()?.webContents.send("pi:event", {
        conversationId,
        event: { type: "desktop_preparing", message: "Подготавливаю отслеживание изменений…" },
      });
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
      if (runtime.activeRun && !runtime.snapshot?.state.isStreaming) {
        runtime.activeRun = {
          ...runtime.activeRun,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - Date.parse(runtime.activeRun.startedAt),
        };
        await this.store.saveConversationRun(conversationId, runtime.activeRun);
      }
      throw error;
    }
  }

  async queuePrompt(conversationId: string, message: string, attachments: Attachment[]): Promise<QueuedPrompt[]> {
    const queued = await this.store.queuePrompt(conversationId, message, attachments);
    this.syncQueuedPrompts(conversationId, queued);
    return queued;
  }

  async sendQueuedPrompt(conversationId: string, promptId: string): Promise<QueuedPrompt[]> {
    const prompt = this.store.getQueuedPrompts(conversationId).find((item) => item.id === promptId);
    if (!prompt) throw new Error("Сообщение в очереди не найдено");
    const runtime = this.runtimes.get(conversationId);
    const isStreaming = runtime ? (await this.refreshState(conversationId, runtime)).isStreaming : false;
    await this.sendPrompt(conversationId, prompt.message, prompt.attachments, isStreaming ? "steer" : undefined);
    const queued = await this.store.removeQueuedPrompt(conversationId, promptId);
    this.syncQueuedPrompts(conversationId, queued);
    return queued;
  }

  async removeQueuedPrompt(conversationId: string, promptId: string): Promise<QueuedPrompt[]> {
    const queued = await this.store.removeQueuedPrompt(conversationId, promptId);
    this.syncQueuedPrompts(conversationId, queued);
    return queued;
  }

  async abort(conversationId: string): Promise<void> {
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) return;
    await runtime.rpc.request("abort");
  }

  async setModel(conversationId: string, provider: string, modelId: string): Promise<RuntimeState> {
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) {
      const updated = await this.updateConversation(conversationId, { provider, model: modelId });
      return (await this.previewConversation(updated)).state;
    }
    await runtime.rpc.request("set_model", { provider, modelId });
    await this.updateConversation(conversationId, { provider, model: modelId });
    return this.refreshState(conversationId, runtime);
  }

  async setThinkingLevel(conversationId: string, level: ThinkingLevel): Promise<RuntimeState> {
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) {
      const updated = await this.updateConversation(conversationId, { thinkingLevel: level });
      return (await this.previewConversation(updated)).state;
    }
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
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) return;
    if (response.cancelled === true || typeof response.customInput !== "string") {
      runtime.extensionUi.pendingDialogs = runtime.extensionUi.pendingDialogs.filter(
        (request) => request.id !== response.id,
      );
    }
    runtime.rpc.sendExtensionUiResponse(response);
  }

  async setHostEditorText(conversationId: string, text: string): Promise<void> {
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) return;
    await runtime.rpc.request("set_host_editor_text", { text }, 10_000);
  }

  async clearQueue(conversationId: string): Promise<{ steering: string[]; followUp: string[] }> {
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) return { steering: [], followUp: [] };
    const result = await runtime.rpc.request<{ steering: string[]; followUp: string[] }>("clear_queue");
    await this.refreshState(conversationId, runtime);
    return result;
  }

  private syncQueuedPrompts(conversationId: string, queued: QueuedPrompt[]): void {
    const runtime = this.runtimes.get(conversationId);
    if (runtime?.snapshot) runtime.snapshot.queuedPrompts = structuredClone(queued);
    this.getWindow()?.webContents.send("pi:event", {
      conversationId,
      event: { type: "desktop_queue_update", queued: structuredClone(queued) },
    });
  }

  private async sendNextQueuedPrompt(conversationId: string): Promise<void> {
    const next = this.store.getQueuedPrompts(conversationId)[0];
    if (!next) return;
    try {
      await this.sendQueuedPrompt(conversationId, next.id);
    } catch (error) {
      this.getWindow()?.webContents.send("pi:event", {
        conversationId,
        event: {
          type: "desktop_queue_error",
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.rpc.stop()));
    this.runtimes.clear();
  }

  private async previewConversation(conversation: ConversationRecord): Promise<ConversationSnapshot> {
    const configuration = await this.store.getAgentConfiguration();
    let messages: unknown[] = [];
    let entries: ConversationSnapshot["entries"] = [];
    let sessionModel: { provider: string; modelId: string } | null = null;
    let sessionThinkingLevel: ThinkingLevel | undefined;
    let sessionName: string | undefined;

    if (conversation.sessionFile && existsSync(conversation.sessionFile)) {
      const cwd = await this.store.getConversationWorkingDirectory(conversation);
      const manager = SessionManager.open(conversation.sessionFile, this.store.getSessionDir(cwd), cwd);
      const context = manager.buildSessionContext();
      messages = context.messages;
      entries = manager.getEntries().map((entry) => structuredClone(entry)) as unknown as ConversationSnapshot["entries"];
      sessionModel = context.model;
      sessionThinkingLevel = isThinkingLevel(context.thinkingLevel) ? context.thinkingLevel : undefined;
      sessionName = manager.getSessionName();
    }

    const provider = conversation.provider ?? sessionModel?.provider ?? configuration.defaultProvider;
    const modelId = conversation.model ?? sessionModel?.modelId ?? configuration.defaultModel;
    const model: ModelInfo | null = provider && modelId
      ? configuration.models.find((item) => item.provider === provider && item.id === modelId) ?? { provider, id: modelId }
      : null;
    const thinkingLevels: ThinkingLevel[] = model?.thinkingLevels
      ?? (model?.reasoning ? allThinkingLevels() : ["off"]);
    const requestedThinkingLevel = conversation.thinkingLevel
      ?? sessionThinkingLevel
      ?? configuration.defaultThinkingLevel;
    const thinkingLevel = thinkingLevels.includes(requestedThinkingLevel)
      ? requestedThinkingLevel
      : thinkingLevels[0] ?? "off";

    return {
      conversation: structuredClone(conversation),
      state: {
        model,
        thinkingLevel,
        isStreaming: false,
        sessionFile: conversation.sessionFile,
        sessionId: conversation.id,
        sessionName,
        messageCount: messages.length,
        pendingMessageCount: 0,
        steeringMessages: [],
        followUpMessages: [],
        workingVisible: true,
      },
      messages,
      queuedPrompts: this.store.getQueuedPrompts(conversation.id),
      models: configuration.models,
      thinkingLevels,
      commands: structuredClone(this.cachedCommands),
      entries,
      extensionState: structuredClone(this.cachedExtensionState),
      extensionUi: createExtensionUiState(),
      run: await this.store.getConversationRun(conversation.id),
    };
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
    let record!: RuntimeRecord;
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
      mcpEntryPath: path.join(app.getAppPath(), "node_modules", "@zavora-ai", "computer-use-mcp", "dist", "server.js"),
      mcpDirectTools: await this.store.getMcpDirectToolSelectors(),
      onEvent: (event) => {
        record.eventQueue = record.eventQueue
          .then(() => this.handleEvent(conversation.id, event))
          .catch((queueError) => {
            this.getWindow()?.webContents.send("pi:event", {
              conversationId: conversation.id,
              event: { type: "runtime_error", error: queueError instanceof Error ? queueError.message : String(queueError) },
            });
          });
      },
      onExtensionUi: (request) => this.handleExtensionUi(conversation.id, request),
      onExit: (error) => {
        if (this.runtimes.get(conversation.id) !== record) return;
        this.runtimes.delete(conversation.id);
        void this.handleRuntimeExit(conversation.id, record, error).catch((exitError) => {
          this.getWindow()?.webContents.send("pi:event", {
            conversationId: conversation.id,
            event: { type: "runtime_error", error: exitError instanceof Error ? exitError.message : String(exitError) },
          });
        });
      },
    });
    record = {
      rpc,
      extensionUi: createExtensionUiState(),
      extensionErrors: [],
      eventQueue: Promise.resolve(),
      activeRun: await this.store.getConversationRun(conversation.id),
    };
    this.runtimes.set(conversation.id, record);
    try {
      await rpc.start();
      const [stateData, messagesData, modelsData, levelsData, commandsData, entriesData, extensionData] = await Promise.all([
        rpc.request<JsonObject>("get_state"),
        rpc.request<{ messages: unknown[] }>("get_messages"),
        rpc.request<{ models: ModelInfo[] }>("get_available_models"),
        rpc.request<{ levels: ThinkingLevel[] }>("get_available_thinking_levels"),
        rpc.request<{ commands: Array<{ name: string; description?: string; source: string }> }>("get_commands"),
        rpc.request<{ entries: ConversationSnapshot["entries"] }>("get_session_entries"),
        rpc.request<Omit<ExtensionState, "errors">>("get_extension_state"),
      ]);
      const state = this.normalizeState(stateData);
      this.cachedCommands = commandsData.commands ?? [];
      this.cachedExtensionState = { ...extensionData, errors: [...record.extensionErrors] };
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
        queuedPrompts: this.store.getQueuedPrompts(conversation.id),
        models: modelsData.models ?? [],
        thinkingLevels: levelsData.levels ?? ["off"],
        commands: commandsData.commands ?? [],
        entries: entriesData.entries ?? [],
        extensionState: { ...extensionData, errors: [...record.extensionErrors] },
        extensionUi: structuredClone(record.extensionUi),
        run: record.activeRun ? structuredClone(record.activeRun) : undefined,
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
      if (!runtime.activeRun || runtime.activeRun.completedAt) {
        runtime.activeRun = { startedAt: new Date().toISOString() };
        await this.store.saveConversationRun(conversationId, runtime.activeRun);
      }
      if (runtime.snapshot) runtime.snapshot.run = structuredClone(runtime.activeRun);
      if (runtime.snapshot) runtime.snapshot.state.isStreaming = true;
      await this.updateConversation(conversationId, { status: "working" });
    } else if (event.type === "agent_settled") {
      await this.updateConversation(conversationId, { status: "idle" });
      await this.refreshRuntimeSnapshot(runtime);
      if (runtime.activeRun && !runtime.activeRun.completedAt) {
        const completedAt = new Date().toISOString();
        runtime.activeRun = {
          ...runtime.activeRun,
          completedAt,
          durationMs: Date.parse(completedAt) - Date.parse(runtime.activeRun.startedAt),
        };
        await this.store.saveConversationRun(conversationId, runtime.activeRun);
        if (runtime.snapshot) runtime.snapshot.run = structuredClone(runtime.activeRun);
      }
      const tracker = runtime.diffTracker;
      runtime.diffTracker = undefined;
      this.getWindow()?.webContents.send("pi:event", {
        conversationId,
        event: {
          ...event,
          run: runtime.activeRun,
          state: runtime.snapshot?.state,
          entries: runtime.snapshot?.entries,
          extensionState: runtime.snapshot?.extensionState,
        },
      });
      if (tracker) {
        try {
          const diff = await (await tracker).finish();
          if (runtime.activeRun) {
            runtime.activeRun = { ...runtime.activeRun, diff };
            await this.store.saveConversationRun(conversationId, runtime.activeRun);
            if (runtime.snapshot) runtime.snapshot.run = structuredClone(runtime.activeRun);
          }
          this.getWindow()?.webContents.send("pi:event", {
            conversationId,
            event: { type: "desktop_run_diff", diff, run: runtime.activeRun },
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (runtime.activeRun) {
            runtime.activeRun = { ...runtime.activeRun, diffError: message };
            await this.store.saveConversationRun(conversationId, runtime.activeRun);
          }
          this.getWindow()?.webContents.send("pi:event", {
            conversationId,
            event: { type: "desktop_diff_error", error: message },
          });
        }
      }
      this.onConversationSettled?.(this.store.getConversation(conversationId));
      await this.sendNextQueuedPrompt(conversationId);
      return;
    } else if (event.type === "message_end" && runtime.snapshot && event.message) {
      runtime.snapshot.messages.push(event.message);
      if ((event.message as JsonObject).role === "assistant") {
        event.state = await this.refreshState(conversationId, runtime);
      }
    } else if (event.type === "queue_update" && runtime.snapshot) {
      const steeringMessages = Array.isArray(event.steering) ? event.steering.map(String) : [];
      const followUpMessages = Array.isArray(event.followUp) ? event.followUp.map(String) : [];
      runtime.snapshot.state.steeringMessages = steeringMessages;
      runtime.snapshot.state.followUpMessages = followUpMessages;
      runtime.snapshot.state.pendingMessageCount = steeringMessages.length + followUpMessages.length;
    } else if (event.type === "compaction_start" && runtime.snapshot) {
      runtime.snapshot.state.isCompacting = true;
    } else if (event.type === "compaction_end" && runtime.snapshot) {
      runtime.snapshot.state.isCompacting = false;
      await this.refreshState(conversationId, runtime);
      event.state = runtime.snapshot.state;
    } else if (event.type === "extension_error") {
      const extensionError = {
        extensionPath: typeof event.extensionPath === "string" ? event.extensionPath : undefined,
        event: typeof event.event === "string" ? event.event : undefined,
        error: String(event.error ?? "Extension error"),
      };
      runtime.extensionErrors.push(extensionError);
      if (runtime.snapshot) runtime.snapshot.extensionState.errors = [...runtime.extensionErrors];
    }
    this.getWindow()?.webContents.send("pi:event", { conversationId, event });
  }

  private async handleRuntimeExit(conversationId: string, runtime: RuntimeRecord, error?: Error): Promise<void> {
    if (runtime.activeRun && !runtime.activeRun.completedAt) {
      const completedAt = new Date().toISOString();
      runtime.activeRun = {
        ...runtime.activeRun,
        completedAt,
        durationMs: Date.parse(completedAt) - Date.parse(runtime.activeRun.startedAt),
      };
      await this.store.saveConversationRun(conversationId, runtime.activeRun);
    }
    await this.updateConversation(conversationId, { status: error ? "error" : "idle" });
    if (error) {
      this.getWindow()?.webContents.send("pi:event", {
        conversationId,
        event: { type: "runtime_error", error: error.message, run: runtime.activeRun },
      });
    }
  }

  private handleExtensionUi(conversationId: string, request: ExtensionUiRequest): void {
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) return;
    const sanitizedRequest = sanitizeExtensionRequest(request);
    const ui = runtime.extensionUi;

    if (sanitizedRequest.method === "setStatus" && sanitizedRequest.statusKey) {
      if (sanitizedRequest.statusText) ui.statuses[sanitizedRequest.statusKey] = sanitizedRequest.statusText;
      else delete ui.statuses[sanitizedRequest.statusKey];
    } else if (sanitizedRequest.method === "setWorkingMessage") {
      ui.workingMessage = sanitizedRequest.workingText;
    } else if (sanitizedRequest.method === "setWorkingVisible") {
      ui.workingVisible = sanitizedRequest.workingVisible !== false;
    } else if (sanitizedRequest.method === "setWorkingIndicator") {
      ui.workingIndicator = sanitizedRequest.workingIndicator;
    } else if (sanitizedRequest.method === "setHiddenThinkingLabel") {
      ui.hiddenThinkingLabel = sanitizedRequest.hiddenThinkingLabel;
    } else if (sanitizedRequest.method === "setWidget" && sanitizedRequest.widgetKey) {
      ui.widgets = ui.widgets.filter((widget) => widget.key !== sanitizedRequest.widgetKey);
      if (sanitizedRequest.widgetLines) {
        ui.widgets.push({
          key: sanitizedRequest.widgetKey,
          lines: sanitizedRequest.widgetLines,
          placement: sanitizedRequest.widgetPlacement ?? "aboveEditor",
        });
      }
    } else if (sanitizedRequest.method === "setHeader") {
      ui.headerLines = sanitizedRequest.customLines ?? [];
    } else if (sanitizedRequest.method === "setFooter") {
      ui.footerLines = sanitizedRequest.customLines ?? [];
    } else if (sanitizedRequest.method === "setTitle") {
      ui.title = sanitizedRequest.title;
    } else if (["select", "confirm", "input", "editor", "custom"].includes(sanitizedRequest.method)) {
      ui.pendingDialogs = [
        ...ui.pendingDialogs.filter((item) => item.id !== sanitizedRequest.id),
        sanitizedRequest,
      ];
    } else if (sanitizedRequest.method === "customClose") {
      ui.pendingDialogs = ui.pendingDialogs.filter((item) => item.id !== sanitizedRequest.id);
    }

    if (runtime.snapshot) runtime.snapshot.extensionUi = structuredClone(ui);
    this.getWindow()?.webContents.send("pi:extension-ui", { conversationId, request: sanitizedRequest });
  }

  private async refreshState(conversationId: string, runtime: RuntimeRecord): Promise<RuntimeState> {
    const state = this.normalizeState(await runtime.rpc.request<JsonObject>("get_state"));
    if (runtime.snapshot) runtime.snapshot.state = state;
    return state;
  }

  private async refreshRuntimeSnapshot(runtime: RuntimeRecord): Promise<void> {
    const [stateData, messagesData, entriesData, extensionData] = await Promise.all([
      runtime.rpc.request<JsonObject>("get_state"),
      runtime.rpc.request<{ messages: unknown[] }>("get_messages"),
      runtime.rpc.request<{ entries: ConversationSnapshot["entries"] }>("get_session_entries"),
      runtime.rpc.request<Omit<ExtensionState, "errors">>("get_extension_state"),
    ]);
    if (!runtime.snapshot) return;
    runtime.snapshot.state = this.normalizeState(stateData);
    runtime.snapshot.messages = messagesData.messages ?? [];
    runtime.snapshot.entries = entriesData.entries ?? [];
    runtime.snapshot.extensionState = { ...extensionData, errors: [...runtime.extensionErrors] };
    this.cachedExtensionState = structuredClone(runtime.snapshot.extensionState);
    runtime.snapshot.extensionUi = structuredClone(runtime.extensionUi);
  }

  private normalizeState(value: JsonObject): RuntimeState {
    const model = value.model && typeof value.model === "object" ? (value.model as ModelInfo) : null;
    return {
      model,
      thinkingLevel: (value.thinkingLevel as ThinkingLevel | undefined) ?? "off",
      isStreaming: Boolean(value.isStreaming),
      isCompacting: Boolean(value.isCompacting),
      steeringMode: value.steeringMode === "all" ? "all" : "one-at-a-time",
      followUpMode: value.followUpMode === "all" ? "all" : "one-at-a-time",
      autoCompactionEnabled: value.autoCompactionEnabled !== false,
      messageCount: typeof value.messageCount === "number" ? value.messageCount : undefined,
      pendingMessageCount: typeof value.pendingMessageCount === "number" ? value.pendingMessageCount : undefined,
      steeringMessages: Array.isArray(value.steeringMessages) ? value.steeringMessages.map(String) : [],
      followUpMessages: Array.isArray(value.followUpMessages) ? value.followUpMessages.map(String) : [],
      workingVisible: value.workingVisible !== false,
      workingIndicator: value.workingIndicator && typeof value.workingIndicator === "object"
        ? value.workingIndicator as RuntimeState["workingIndicator"]
        : undefined,
      hiddenThinkingLabel: typeof value.hiddenThinkingLabel === "string" ? value.hiddenThinkingLabel : undefined,
      sessionFile: typeof value.sessionFile === "string" ? value.sessionFile : undefined,
      sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
      sessionName: typeof value.sessionName === "string" ? value.sessionName : undefined,
      contextUsage: value.contextUsage && typeof value.contextUsage === "object"
        ? value.contextUsage as RuntimeState["contextUsage"]
        : undefined,
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

function allThinkingLevels(): ThinkingLevel[] {
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
}

function isThinkingLevel(value: string): value is ThinkingLevel {
  return allThinkingLevels().includes(value as ThinkingLevel);
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

function sanitizeDisplayLines(lines?: string[]): string[] | undefined {
  if (!lines) return undefined;
  return lines.map((line) => String(line)
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/\s+$/g, ""));
}

function sanitizeExtensionRequest(request: ExtensionUiRequest): ExtensionUiRequest {
  return {
    ...request,
    title: sanitizeStatusText(request.title),
    message: sanitizeStatusText(request.message),
    statusText: sanitizeStatusText(request.statusText),
    workingText: sanitizeStatusText(request.workingText),
    hiddenThinkingLabel: sanitizeStatusText(request.hiddenThinkingLabel),
    widgetLines: sanitizeDisplayLines(request.widgetLines),
    customLines: sanitizeDisplayLines(request.customLines),
  };
}
