import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { applyGoalReport, goalPrompt, settleGoal } from "../shared/goal.js";
import { imageAttachmentPrompt } from "../shared/image-attachments.js";
import { app, BrowserWindow, shell } from "electron";
import { existsSync } from "node:fs";
import type {
  Attachment,
  CompactionRecord,
  ConversationRun,
  ConversationRecord,
  ConversationSnapshot,
  ExtensionState,
  ExtensionUiRequest,
  ExtensionUiState,
  LiveToolActivity,
  ModelInfo,
  ProjectRecord,
  QueuedPrompt,
  RuntimeState,
  ThinkingLevel,
} from "../shared/types.js";
import { DataStore } from "./data-store.js";
import { PiRpcProcess } from "./pi-rpc-process.js";
import {
  RunDiffTracker,
  type ModelFileMutation,
  type ModelFileSnapshot,
} from "./run-diff-tracker.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { applyAssistantMessageDelta } from "../shared/live-message.js";

type JsonObject = Record<string, unknown>;

function isModelFileSnapshot(value: unknown): value is ModelFileSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as JsonObject;
  if (snapshot.kind === "missing") return true;
  if (snapshot.kind === "text") return typeof snapshot.text === "string";
  return snapshot.kind === "unsupported";
}

function isModelFileMutation(value: unknown): value is ModelFileMutation {
  if (!value || typeof value !== "object") return false;
  const mutation = value as JsonObject;
  return (
    typeof mutation.path === "string" &&
    isModelFileSnapshot(mutation.before) &&
    isModelFileSnapshot(mutation.after)
  );
}

interface RuntimeRecord {
  goalProgressAtStart?: string;
  rpc: PiRpcProcess;
  snapshot?: ConversationSnapshot;
  diffTracker?: RunDiffTracker;
  diffRefresh?: Promise<void>;
  diffRefreshQueued?: boolean;
  extensionUi: ExtensionUiState;
  extensionErrors: ExtensionState["errors"];
  eventQueue: Promise<void>;
  activeRun?: ConversationRun;
  compactionStartedAt?: number;
  liveMessage?: JsonObject;
  liveTools: Record<string, LiveToolActivity>;
  pendingInstructionsRevision?: number;
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

/** Минимальный интервал записи live-diff на диск (финальный diff пишется всегда). */
const LIVE_DIFF_PERSIST_INTERVAL_MS = 2500;

const BUILTIN_COMMANDS: ConversationSnapshot["commands"] = [
  {
    name: "compact",
    description: "Сжать контекст текущей сессии",
    source: "builtin",
  },
  {
    name: "reload",
    description: "Перезагрузить расширения, навыки, промпты и настройки Pi",
    source: "builtin",
  },
];

function preserveKnownContextUsage(
  next: RuntimeState,
  previous?: RuntimeState["contextUsage"],
): RuntimeState {
  if (
    typeof next.contextUsage?.tokens === "number" ||
    typeof previous?.tokens !== "number"
  )
    return next;
  return { ...next, contextUsage: previous };
}

export class PiManager {
  private readonly goalLaunching = new Set<string>();
  private readonly goalContinuationRequested = new Set<string>();
  private readonly runtimes = new Map<string, RuntimeRecord>();
  private instructionsRevision = 0;
  private cachedCommands: ConversationSnapshot["commands"] =
    structuredClone(BUILTIN_COMMANDS);
  private cachedExtensionState: ExtensionState = createEmptyExtensionState();

  constructor(
    private readonly store: DataStore,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly onConversationSettled?: (
      conversation: ConversationRecord,
    ) => void,
  ) {}

  async createConversation(projectId?: string): Promise<ConversationSnapshot> {
    const conversation = await this.store.createConversation(projectId);
    return this.previewConversation(conversation);
  }

  async openConversation(
    conversationId: string,
  ): Promise<ConversationSnapshot> {
    await this.store.activateConversation(conversationId);
    const running = this.runtimes.get(conversationId);
    if (running?.snapshot) {
      if (running.snapshot.state.isStreaming)
        await this.refreshRuntimeSnapshot(running);
      running.snapshot.queuedPrompts =
        this.store.getQueuedPrompts(conversationId);
      return this.snapshotWithLiveState(running);
    }
    return this.previewConversation(this.store.getConversation(conversationId));
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.stopConversation(conversationId);
    const conversation = this.store.getConversation(conversationId);
    if (conversation.sessionFile && existsSync(conversation.sessionFile)) {
      await shell.trashItem(
        this.store.assertManagedSessionFile(conversation.sessionFile),
      );
    }
    // Standalone chats own an internal folder (data/chats/<id>) that must not
    // outlive the chat; project chats keep their folders on the user's side.
    const chatDir = conversation.projectId
      ? undefined
      : this.store.getConversationChatDirectory(conversation);
    await this.store.deleteConversation(conversationId);
    if (chatDir && existsSync(chatDir)) {
      try {
        await shell.trashItem(chatDir);
      } catch (error) {
        console.warn(
          `Failed to move chat folder ${chatDir} to the recycle bin:`,
          error,
        );
      }
    }
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
    expectedGoalId?: string,
  ): Promise<void> {
    if (
      expectedGoalId &&
      (this.store.getConversation(conversationId).goal?.id !== expectedGoalId ||
        this.store.getConversation(conversationId).goal?.status !== "active")
    )
      return;
    const runtime = await this.ensureRuntime(conversationId);
    await this.reloadPendingInstructions(conversationId, runtime);
    if (
      expectedGoalId &&
      (this.store.getConversation(conversationId).goal?.id !== expectedGoalId ||
        this.store.getConversation(conversationId).goal?.status !== "active")
    )
      return;
    if (
      expectedGoalId &&
      !runtime.snapshot?.extensionState.activeTools.includes(
        "desktop_goal_report",
      )
    )
      throw new Error(
        "Инструмент цели не загрузился. Проверьте ошибки модулей Pi.",
      );
    if (runtime.snapshot) {
      this.getWindow()?.webContents.send("pi:event", {
        conversationId,
        event: {
          type: "desktop_state",
          state: structuredClone(runtime.snapshot.state),
          commands: structuredClone(runtime.snapshot.commands),
        },
      });
    }
    const conversation = this.store.getConversation(conversationId);
    if (
      !runtime.snapshot?.state.isStreaming &&
      (!runtime.activeRun || runtime.activeRun.completedAt)
    ) {
      runtime.activeRun = { startedAt: new Date().toISOString() };
      runtime.diffRefresh = undefined;
      runtime.diffRefreshQueued = false;
      if (runtime.snapshot)
        runtime.snapshot.run = structuredClone(runtime.activeRun);
      await this.store.saveConversationRun(conversationId, runtime.activeRun);
      this.getWindow()?.webContents.send("pi:event", {
        conversationId,
        event: { type: "desktop_run_started", run: runtime.activeRun },
      });
    }
    let startedDiffTracker = false;
    const workspacePaths =
      await this.store.getConversationWorkspacePaths(conversation);
    if (runtime.diffTracker && !runtime.diffTracker.covers(workspacePaths)) {
      runtime.diffTracker.close();
      runtime.diffTracker = undefined;
    }
    if (!runtime.diffTracker) {
      runtime.diffTracker = RunDiffTracker.start(workspacePaths, {
        onLiveChange: () => this.queueLiveDiffRefresh(conversationId, runtime),
      });
      startedDiffTracker = true;
    }
    await runtime.diffTracker.beginRun();
    const imageAttachments = attachments.filter(
      (item) => item.mimeType?.startsWith("image/") && item.data,
    );
    const fileAttachments = attachments.filter(
      (item) => !item.mimeType?.startsWith("image/") || !item.data,
    );
    const fileList = fileAttachments.map((item) => `- ${item.path}`).join("\n");
    let preparedMessage = fileList
      ? `${message}\n\nAttached files available in the workspace or filesystem:\n${fileList}`
      : message;
    preparedMessage += imageAttachmentPrompt(imageAttachments);
    const images = imageAttachments.map((item) => ({
      type: "image",
      data: item.data,
      mimeType: item.mimeType,
    }));
    const goal = this.store.getConversation(conversationId).goal;
    if (
      expectedGoalId &&
      (goal?.id !== expectedGoalId || goal.status !== "active")
    )
      return;
    if (goal?.status === "active") {
      const next = !runtime.snapshot?.state.isStreaming
        ? { ...goal, steps: goal.steps + 1 }
        : goal;
      runtime.goalProgressAtStart = goal.progress;
      await this.updateConversation(conversationId, { goal: next });
      preparedMessage += `\n\n${goalPrompt(next)}`;
    }
    if (conversation.title === "Новый чат") {
      const title =
        message.replace(/\s+/g, " ").trim().slice(0, 64) || "Новый чат";
      await this.updateConversation(conversationId, { title });
      await runtime.rpc.request("set_session_name", { name: title });
    }
    const payload = {
      message: preparedMessage,
      ...(images.length ? { images } : {}),
    };
    try {
      if (expectedGoalId) {
        const current = this.store.getConversation(conversationId).goal;
        if (current?.id !== expectedGoalId || current.status !== "active")
          throw new Error("Запуск цели отменён.");
      }
      if (behavior === "steer") await runtime.rpc.request("steer", payload);
      else if (behavior === "followUp")
        await runtime.rpc.request("follow_up", payload);
      else await runtime.rpc.request("prompt", payload);
    } catch (error) {
      if (startedDiffTracker && runtime.diffTracker) {
        runtime.diffTracker.close();
        runtime.diffTracker = undefined;
      }
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

  async queuePrompt(
    conversationId: string,
    message: string,
    attachments: Attachment[],
  ): Promise<QueuedPrompt[]> {
    const queued = await this.store.queuePrompt(
      conversationId,
      message,
      attachments,
    );
    this.syncQueuedPrompts(conversationId, queued);
    return queued;
  }

  async sendQueuedPrompt(
    conversationId: string,
    promptId: string,
  ): Promise<QueuedPrompt[]> {
    const prompt = this.store
      .getQueuedPrompts(conversationId)
      .find((item) => item.id === promptId);
    if (!prompt) throw new Error("Сообщение в очереди не найдено");
    const runtime = this.runtimes.get(conversationId);
    const isStreaming = runtime
      ? (await this.refreshState(conversationId, runtime)).isStreaming
      : false;
    await this.sendPrompt(
      conversationId,
      prompt.message,
      prompt.attachments,
      isStreaming ? "steer" : undefined,
    );
    const queued = await this.store.removeQueuedPrompt(
      conversationId,
      promptId,
    );
    this.syncQueuedPrompts(conversationId, queued);
    return queued;
  }

  async removeQueuedPrompt(
    conversationId: string,
    promptId: string,
  ): Promise<QueuedPrompt[]> {
    const queued = await this.store.removeQueuedPrompt(
      conversationId,
      promptId,
    );
    this.syncQueuedPrompts(conversationId, queued);
    return queued;
  }

  async abort(conversationId: string): Promise<void> {
    const goal = this.store.getConversation(conversationId).goal;
    if (goal?.status === "active")
      await this.updateConversation(conversationId, {
        goal: { ...goal, status: "paused" },
      });
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) return;
    await runtime.rpc.request("abort");
  }

  async setGoal(
    conversationId: string,
    objective: string,
    attachments: Attachment[],
  ): Promise<void> {
    if (
      typeof objective !== "string" ||
      !objective.trim() ||
      objective.length > 8000 ||
      !Array.isArray(attachments)
    )
      throw new Error("Опишите цель сообщением.");
    if (
      this.goalLaunching.has(conversationId) ||
      this.store.getConversation(conversationId).goal?.status === "active" ||
      this.store.getConversation(conversationId).status !== "idle"
    )
      throw new Error("Сначала остановите текущую работу.");
    await this.updateConversation(conversationId, {
      goal: {
        id: randomUUID(),
        objective: objective.trim(),
        criteria: "",
        maxSteps: 25,
        status: "active",
        progress: "",
        evidence: "",
        steps: 0,
        stalledSteps: 0,
        updatedAt: new Date().toISOString(),
      },
    });
    this.launchGoal(conversationId, attachments);
  }

  async controlGoal(
    conversationId: string,
    action: "pause" | "resume" | "remove",
  ): Promise<void> {
    if (!["pause", "resume", "remove"].includes(action))
      throw new Error("Неизвестное действие цели");
    const goal = this.store.getConversation(conversationId).goal;
    if (!goal) return;
    if (action !== "resume") {
      await this.abort(conversationId);
      if (action === "remove")
        await this.updateConversation(conversationId, { goal: undefined });
      return;
    }
    if (goal.status === "complete")
      throw new Error("Цель уже выполнена. Создайте новую цель.");
    if (goal.status === "active") return;
    if (
      this.goalLaunching.has(conversationId) ||
      this.store.getConversation(conversationId).status !== "idle"
    )
      throw new Error("Дождитесь остановки текущей работы.");
    await this.updateConversation(conversationId, {
      goal: {
        ...goal,
        status: "active",
        stalledSteps: 0,
        maxSteps: goal.steps >= goal.maxSteps ? goal.steps + 10 : goal.maxSteps,
      },
    });
    this.launchGoal(conversationId);
  }

  private launchGoal(
    conversationId: string,
    attachments: Attachment[] = [],
  ): void {
    if (this.goalLaunching.has(conversationId)) return;
    const goal = this.store.getConversation(conversationId).goal;
    if (goal?.status !== "active") return;
    this.goalLaunching.add(conversationId);
    // Never await a prompt from the RPC event queue: its completion needs that queue.
    setTimeout(() => {
      void this.sendPrompt(
        conversationId,
        goal.steps === 0
          ? goal.objective
          : "Выполни следующий этап активной цели.",
        attachments,
        undefined,
        goal.id,
      )
        .catch(async (error) => {
          const current = this.store
            .snapshot()
            .conversations.find((item) => item.id === conversationId)?.goal;
          if (current?.id === goal.id && current.status === "active")
            await this.updateConversation(conversationId, {
              goal: {
                ...current,
                status: "paused",
                evidence:
                  error instanceof Error ? error.message : String(error),
              },
            });
        })
        .finally(() => {
          this.goalLaunching.delete(conversationId);
          if (
            this.goalContinuationRequested.delete(conversationId) &&
            this.runtimes.has(conversationId) &&
            this.store.getConversation(conversationId).status === "idle"
          )
            this.launchGoal(conversationId);
        });
    }, 0);
  }

  async setModel(
    conversationId: string,
    provider: string,
    modelId: string,
  ): Promise<RuntimeState> {
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) {
      const updated = await this.updateConversation(conversationId, {
        provider,
        model: modelId,
      });
      return (await this.previewConversation(updated)).state;
    }
    await runtime.rpc.request("set_model", { provider, modelId });
    await this.updateConversation(conversationId, { provider, model: modelId });
    return this.refreshState(conversationId, runtime);
  }

  async setThinkingLevel(
    conversationId: string,
    level: ThinkingLevel,
  ): Promise<RuntimeState> {
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) {
      const updated = await this.updateConversation(conversationId, {
        thinkingLevel: level,
      });
      return (await this.previewConversation(updated)).state;
    }
    await runtime.rpc.request("set_thinking_level", { level });
    await this.updateConversation(conversationId, { thinkingLevel: level });
    return this.refreshState(conversationId, runtime);
  }

  async renameConversation(
    conversationId: string,
    title: string,
  ): Promise<void> {
    const normalized = title.trim();
    if (!normalized) return;
    const conversation = this.store.getConversation(conversationId);
    const runtime = this.runtimes.get(conversationId);
    if (runtime) {
      await runtime.rpc.request("set_session_name", { name: normalized });
    } else if (
      conversation.sessionFile &&
      existsSync(conversation.sessionFile)
    ) {
      const cwd =
        await this.store.getConversationWorkingDirectory(conversation);
      SessionManager.open(
        conversation.sessionFile,
        this.store.getSessionDir(cwd),
        cwd,
      ).appendSessionInfo(normalized);
    }
    await this.updateConversation(conversationId, { title: normalized });
  }

  respondToExtensionUi(conversationId: string, response: JsonObject): void {
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) return;
    if (
      response.cancelled === true ||
      typeof response.customInput !== "string"
    ) {
      runtime.extensionUi.pendingDialogs =
        runtime.extensionUi.pendingDialogs.filter(
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

  async clearQueue(
    conversationId: string,
  ): Promise<{ steering: string[]; followUp: string[] }> {
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) return { steering: [], followUp: [] };
    const result = await runtime.rpc.request<{
      steering: string[];
      followUp: string[];
    }>("clear_queue");
    await this.refreshState(conversationId, runtime);
    return result;
  }

  async compactConversation(
    conversationId: string,
    customInstructions?: string,
  ): Promise<ConversationSnapshot> {
    const runtime = await this.ensureRuntime(conversationId);
    const state = await this.refreshState(conversationId, runtime);
    if (state.isStreaming || state.isCompacting)
      throw new Error("Дождитесь завершения текущей операции перед сжатием");
    // An unopened runtime can have newer context usage than the renderer's preview.
    // Publish it before Pi emits compaction_start so the counter stays visible throughout compaction.
    this.getWindow()?.webContents.send("pi:event", {
      conversationId,
      event: {
        type: "desktop_state",
        state: structuredClone(state),
        commands: structuredClone(
          runtime.snapshot?.commands ?? this.cachedCommands,
        ),
      },
    });
    const normalized = customInstructions?.trim();
    const startedAt = Date.now();
    const result = await runtime.rpc.request<{
      tokensBefore: number;
      estimatedTokensAfter: number;
    }>("compact", normalized ? { customInstructions: normalized } : {});
    await this.refreshRuntimeSnapshot(runtime);
    const entry = [...runtime.snapshot!.entries]
      .reverse()
      .find((item) => item.type === "compaction");
    if (entry && typeof entry.id === "string") {
      const record: CompactionRecord = {
        entryId: entry.id,
        timestamp:
          typeof entry.timestamp === "string"
            ? entry.timestamp
            : new Date().toISOString(),
        tokensBefore: result.tokensBefore,
        tokensAfter: result.estimatedTokensAfter,
        durationMs: Date.now() - startedAt,
      };
      await this.store.saveCompaction(conversationId, record);
      runtime.snapshot!.compactions = this.store.getCompactions(conversationId);
    }
    this.applyEstimatedContextUsage(runtime, result.estimatedTokensAfter);
    return structuredClone(runtime.snapshot!);
  }

  async reloadRuntime(conversationId: string): Promise<ConversationSnapshot> {
    const runtime = await this.ensureRuntime(conversationId);
    const state = await this.refreshState(conversationId, runtime);
    if (state.isStreaming || state.isCompacting)
      throw new Error(
        "Дождитесь завершения текущей операции перед перезагрузкой",
      );
    const pendingRevision = runtime.pendingInstructionsRevision;
    await this.reloadRuntimeResources(runtime);
    if (runtime.pendingInstructionsRevision === pendingRevision)
      runtime.pendingInstructionsRevision = undefined;
    return structuredClone(runtime.snapshot!);
  }

  invalidateInstructions(projectId?: string): void {
    const revision = ++this.instructionsRevision;
    for (const [conversationId, runtime] of this.runtimes) {
      const conversation = this.store.getConversation(conversationId);
      if (projectId && conversation.projectId !== projectId) continue;
      runtime.pendingInstructionsRevision = revision;
    }
  }

  private async reloadPendingInstructions(
    conversationId: string,
    runtime: RuntimeRecord,
  ): Promise<void> {
    const pendingRevision = runtime.pendingInstructionsRevision;
    if (pendingRevision === undefined) return;
    const state = await this.refreshState(conversationId, runtime);
    if (state.isStreaming || state.isCompacting) return;
    await this.reloadRuntimeResources(runtime);
    if (runtime.pendingInstructionsRevision === pendingRevision)
      runtime.pendingInstructionsRevision = undefined;
  }

  private async reloadRuntimeResources(runtime: RuntimeRecord): Promise<void> {
    runtime.extensionUi = createExtensionUiState();
    runtime.extensionErrors = [];
    await runtime.rpc.request("reload");
    const commandsData = await runtime.rpc.request<{
      commands: ConversationSnapshot["commands"];
    }>("get_commands");
    this.cachedCommands = commandsData.commands ?? [];
    await this.refreshRuntimeSnapshot(runtime);
    runtime.snapshot!.commands = structuredClone(this.cachedCommands);
  }

  private syncQueuedPrompts(
    conversationId: string,
    queued: QueuedPrompt[],
  ): void {
    const runtime = this.runtimes.get(conversationId);
    if (runtime?.snapshot)
      runtime.snapshot.queuedPrompts = structuredClone(queued);
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
    await Promise.all(
      this.store
        .snapshot()
        .conversations.filter((item) => item.goal?.status === "active")
        .map((item) =>
          this.updateConversation(item.id, {
            goal: { ...item.goal!, status: "paused" },
          }),
        ),
    );
    this.goalContinuationRequested.clear();
    await Promise.all(
      [...this.runtimes.values()].map(async (runtime) => {
        runtime.diffTracker?.close();
        runtime.diffTracker = undefined;
      }),
    );
    await Promise.all(
      [...this.runtimes.values()].map((runtime) => runtime.rpc.stop()),
    );
    this.runtimes.clear();
  }

  async prepareForRuntimeUpdate(): Promise<void> {
    const active = [...this.runtimes.values()].some(
      (runtime) => runtime.snapshot?.state.isStreaming,
    );
    if (active)
      throw new Error(
        "Дождитесь завершения текущего ответа или остановите его перед обновлением",
      );
    await this.shutdown();
  }

  private async previewConversation(
    conversation: ConversationRecord,
  ): Promise<ConversationSnapshot> {
    const configuration = await this.store.getAgentConfiguration();
    let messages: unknown[] = [];
    let entries: ConversationSnapshot["entries"] = [];
    let sessionModel: { provider: string; modelId: string } | null = null;
    let sessionThinkingLevel: ThinkingLevel | undefined;
    let sessionName: string | undefined;

    if (conversation.sessionFile && existsSync(conversation.sessionFile)) {
      const cwd =
        await this.store.getConversationWorkingDirectory(conversation);
      const manager = SessionManager.open(
        conversation.sessionFile,
        this.store.getSessionDir(cwd),
        cwd,
      );
      const context = manager.buildSessionContext();
      messages = context.messages;
      entries = manager
        .getEntries()
        .map((entry) =>
          structuredClone(entry),
        ) as unknown as ConversationSnapshot["entries"];
      sessionModel = context.model;
      sessionThinkingLevel = isThinkingLevel(context.thinkingLevel)
        ? context.thinkingLevel
        : undefined;
      sessionName = manager.getSessionName();
    }

    const provider =
      conversation.provider ??
      sessionModel?.provider ??
      configuration.defaultProvider;
    const modelId =
      conversation.model ?? sessionModel?.modelId ?? configuration.defaultModel;
    const model: ModelInfo | null =
      provider && modelId
        ? (configuration.models.find(
            (item) => item.provider === provider && item.id === modelId,
          ) ?? { provider, id: modelId })
        : null;
    const thinkingLevels: ThinkingLevel[] =
      model?.thinkingLevels ??
      (model?.reasoning ? allThinkingLevels() : ["off"]);
    const requestedThinkingLevel =
      conversation.thinkingLevel ??
      sessionThinkingLevel ??
      configuration.defaultThinkingLevel;
    const thinkingLevel = thinkingLevels.includes(requestedThinkingLevel)
      ? requestedThinkingLevel
      : (thinkingLevels[0] ?? "off");

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
      commands: structuredClone(BUILTIN_COMMANDS),
      entries,
      compactions: this.store.getCompactions(conversation.id),
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

  private async startConversation(
    conversation: ConversationRecord,
  ): Promise<ConversationSnapshot> {
    const existing = this.runtimes.get(conversation.id);
    if (existing?.snapshot) return structuredClone(existing.snapshot);
    const cwd = await this.store.getConversationWorkingDirectory(conversation);
    const project = conversation.projectId
      ? this.store.getProject(conversation.projectId)
      : undefined;
    const appendSystemPrompt =
      project && project.paths.length > 1
        ? [
            "Additional directories supplied by the user for this project:",
            ...project.paths.slice(1).map((projectPath) => `- ${projectPath}`),
            `The primary Pi working directory remains ${project.path}. Treat the listed paths only as additional project context and use absolute paths to access them.`,
          ].join("\n")
        : undefined;
    await this.updateConversation(conversation.id, { status: "starting" });

    const cliPath = this.store.getPiCliPath();
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
      goalExtensionPath: fileURLToPath(
        new URL("./goal-extension.js", import.meta.url),
      ),
      appRoot: app.getAppPath(),
      mcpEntryPath: path.join(
        app.getAppPath(),
        "node_modules",
        "@zavora-ai",
        "computer-use-mcp",
        "dist",
        "server.js",
      ),
      mcpDirectTools: await this.store.getMcpDirectToolSelectors(),
      onEvent: (event) => {
        record.eventQueue = record.eventQueue
          .then(() => this.handleEvent(conversation.id, event))
          .catch((queueError) => {
            this.getWindow()?.webContents.send("pi:event", {
              conversationId: conversation.id,
              event: {
                type: "runtime_error",
                error:
                  queueError instanceof Error
                    ? queueError.message
                    : String(queueError),
              },
            });
          });
      },
      onExtensionUi: (request) =>
        this.handleExtensionUi(conversation.id, request),
      onExit: (error) => {
        if (this.runtimes.get(conversation.id) !== record) return;
        this.runtimes.delete(conversation.id);
        void this.handleRuntimeExit(conversation.id, record, error).catch(
          (exitError) => {
            this.getWindow()?.webContents.send("pi:event", {
              conversationId: conversation.id,
              event: {
                type: "runtime_error",
                error:
                  exitError instanceof Error
                    ? exitError.message
                    : String(exitError),
              },
            });
          },
        );
      },
    });
    record = {
      rpc,
      extensionUi: createExtensionUiState(),
      extensionErrors: [],
      eventQueue: Promise.resolve(),
      activeRun: await this.store.getConversationRun(conversation.id),
      liveTools: {},
    };
    this.runtimes.set(conversation.id, record);
    try {
      await rpc.start();
      const [
        stateData,
        messagesData,
        modelsData,
        levelsData,
        commandsData,
        entriesData,
        extensionData,
      ] = await Promise.all([
        rpc.request<JsonObject>("get_state"),
        rpc.request<{ messages: unknown[] }>("get_messages"),
        rpc.request<{ models: ModelInfo[] }>("get_available_models"),
        rpc.request<{ levels: ThinkingLevel[] }>(
          "get_available_thinking_levels",
        ),
        rpc.request<{
          commands: Array<{
            name: string;
            description?: string;
            source: string;
          }>;
        }>("get_commands"),
        rpc.request<{ entries: ConversationSnapshot["entries"] }>(
          "get_session_entries",
        ),
        rpc.request<Omit<ExtensionState, "errors">>("get_extension_state"),
      ]);
      const state = this.normalizeState(stateData);
      this.cachedCommands = commandsData.commands ?? [];
      this.cachedExtensionState = {
        ...extensionData,
        errors: [...record.extensionErrors],
      };
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
        compactions: this.store.getCompactions(conversation.id),
        extensionState: {
          ...extensionData,
          errors: [...record.extensionErrors],
        },
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

  private async handleEvent(
    conversationId: string,
    event: JsonObject,
  ): Promise<void> {
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) return;
    if (event.type === "agent_start") {
      runtime.liveMessage = undefined;
      runtime.liveTools = {};
      if (!runtime.activeRun || runtime.activeRun.completedAt) {
        runtime.activeRun = { startedAt: new Date().toISOString() };
        runtime.diffRefresh = undefined;
        runtime.diffRefreshQueued = false;
        await this.store.saveConversationRun(conversationId, runtime.activeRun);
      }
      if (runtime.snapshot)
        runtime.snapshot.run = structuredClone(runtime.activeRun);
      if (runtime.snapshot) runtime.snapshot.state.isStreaming = true;
      await this.updateConversation(conversationId, { status: "working" });
    } else if (event.type === "agent_settled") {
      await this.updateConversation(conversationId, { status: "idle" });
      await this.refreshRuntimeSnapshot(runtime);
      // Трекер переиспользуется между запусками: не закрываем и не сбрасываем.
      const tracker = runtime.diffTracker;
      await runtime.diffRefresh;
      runtime.diffRefresh = undefined;
      runtime.diffRefreshQueued = false;
      if (runtime.activeRun && !runtime.activeRun.completedAt) {
        const completedAt = new Date().toISOString();
        runtime.activeRun = {
          ...runtime.activeRun,
          completedAt,
          durationMs:
            Date.parse(completedAt) - Date.parse(runtime.activeRun.startedAt),
        };
        await this.store.saveConversationRun(conversationId, runtime.activeRun);
        if (runtime.snapshot)
          runtime.snapshot.run = structuredClone(runtime.activeRun);
      }
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
          const diff = await tracker.endRun();
          if (runtime.activeRun) {
            runtime.activeRun = { ...runtime.activeRun, diff };
            await this.store.saveConversationRun(
              conversationId,
              runtime.activeRun,
            );
            if (runtime.snapshot)
              runtime.snapshot.run = structuredClone(runtime.activeRun);
          }
          this.getWindow()?.webContents.send("pi:event", {
            conversationId,
            event: { type: "desktop_run_diff", diff, run: runtime.activeRun },
          });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (runtime.activeRun) {
            runtime.activeRun = { ...runtime.activeRun, diffError: message };
            await this.store.saveConversationRun(
              conversationId,
              runtime.activeRun,
            );
          }
          this.getWindow()?.webContents.send("pi:event", {
            conversationId,
            event: { type: "desktop_diff_error", error: message },
          });
        }
      }
      runtime.liveMessage = undefined;
      runtime.liveTools = {};
      this.onConversationSettled?.(this.store.getConversation(conversationId));
      const goal = this.store.getConversation(conversationId).goal;
      if (goal?.status === "active") {
        const last = [...(runtime.snapshot?.messages ?? [])]
          .reverse()
          .find((message) => (message as JsonObject)?.role === "assistant") as
          | JsonObject
          | undefined;
        const next =
          last?.stopReason === "error" || last?.stopReason === "aborted"
            ? {
                ...goal,
                status: "paused" as const,
                evidence:
                  "Ответ прерван или завершился ошибкой. Проверьте чат перед продолжением.",
              }
            : settleGoal(goal, runtime.goalProgressAtStart ?? "");
        await this.updateConversation(conversationId, { goal: next });
      }
      const hasQueued = this.store.getQueuedPrompts(conversationId).length > 0;
      if (hasQueued) void this.sendNextQueuedPrompt(conversationId);
      else {
        if (this.goalLaunching.has(conversationId))
          this.goalContinuationRequested.add(conversationId);
        else this.launchGoal(conversationId);
      }
      return;
    } else if (
      event.type === "message_start" &&
      event.message &&
      (event.message as JsonObject).role === "assistant"
    ) {
      runtime.liveMessage = structuredClone(event.message as JsonObject);
    } else if (event.type === "message_update" && event.assistantMessageEvent) {
      runtime.liveMessage = applyAssistantMessageDelta(
        runtime.liveMessage,
        event.assistantMessageEvent as JsonObject,
      );
    } else if (
      event.type === "message_end" &&
      runtime.snapshot &&
      event.message
    ) {
      runtime.snapshot.messages.push(event.message);
      if ((event.message as JsonObject).role === "assistant") {
        event.state = await this.refreshState(conversationId, runtime);
        runtime.liveMessage = undefined;
      }
    } else if (
      event.type === "tool_execution_start" &&
      typeof event.toolCallId === "string"
    ) {
      runtime.liveTools[event.toolCallId] = {
        id: event.toolCallId,
        name:
          typeof event.toolName === "string" ? event.toolName : "Инструмент",
        args: event.args,
        running: true,
        startedAt: Date.now(),
      };
    } else if (
      event.type === "tool_execution_update" &&
      typeof event.toolCallId === "string"
    ) {
      const current = runtime.liveTools[event.toolCallId];
      runtime.liveTools[event.toolCallId] = {
        ...(current ?? {
          id: event.toolCallId,
          name:
            typeof event.toolName === "string" ? event.toolName : "Инструмент",
          running: true,
          startedAt: Date.now(),
        }),
        result: event.partialResult,
      };
    } else if (
      event.type === "tool_execution_end" &&
      typeof event.toolCallId === "string"
    ) {
      if (event.toolName === "desktop_goal_report" && !event.isError) {
        const goal = this.store.getConversation(conversationId).goal;
        const details = (event.result as JsonObject | undefined)?.details as
          | JsonObject
          | undefined;
        if (goal) {
          const next = applyGoalReport(goal, details?.desktopGoalReport);
          if (next !== goal)
            await this.updateConversation(conversationId, { goal: next });
        }
      }
      const current = runtime.liveTools[event.toolCallId];
      runtime.liveTools[event.toolCallId] = {
        ...(current ?? {
          id: event.toolCallId,
          name:
            typeof event.toolName === "string" ? event.toolName : "Инструмент",
          startedAt: Date.now(),
        }),
        result: event.result,
        running: false,
        error: Boolean(event.isError),
      };
      if (
        runtime.diffTracker &&
        isModelFileMutation(event.desktopFileMutation)
      ) {
        runtime.diffTracker.recordModelMutation(event.desktopFileMutation);
        this.queueLiveDiffRefresh(conversationId, runtime);
      }
    } else if (event.type === "queue_update" && runtime.snapshot) {
      const steeringMessages = Array.isArray(event.steering)
        ? event.steering.map(String)
        : [];
      const followUpMessages = Array.isArray(event.followUp)
        ? event.followUp.map(String)
        : [];
      runtime.snapshot.state.steeringMessages = steeringMessages;
      runtime.snapshot.state.followUpMessages = followUpMessages;
      runtime.snapshot.state.pendingMessageCount =
        steeringMessages.length + followUpMessages.length;
    } else if (event.type === "compaction_start" && runtime.snapshot) {
      runtime.snapshot.state.isCompacting = true;
      runtime.compactionStartedAt = Date.now();
    } else if (event.type === "compaction_end" && runtime.snapshot) {
      runtime.snapshot.state.isCompacting = false;
      await this.refreshRuntimeSnapshot(runtime);
      const result =
        event.result && typeof event.result === "object"
          ? (event.result as JsonObject)
          : undefined;
      const entry = [...runtime.snapshot.entries]
        .reverse()
        .find((item) => item.type === "compaction");
      if (entry && typeof entry.id === "string" && result) {
        const tokensBefore = Number(result.tokensBefore);
        const tokensAfter = Number(result.estimatedTokensAfter);
        if (Number.isFinite(tokensBefore) && Number.isFinite(tokensAfter)) {
          await this.store.saveCompaction(conversationId, {
            entryId: entry.id,
            timestamp:
              typeof entry.timestamp === "string"
                ? entry.timestamp
                : new Date().toISOString(),
            tokensBefore,
            tokensAfter,
            durationMs:
              runtime.compactionStartedAt === undefined
                ? undefined
                : Date.now() - runtime.compactionStartedAt,
          });
          runtime.snapshot.compactions =
            this.store.getCompactions(conversationId);
          this.applyEstimatedContextUsage(runtime, tokensAfter);
        }
      }
      runtime.compactionStartedAt = undefined;
      event.state = runtime.snapshot.state;
      event.entries = runtime.snapshot.entries;
      event.compactions = runtime.snapshot.compactions;
    } else if (event.type === "extension_error") {
      const extensionError = {
        extensionPath:
          typeof event.extensionPath === "string"
            ? event.extensionPath
            : undefined,
        event: typeof event.event === "string" ? event.event : undefined,
        error: String(event.error ?? "Extension error"),
      };
      runtime.extensionErrors.push(extensionError);
      if (runtime.snapshot)
        runtime.snapshot.extensionState.errors = [...runtime.extensionErrors];
    }
    this.getWindow()?.webContents.send("pi:event", { conversationId, event });
  }

  private queueLiveDiffRefresh(
    conversationId: string,
    runtime: RuntimeRecord,
  ): void {
    const tracker = runtime.diffTracker;
    if (!tracker) return;
    runtime.diffRefreshQueued = true;
    if (runtime.diffRefresh) return;
    runtime.diffRefresh = (async () => {
      let lastPersistedAt = 0;
      while (runtime.diffRefreshQueued) {
        runtime.diffRefreshQueued = false;
        if (runtime.diffTracker !== tracker || runtime.activeRun?.completedAt)
          return;
        const diff = await tracker.live();
        if (runtime.diffTracker !== tracker || runtime.activeRun?.completedAt)
          return;
        if (runtime.activeRun) {
          runtime.activeRun = { ...runtime.activeRun, diff };
          const now = Date.now();
          if (now - lastPersistedAt >= LIVE_DIFF_PERSIST_INTERVAL_MS) {
            lastPersistedAt = now;
            await this.store.saveConversationRun(
              conversationId,
              runtime.activeRun,
            );
          }
          if (runtime.snapshot)
            runtime.snapshot.run = structuredClone(runtime.activeRun);
        }
        this.getWindow()?.webContents.send("pi:event", {
          conversationId,
          event: {
            type: "desktop_run_diff",
            diff,
            run: runtime.activeRun,
            live: true,
          },
        });
      }
    })()
      .catch((error) => {
        console.warn("Live run diff refresh failed:", error);
      })
      .finally(() => {
        runtime.diffRefresh = undefined;
      });
  }

  private async handleRuntimeExit(
    conversationId: string,
    runtime: RuntimeRecord,
    error?: Error,
  ): Promise<void> {
    runtime.diffTracker?.close();
    runtime.diffTracker = undefined;
    const goal = this.store.getConversation(conversationId).goal;
    if (goal?.status === "active")
      await this.updateConversation(conversationId, {
        goal: {
          ...goal,
          status: "paused",
          evidence: "Процесс Pi остановлен. Продолжение — вручную.",
        },
      });
    if (runtime.activeRun && !runtime.activeRun.completedAt) {
      const completedAt = new Date().toISOString();
      runtime.activeRun = {
        ...runtime.activeRun,
        completedAt,
        durationMs:
          Date.parse(completedAt) - Date.parse(runtime.activeRun.startedAt),
      };
      await this.store.saveConversationRun(conversationId, runtime.activeRun);
    }
    await this.updateConversation(conversationId, {
      status: error ? "error" : "idle",
    });
    if (error) {
      this.getWindow()?.webContents.send("pi:event", {
        conversationId,
        event: {
          type: "runtime_error",
          error: error.message,
          run: runtime.activeRun,
        },
      });
    }
  }

  private handleExtensionUi(
    conversationId: string,
    request: ExtensionUiRequest,
  ): void {
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) return;
    const sanitizedRequest = sanitizeExtensionRequest(request);
    const ui = runtime.extensionUi;

    if (sanitizedRequest.method === "setStatus" && sanitizedRequest.statusKey) {
      if (sanitizedRequest.statusText)
        ui.statuses[sanitizedRequest.statusKey] = sanitizedRequest.statusText;
      else delete ui.statuses[sanitizedRequest.statusKey];
    } else if (sanitizedRequest.method === "setWorkingMessage") {
      ui.workingMessage = sanitizedRequest.workingText;
    } else if (sanitizedRequest.method === "setWorkingVisible") {
      ui.workingVisible = sanitizedRequest.workingVisible !== false;
    } else if (sanitizedRequest.method === "setWorkingIndicator") {
      ui.workingIndicator = sanitizedRequest.workingIndicator;
    } else if (sanitizedRequest.method === "setHiddenThinkingLabel") {
      ui.hiddenThinkingLabel = sanitizedRequest.hiddenThinkingLabel;
    } else if (
      sanitizedRequest.method === "setWidget" &&
      sanitizedRequest.widgetKey
    ) {
      ui.widgets = ui.widgets.filter(
        (widget) => widget.key !== sanitizedRequest.widgetKey,
      );
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
    } else if (
      ["select", "confirm", "input", "editor", "custom"].includes(
        sanitizedRequest.method,
      )
    ) {
      ui.pendingDialogs = [
        ...ui.pendingDialogs.filter((item) => item.id !== sanitizedRequest.id),
        sanitizedRequest,
      ];
    } else if (sanitizedRequest.method === "customClose") {
      ui.pendingDialogs = ui.pendingDialogs.filter(
        (item) => item.id !== sanitizedRequest.id,
      );
    }

    if (runtime.snapshot) runtime.snapshot.extensionUi = structuredClone(ui);
    this.getWindow()?.webContents.send("pi:extension-ui", {
      conversationId,
      request: sanitizedRequest,
    });
  }

  private async refreshState(
    _conversationId: string,
    runtime: RuntimeRecord,
  ): Promise<RuntimeState> {
    const state = preserveKnownContextUsage(
      this.normalizeState(await runtime.rpc.request<JsonObject>("get_state")),
      runtime.snapshot?.state.contextUsage,
    );
    if (runtime.snapshot) runtime.snapshot.state = state;
    return state;
  }

  private async refreshRuntimeSnapshot(runtime: RuntimeRecord): Promise<void> {
    const [stateData, messagesData, entriesData, extensionData] =
      await Promise.all([
        runtime.rpc.request<JsonObject>("get_state"),
        runtime.rpc.request<{ messages: unknown[] }>("get_messages"),
        runtime.rpc.request<{ entries: ConversationSnapshot["entries"] }>(
          "get_session_entries",
        ),
        runtime.rpc.request<Omit<ExtensionState, "errors">>(
          "get_extension_state",
        ),
      ]);
    if (!runtime.snapshot) return;
    runtime.snapshot.state = preserveKnownContextUsage(
      this.normalizeState(stateData),
      runtime.snapshot.state.contextUsage,
    );
    runtime.snapshot.messages = messagesData.messages ?? [];
    runtime.snapshot.entries = entriesData.entries ?? [];
    runtime.snapshot.compactions = this.store.getCompactions(
      runtime.snapshot.conversation.id,
    );
    runtime.snapshot.extensionState = {
      ...extensionData,
      errors: [...runtime.extensionErrors],
    };
    this.cachedExtensionState = structuredClone(
      runtime.snapshot.extensionState,
    );
    runtime.snapshot.extensionUi = structuredClone(runtime.extensionUi);
  }

  private applyEstimatedContextUsage(
    runtime: RuntimeRecord,
    tokens: number,
  ): void {
    if (!runtime.snapshot || !Number.isFinite(tokens)) return;
    const contextWindow =
      runtime.snapshot.state.contextUsage?.contextWindow ??
      runtime.snapshot.state.model?.contextWindow ??
      0;
    if (contextWindow <= 0) return;
    runtime.snapshot.state.contextUsage = {
      tokens,
      contextWindow,
      percent: (tokens / contextWindow) * 100,
    };
  }

  private snapshotWithLiveState(runtime: RuntimeRecord): ConversationSnapshot {
    const snapshot = structuredClone(runtime.snapshot!);
    snapshot.liveMessage = runtime.liveMessage
      ? structuredClone(runtime.liveMessage)
      : undefined;
    snapshot.liveTools = structuredClone(runtime.liveTools);
    return snapshot;
  }

  private normalizeState(value: JsonObject): RuntimeState {
    const model =
      value.model && typeof value.model === "object"
        ? (value.model as ModelInfo)
        : null;
    return {
      model,
      thinkingLevel:
        (value.thinkingLevel as ThinkingLevel | undefined) ?? "off",
      isStreaming: Boolean(value.isStreaming),
      isCompacting: Boolean(value.isCompacting),
      steeringMode: value.steeringMode === "all" ? "all" : "one-at-a-time",
      followUpMode: value.followUpMode === "all" ? "all" : "one-at-a-time",
      autoCompactionEnabled: value.autoCompactionEnabled !== false,
      messageCount:
        typeof value.messageCount === "number" ? value.messageCount : undefined,
      pendingMessageCount:
        typeof value.pendingMessageCount === "number"
          ? value.pendingMessageCount
          : undefined,
      steeringMessages: Array.isArray(value.steeringMessages)
        ? value.steeringMessages.map(String)
        : [],
      followUpMessages: Array.isArray(value.followUpMessages)
        ? value.followUpMessages.map(String)
        : [],
      workingVisible: value.workingVisible !== false,
      workingIndicator:
        value.workingIndicator && typeof value.workingIndicator === "object"
          ? (value.workingIndicator as RuntimeState["workingIndicator"])
          : undefined,
      hiddenThinkingLabel:
        typeof value.hiddenThinkingLabel === "string"
          ? value.hiddenThinkingLabel
          : undefined,
      sessionFile:
        typeof value.sessionFile === "string" ? value.sessionFile : undefined,
      sessionId:
        typeof value.sessionId === "string" ? value.sessionId : undefined,
      sessionName:
        typeof value.sessionName === "string" ? value.sessionName : undefined,
      contextUsage:
        value.contextUsage && typeof value.contextUsage === "object"
          ? (value.contextUsage as RuntimeState["contextUsage"])
          : undefined,
    };
  }

  private async updateConversation(
    conversationId: string,
    changes: Partial<ConversationRecord>,
  ): Promise<ConversationRecord> {
    const updated = await this.store.updateConversation(
      conversationId,
      changes,
    );
    const runtime = this.runtimes.get(conversationId);
    if (runtime?.snapshot) runtime.snapshot.conversation = updated;
    this.getWindow()?.webContents.send("desktop:conversation-changed", updated);
    return updated;
  }

  private async stopConversation(conversationId: string): Promise<void> {
    const goal = this.store
      .snapshot()
      .conversations.find((item) => item.id === conversationId)?.goal;
    if (goal?.status === "active")
      await this.updateConversation(conversationId, {
        goal: { ...goal, status: "paused" },
      });
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) return;
    this.runtimes.delete(conversationId);
    runtime.diffTracker?.close();
    runtime.diffTracker = undefined;
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
  return lines.map((line) =>
    String(line)
      .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
      .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g, "")
      .replace(/\u001B[@-_]/g, "")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
      .replace(/\s+$/g, ""),
  );
}

function sanitizeExtensionRequest(
  request: ExtensionUiRequest,
): ExtensionUiRequest {
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
