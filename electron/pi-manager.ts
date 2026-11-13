import path from "node:path";
import { storeChatAttachments } from "./chat-storage.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { applyGoalReport, goalPrompt, settleGoal } from "../shared/goal.js";
import { updatedPlan, planRequestSuffix, canContinuePlan } from "../shared/plan.js";
import { confirmedPlanRevision } from "../shared/plan-activity.js";
import { approvedPlanning, completePlanning, controlPlanningState, isPlanning, planningToolAllowed, revisePlanning } from "../shared/planning.js";
import { canResumeRun } from "../shared/run-state.js";
import { selectConfiguredModel } from "../shared/model-selection.js";
import { notebookUsage, updatedNotebook } from "../shared/notebook.js";
import { StatePersistenceError } from "./atomic-state.js";
import type { SkillsStore } from "./skills-store.js";
import type { SkillsCommand } from "../shared/skills.js";
import { imageAttachmentPrompt, historyImageAttachments } from "../shared/image-attachments.js";
import { sessionHistoryTargets, selectHistoryTarget } from "../shared/session-history.js";
import { applyMessagePatch, type MessagePatch } from "../shared/message-sync.js";
import { historyWorkState } from "../shared/history-work-state.js";
import { app, BrowserWindow, shell } from "electron";
import { existsSync } from "node:fs";
import type {
  Attachment,
  CompactionRecord,
  ConversationRun,
  ConversationGoal,
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
import { getSessionManager } from "./pi-sdk.js";
import { readSessionPreview, stopSessionReads } from "./session-read.js";
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
  messageIds?: string[];
  goalProgressAtStart?: string;
  goalTurnStartedAt?: number;
  goalTurnId?: string;
  rpc: PiRpcProcess;
  snapshot?: ConversationSnapshot;
  diffTracker?: RunDiffTracker;
  diffRefresh?: Promise<void>;
  diffRefreshQueued?: boolean;
  extensionUi: ExtensionUiState;
  extensionErrors: ExtensionState["errors"];
  eventQueue: Promise<void>;
  activeRun?: ConversationRun;
  runStopReason?: string;
  runError?: string;
  runAborted?: boolean;
  compactionStartedAt?: number;
  liveMessage?: JsonObject;
  liveTools: Record<string, LiveToolActivity>;
  planWorkingRevision?: number;
  pendingPlanStartRevision?: number;
  pendingInstructionsRevision?: number;
  modelsRevision?: string;
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
  private readonly planningTransitions = new Set<string>();
  private readonly planningWrites = new Set<string>();
  private readonly historyMutations = new Set<string>();
  private readonly resumingRuns = new Set<string>();
  private readonly goalLaunching = new Set<string>();
  private readonly goalContinuationRequested = new Set<string>();
  private readonly runtimes = new Map<string, RuntimeRecord>();
  private readonly skillStores = new Map<string, SkillsStore>();
  private readonly startingRuntimes = new Map<string, Promise<ConversationSnapshot>>();
  private readonly startupEpochs = new Map<string, number>();
  private openingPreview?: AbortController;
  private instructionsRevision = 0;
  private modelCatalogSync: Promise<void> = Promise.resolve();
  private cachedCommands: ConversationSnapshot["commands"] =
    structuredClone(BUILTIN_COMMANDS);
  private cachedExtensionState: ExtensionState = createEmptyExtensionState();

  constructor(
    private readonly store: DataStore,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly onConversationSettled?: (
      conversation: ConversationRecord,
    ) => void,
    private readonly onPublishedEvent?: (channel: string, payload: unknown) => void,
    private readonly remoteRuntime?: (conversation: ConversationRecord) => Promise<{ extensions: string[]; environment: Record<string, string> }>,
    private readonly browserRequest?: (conversationId: string, params: JsonObject) => Promise<unknown>,
    private readonly cancelBrowserRequests?: (conversationId: string) => void,
  ) {}

  private publish(channel: string, payload: unknown): void {
    this.getWindow()?.webContents.send(channel, payload);
    this.onPublishedEvent?.(channel, payload);
  }

  async createConversation(projectId?: string): Promise<ConversationSnapshot> {
    this.openingPreview?.abort();
    const conversation = await this.store.createConversation(projectId);
    return this.previewConversation(conversation);
  }

  async getModelServers(force = false) {
    await this.store.refreshModelServers(force);
    await this.modelConfigurationChanged();
    return this.store.getModelServers();
  }

  async modelConfigurationChanged(): Promise<void> {
    const sync = this.modelCatalogSync.then(async () => {
      const configuration = await this.store.getAgentConfiguration();
      for (const [id, runtime] of this.runtimes) {
        if (!runtime.snapshot || runtime.snapshot.state.isStreaming || runtime.snapshot.state.isCompacting
          || (runtime.activeRun && !runtime.activeRun.completedAt) || runtime.modelsRevision === configuration.revision) continue;
        const conversation = this.store.getConversation(id);
        const selected = selectConfiguredModel(configuration.models, conversation.provider, conversation.model,
          configuration.defaultProvider, configuration.defaultModel);
        const result = await runtime.rpc.request<{ models: ModelInfo[]; thinkingLevels: ThinkingLevel[] }>("desktop_refresh_models", {
          provider: selected?.provider, modelId: selected?.id,
        });
        const state = await this.refreshState(id, runtime);
        runtime.snapshot.models = result.models;
        runtime.snapshot.thinkingLevels = result.thinkingLevels;
        runtime.modelsRevision = configuration.revision;
        if (state.model) await this.updateConversation(id, { provider: state.model.provider, model: state.model.id, thinkingLevel: state.thinkingLevel });
        this.publish("pi:event", { conversationId: id, event: { type: "desktop_models_update", models: result.models, state,
          thinkingLevels: runtime.snapshot.thinkingLevels } });
      }
      const activeId = this.store.snapshot().activeConversationId;
      if (activeId && !this.runtimes.has(activeId)) {
        const conversation = this.store.getConversation(activeId);
        const model = selectConfiguredModel(configuration.models, conversation.provider, conversation.model,
          configuration.defaultProvider, configuration.defaultModel);
        const thinkingLevels = model?.thinkingLevels ?? ["off"];
        const requestedLevel = conversation.thinkingLevel ?? configuration.defaultThinkingLevel;
        const thinkingLevel = thinkingLevels.includes(requestedLevel) ? requestedLevel : thinkingLevels[0];
        this.publish("pi:event", { conversationId: activeId, event: { type: "desktop_models_update", models: configuration.models,
          model, thinkingLevels, thinkingLevel } });
      }
    });
    this.modelCatalogSync = sync.catch(() => undefined);
    await sync;
  }

  async inspectConversation(conversationId: string): Promise<ConversationSnapshot> {
    const runtime = this.runtimes.get(conversationId);
    return runtime?.snapshot
      ? this.snapshotWithLiveState(runtime)
      : this.previewConversation(this.store.getConversation(conversationId));
  }

  hasActiveWork(): boolean {
    return this.startingRuntimes.size > 0 || [...this.runtimes.values()].some(runtime => Boolean(runtime.snapshot?.state.isStreaming || (runtime.activeRun && !runtime.activeRun.completedAt)));
  }

  async openConversation(
    conversationId: string,
  ): Promise<ConversationSnapshot> {
    this.openingPreview?.abort();
    const controller = new AbortController();
    this.openingPreview = controller;
    await this.store.activateConversation(conversationId);
    controller.signal.throwIfAborted();
    const running = this.runtimes.get(conversationId);
    if (running?.snapshot) {
      if (running.snapshot.state.isStreaming)
        await this.refreshRuntimeSnapshot(running);
      running.snapshot.queuedPrompts =
        this.store.getQueuedPrompts(conversationId);
      return this.snapshotWithLiveState(running);
    }
    return this.previewConversation(this.store.getConversation(conversationId), controller.signal);
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.stopConversation(conversationId);
    const conversation = this.store.getConversation(conversationId);
    const chatDir = this.store.getConversationChatDirectory(conversation);
    if (conversation.sessionFile && existsSync(conversation.sessionFile)
      && !path.resolve(conversation.sessionFile).startsWith(path.resolve(chatDir) + path.sep)) {
      await shell.trashItem(
        this.store.assertManagedSessionFile(conversation.sessionFile),
      );
    }
    // Every chat owns its data folder, never the user's external project directory.
    for (const directory of this.store.getConversationDataDirectories(conversation))
      if (existsSync(directory)) await shell.trashItem(directory);
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
    behavior?: "steer" | "followUp" | "resume",
    expectedGoalId?: string,
    historyEdit = false,
    requestPlan = false,
    expectedPlanRevision?: number,
    resumeBeforeQueue = false,
  ): Promise<void> {
    if (typeof message !== "string" || (!message.trim() && !attachments.length))
      throw new Error("Сообщение не может быть пустым.");
    this.store.getConversation(conversationId);
    if (attachments.length) attachments = await storeChatAttachments(this.store.dataDir, conversationId, attachments);
    if (this.planningTransitions.has(conversationId)) throw new Error("Дождитесь переключения режима.");
    if (requestPlan && !isPlanning(this.store.getConversation(conversationId).planning)) {
      await this.controlPlanning(conversationId, "start", this.store.getConversation(conversationId).planning?.revision ?? 0);
    }
    if (isPlanning(this.store.getConversation(conversationId).planning) && (expectedGoalId || expectedPlanRevision !== undefined)) return;
    if (this.store.getConversation(conversationId).planning?.phase === "review") {
      const current = this.store.getConversation(conversationId).planning!;
      await this.updateConversation(conversationId, { planning: controlPlanningState("revise", current.revision, current) });
    }
    if (this.historyMutations.has(conversationId) && !historyEdit)
      throw new Error("Дождитесь завершения изменения истории.");
    if (
      expectedGoalId &&
      (this.store.getConversation(conversationId).goal?.id !== expectedGoalId ||
        this.store.getConversation(conversationId).goal?.status !== "active" ||
        this.runtimes.get(conversationId)?.snapshot?.state.isStreaming ||
        (!resumeBeforeQueue && this.store.getQueuedPrompts(conversationId).length > 0))
    )
      return;
    if (!this.runtimes.get(conversationId)?.snapshot?.state.isStreaming) {
      const epoch = this.startupEpochs.get(conversationId) ?? 0;
      await this.getModelServers(true);
      if ((this.startupEpochs.get(conversationId) ?? 0) !== epoch) throw new Error("Отправка отменена пользователем.");
    }
    const runtime = await this.ensureRuntime(conversationId);
    if (runtime.snapshot?.state.model === null) throw new Error("Выберите доступную модель: прежняя модель или API-подключение больше не доступны.");
    if (isPlanning(this.store.getConversation(conversationId).planning)
      && !runtime.snapshot?.extensionState.activeTools.includes("update_implementation_plan"))
      throw new Error("Защита режима «План» не загрузилась. Работа запрещена; проверьте ошибки расширений.");
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
        "get_goal",
      )
    )
      throw new Error(
        "Инструмент цели не загрузился. Проверьте ошибки модулей Pi.",
      );
    if (runtime.snapshot) {
      this.publish("pi:event", {
        conversationId,
        event: {
          type: "desktop_state",
          state: structuredClone(runtime.snapshot.state),
          commands: structuredClone(runtime.snapshot.commands),
        },
      });
    }
    const conversation = this.store.getConversation(conversationId);
    if (expectedPlanRevision !== undefined && (conversation.plan?.revision !== expectedPlanRevision || !canContinuePlan(conversation.plan, approvedPlanning(conversation.planning) ? undefined : conversation.goal)
      || runtime.snapshot?.state.isStreaming || (!resumeBeforeQueue && this.store.getQueuedPrompts(conversationId).length))) return;
    if (
      !runtime.snapshot?.state.isStreaming &&
      (!runtime.activeRun || runtime.activeRun.completedAt)
    ) {
      runtime.activeRun = { startedAt: new Date().toISOString() };
      runtime.runStopReason = undefined;
      runtime.runError = undefined;
      runtime.runAborted = false;
      runtime.diffRefresh = undefined;
      runtime.diffRefreshQueued = false;
      if (runtime.snapshot)
        runtime.snapshot.run = structuredClone(runtime.activeRun);
      await this.store.saveConversationRun(conversationId, runtime.activeRun);
      this.publish("pi:event", {
        conversationId,
        event: {
          type: "desktop_run_started",
          run: runtime.activeRun,
          // The renderer must know whether this new run is the scheduled
          // continuation of the active checklist before agent_start arrives.
          // Ordinary user turns stay unconfirmed and cannot animate a restored
          // checklist merely because the model is loading.
          planWorkingRevision:
            expectedPlanRevision !== undefined &&
            conversation.plan?.revision === expectedPlanRevision
              ? expectedPlanRevision
              : undefined,
        },
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
        virtualFilesystem: Boolean(this.remoteRuntime),
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
    if (requestPlan && !isPlanning(conversation.planning)) preparedMessage += planRequestSuffix;
    const images = imageAttachments.map((item) => ({
      type: "image",
      data: item.data,
      mimeType: item.mimeType,
    }));
    const goal = this.store.getConversation(conversationId).goal;
    const isGoalContinuation = Boolean(expectedGoalId && goal && goal.steps > 0);
    if (
      expectedGoalId &&
      (goal?.id !== expectedGoalId || goal.status !== "active")
    )
      return;
    if (!runtime.snapshot?.state.isStreaming) {
      runtime.goalTurnStartedAt = goal?.status === "active" ? Date.now() : undefined;
      runtime.goalTurnId = goal?.status === "active" ? goal.id : undefined;
    }
    if (goal?.status === "active" && expectedGoalId) {
      const next = !runtime.snapshot?.state.isStreaming
        ? { ...goal, steps: goal.steps + 1 }
        : goal;
      runtime.goalProgressAtStart = goal.progress;
      await this.updateConversation(conversationId, { goal: next });
      preparedMessage += `\n\n${goalPrompt(next)}`;
    }
    const payload = {
      message: preparedMessage,
      ...(images.length ? { images } : {}),
    };
    try {
      if (runtime.runAborted) throw new Error("Отправка отменена пользователем.");
      if (this.runtimes.get(conversationId) !== runtime || this.planningTransitions.has(conversationId))
        throw new Error("Режим или процесс чата изменился. Повторите отправку после переключения.");
      if (conversation.title === "Новый чат" && !runtime.snapshot?.messages.some(item => (item as JsonObject)?.role === "user")
        && !isGoalContinuation && expectedPlanRevision === undefined && behavior !== "resume") {
        await this.nameConversation(conversationId, runtime, message || `Вложения: ${attachments.map(item => item.name).join(", ")}`);
      }
      if (runtime.runAborted) throw new Error("Отправка отменена пользователем.");
      if (this.runtimes.get(conversationId) !== runtime || this.planningTransitions.has(conversationId))
        throw new Error("Режим или процесс чата изменился. Повторите отправку после переключения.");
      if (expectedGoalId) {
        const current = this.store.getConversation(conversationId).goal;
        if (current?.id !== expectedGoalId || current.status !== "active")
          throw new Error("Запуск цели отменён.");
        if (runtime.snapshot?.state.isStreaming || (!resumeBeforeQueue && this.store.getQueuedPrompts(conversationId).length > 0)) return;
      }
      if (expectedPlanRevision !== undefined) {
        const current = this.store.getConversation(conversationId);
        if (current.plan?.revision !== expectedPlanRevision || !canContinuePlan(current.plan, approvedPlanning(current.planning) ? undefined : current.goal)
          || runtime.snapshot?.state.isStreaming || (!resumeBeforeQueue && this.store.getQueuedPrompts(conversationId).length)) return;
        runtime.pendingPlanStartRevision = expectedPlanRevision;
        try {
          await runtime.rpc.request("desktop_plan_continue", { message: `<pi_desktop_service_context source="plan">Continue the next unfinished step of the current authorized checklist. If user input or approval is needed, set execution=paused, explain the reason and ask.</pi_desktop_service_context>`, });
        } catch (error) {
          runtime.pendingPlanStartRevision = undefined;
          throw error;
        }
      }
      else if (isGoalContinuation) await runtime.rpc.request("desktop_goal_continue", {
        message: `<pi_desktop_service_context source="goal">Continue authorized work on the current goal. Call get_goal first; historical directives may be obsolete.</pi_desktop_service_context>`, goalId: expectedGoalId,
      });
      else if (behavior === "resume") {
        if (runtime.runAborted) throw new Error("Продолжение отменено пользователем.");
        runtime.pendingPlanStartRevision = conversation.plan?.execution === "active" ? conversation.plan.revision : undefined;
        await runtime.rpc.request("desktop_run_resume");
      }
      else if (behavior === "steer") await runtime.rpc.request("steer", payload);
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
          error: runtime.runAborted ? undefined : error instanceof Error ? error.message : String(error),
        };
        await this.store.saveConversationRun(conversationId, runtime.activeRun);
        if (runtime.snapshot) runtime.snapshot.run = structuredClone(runtime.activeRun);
        this.publish("pi:event", { conversationId, event: { type: "desktop_run_state", stopped: true, run: runtime.activeRun } });
      }
      throw error;
    }
  }

  private async nameConversation(conversationId: string, runtime: RuntimeRecord, message: string): Promise<void> {
    runtime.extensionUi.workingMessage = "Модель выбирает название чата…";
    this.publish("pi:event", { conversationId, event: { type: "desktop_chat_naming", active: true } });
    try {
      const result = await runtime.rpc.request<{ title: string }>("desktop_generate_chat_title", { message }, 125_000);
      if (runtime.runAborted || this.runtimes.get(conversationId) !== runtime || this.planningTransitions.has(conversationId))
        throw new Error("Отправка отменена или режим чата изменился.");
      // A manual rename while generation is in flight takes precedence.
      if (this.store.getConversation(conversationId).title !== "Новый чат") return;
      await runtime.rpc.request("set_session_name", { name: result.title });
      await this.updateConversation(conversationId, { title: result.title });
    } finally {
      runtime.extensionUi.workingMessage = "";
      this.publish("pi:event", { conversationId, event: { type: "desktop_chat_naming", active: false } });
    }
  }

  async queuePrompt(
    conversationId: string,
    message: string,
    attachments: Attachment[],
    requestPlan = false,
  ): Promise<QueuedPrompt[]> {
    if (typeof message !== "string" || (!message.trim() && !attachments.length))
      throw new Error("Сообщение не может быть пустым.");
    this.store.getConversation(conversationId);
    if (attachments.length) attachments = await storeChatAttachments(this.store.dataDir, conversationId, attachments);
    const queued = await this.store.queuePrompt(
      conversationId,
      message,
      attachments,
      requestPlan,
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
      undefined,
      false,
      prompt.requestPlan === true,
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
    this.invalidateStartup(conversationId);
    this.cancelBrowserRequests?.(conversationId);
    const conversation = this.store.getConversation(conversationId);
    const changes: Partial<ConversationRecord> = {};
    if (conversation.plan?.execution === "active") changes.plan = updatedPlan({ execution: "paused" }, conversation.plan);
    if (conversation.goal?.status === "active") changes.goal = { ...conversation.goal, status: "paused", updatedAt: new Date().toISOString() };
    // Block scheduling and stale writes synchronously; disk I/O must never gate abort.
    Object.assign(conversation, changes);
    this.goalContinuationRequested.delete(conversationId);
    const runtime = this.runtimes.get(conversationId);
    if (runtime) runtime.runAborted = true;
    if (runtime?.activeRun && !runtime.activeRun.completedAt) {
      runtime.activeRun = { ...runtime.activeRun, interruption: {
        ...runtime.activeRun.interruption,
        ...(changes.plan ? { planRevision: changes.plan.revision } : {}),
        ...(changes.goal ? { goalId: changes.goal.id } : {}),
      } };
      if (runtime.snapshot) runtime.snapshot.run = structuredClone(runtime.activeRun);
    }
    const cancellation = runtime ? runtime.rpc.request("abort") : Promise.resolve();
    const persistence = Object.keys(changes).length ? this.updateConversation(conversationId, changes) : Promise.resolve();
    const runPersistence = runtime?.activeRun?.interruption ? this.store.saveConversationRun(conversationId, runtime.activeRun) : Promise.resolve();
    await Promise.all([cancellation, persistence, runPersistence]);
  }

  async resumeConversation(conversationId: string): Promise<void> {
    if (this.resumingRuns.has(conversationId)) return;
    this.resumingRuns.add(conversationId);
    let previousRun: ConversationRun | undefined;
    let resumedPlanRevision: number | undefined;
    let resumedGoalId: string | undefined;
    try {
      // Settlement persists the outcome and pauses state before resume can read it.
      await this.runtimes.get(conversationId)?.eventQueue;
      const snapshot = await this.inspectConversation(conversationId);
      if (snapshot.state.isStreaming || snapshot.state.isCompacting)
        throw new Error("Дождитесь остановки текущего прогона.");
      if (!canResumeRun(snapshot.run)) throw new Error("Нет прерванной работы для продолжения.");
      previousRun = snapshot.run;
      const conversation = this.store.getConversation(conversationId);
      const changes: Partial<ConversationRecord> = {};
      // Restore only the state paused by this interruption, never unrelated
      // manually paused work or a checklist edited after the interruption.
      if (!isPlanning(conversation.planning) && previousRun?.interruption?.planRevision === conversation.plan?.revision && conversation.plan?.execution === "paused") {
        changes.plan = updatedPlan({ execution: "active", explanation: "" }, conversation.plan);
        resumedPlanRevision = changes.plan.revision;
      }
      if (!isPlanning(conversation.planning) && previousRun?.interruption?.goalId === conversation.goal?.id && conversation.goal?.status === "paused") {
        changes.goal = { ...conversation.goal, status: "active", stalledSteps: 0, updatedAt: new Date().toISOString() };
        resumedGoalId = changes.goal.id;
      }
      if (Object.keys(changes).length) await this.updateConversation(conversationId, changes);
      await this.sendPrompt(conversationId, "Продолжить прерванную работу.", [], "resume");
    } catch (error) {
      const runtime = this.runtimes.get(conversationId);
      if (previousRun && !runtime?.snapshot?.state.isStreaming) {
        const conversation = this.store.getConversation(conversationId);
        const changes: Partial<ConversationRecord> = {};
        const interruption = { ...previousRun.interruption, ...runtime?.activeRun?.interruption };
        if (resumedPlanRevision !== undefined && conversation.plan?.revision === resumedPlanRevision) {
          changes.plan = updatedPlan({ execution: "paused" }, conversation.plan);
          interruption.planRevision = changes.plan.revision;
        }
        if (resumedGoalId && conversation.goal?.id === resumedGoalId && conversation.goal.status === "active")
          changes.goal = { ...conversation.goal, status: "paused", updatedAt: new Date().toISOString() };
        if (Object.keys(changes).length) await this.updateConversation(conversationId, changes);
        const restored = { ...previousRun, interruption };
        if (runtime) {
          runtime.activeRun = restored;
          runtime.pendingPlanStartRevision = undefined;
          if (runtime.snapshot) runtime.snapshot.run = structuredClone(restored);
        }
        await this.store.saveConversationRun(conversationId, restored);
        this.publish("pi:event", { conversationId, event: { type: "desktop_run_state", run: restored } });
      }
      throw error;
    } finally {
      this.resumingRuns.delete(conversationId);
    }
  }

  async setGoal(
    conversationId: string,
    objective: string,
    attachments: Attachment[],
    requestPlan = false,
  ): Promise<void> {
    if (requestPlan || isPlanning(this.store.getConversation(conversationId).planning)) {
      await this.sendPrompt(conversationId, objective, attachments, undefined, undefined, false, true);
      return;
    }
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
    const previousPlanning = this.store.getConversation(conversationId).planning;
    if (approvedPlanning(previousPlanning)) await this.updateConversation(conversationId, { planning: controlPlanningState("cancel", previousPlanning!.revision, previousPlanning) });
    await this.updateConversation(conversationId, {
      goal: {
        id: randomUUID(),
        objective: objective.trim(),
        criteria: "",
        maxSteps: 0,
        status: "active",
        progress: "",
        evidence: "",
        steps: 0,
        stalledSteps: 0,
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(), tokensUsed: 0,
      },
    });
    this.launchGoal(conversationId, attachments, requestPlan);
  }

  async controlGoal(
    conversationId: string,
    action: "pause" | "resume" | "remove",
  ): Promise<void> {
    if (action === "resume" && isPlanning(this.store.getConversation(conversationId).planning)) throw new Error("Сначала согласуйте план реализации.");
    if (!["pause", "resume", "remove"].includes(action))
      throw new Error("Неизвестное действие цели");
    const goal = this.store.getConversation(conversationId).goal;
    if (!goal) return;
    const previousPlanning = this.store.getConversation(conversationId).planning;
    if (action === "resume" && approvedPlanning(previousPlanning))
      await this.updateConversation(conversationId, { planning: controlPlanningState("cancel", previousPlanning!.revision, previousPlanning) });
    if (action !== "resume") {
      const plan = this.store.getConversation(conversationId).plan;
      if (plan?.execution === "active") await this.updateConversation(conversationId, { plan: updatedPlan({ execution: "paused" }, plan) });
      // Goal scheduling and the current response are independent. Let the
      // in-flight turn finish; only the chat's Stop button sends RPC abort.
      this.goalContinuationRequested.delete(conversationId);
      await this.updateConversation(conversationId, {
        goal: action === "remove"
          ? undefined
          : { ...goal, status: goal.status === "complete" || goal.status === "budget_limited" ? goal.status : "paused", updatedAt: new Date().toISOString() },
      });
      return;
    }
    if (goal.status === "complete")
      throw new Error("Цель уже выполнена. Создайте новую цель.");
    if (goal.status === "active") return;
    await this.updateConversation(conversationId, {
      goal: {
        ...goal,
        status: "active",
        ...(goal.status === "budget_limited" ? { tokenBudget: undefined } : {}),
        stalledSteps: 0,
        maxSteps: 0,
        updatedAt: new Date().toISOString(),
      },
    });
    // Resume scheduling immediately, without injecting a second prompt into
    // an in-flight response. The settled handler starts the next stage.
    if (this.goalLaunching.has(conversationId))
      this.goalContinuationRequested.add(conversationId);
    else if (
      this.store.getConversation(conversationId).status === "idle" &&
      !this.runtimes.get(conversationId)?.snapshot?.state.isStreaming
    )
      this.launchGoal(conversationId, [], false, true);
  }

  async controlPlanning(conversationId: string, action: "start" | "revise" | "approve" | "cancel", expectedRevision: number): Promise<void> {
    if (this.planningTransitions.has(conversationId) || this.planningWrites.has(conversationId)) throw new Error("Дождитесь сохранения или переключения плана.");
    this.planningTransitions.add(conversationId);
    let implement = false;
    try {
      await this.runtimes.get(conversationId)?.eventQueue;
      const conversation = this.store.getConversation(conversationId);
      const runtime = this.runtimes.get(conversationId);
      if (this.startingRuntimes.has(conversationId) || runtime?.snapshot?.state.isStreaming || runtime?.snapshot?.state.isCompacting || conversation.status === "starting")
        throw new Error("Сначала остановите текущую работу, затем переключите режим.");
      if (action === "approve" && this.store.getQueuedPrompts(conversationId).length)
        throw new Error("В очереди есть сообщения. Обработайте или удалите уточнения перед согласованием.");
      const planning = controlPlanningState(action, expectedRevision, conversation.planning);
      // Pi plan-mode is a live permission change, not a new runtime or tool loadout.
      this.goalContinuationRequested.delete(conversationId);
      const changes: Partial<ConversationRecord> = { planning, status: "idle" };
      if (conversation.goal?.status === "active") changes.goal = { ...conversation.goal, status: "paused", updatedAt: new Date().toISOString() };
      if (conversation.plan?.execution === "active") changes.plan = updatedPlan({ execution: "paused" }, conversation.plan);
      if (action === "approve" && conversation.plan) changes.plan = updatedPlan({ plan: [], execution: "paused" }, conversation.plan);
      await this.updateConversation(conversationId, changes);
      implement = action === "approve";
    } finally { this.planningTransitions.delete(conversationId); }
    if (implement) await this.sendPrompt(conversationId, "Реализуй согласованный план. Используй документ плана как основу, а рабочий чеклист — для отслеживания выполнения.", []);
  }

  async controlPlan(conversationId: string, action: "pause" | "resume"): Promise<void> {
    if (action !== "pause" && action !== "resume") throw new Error("Неизвестное действие чеклиста.");
    const conversation = this.store.getConversation(conversationId);
    if (action === "resume" && isPlanning(conversation.planning)) throw new Error("Сначала согласуйте план реализации.");
    const current = conversation.plan;
    if (!current?.steps.length) throw new Error("Чеклист не задан.");
    if (action === "resume") {
      if (current.steps.every(step => step.status === "completed")) throw new Error("Чеклист уже выполнен.");
      const goal = conversation.goal;
      if (!approvedPlanning(conversation.planning) && goal && !["active", "complete"].includes(goal.status))
        throw new Error("Сначала возобновите цель или уберите её. Чеклист не может обходить остановленную цель.");
    }
    const plan = updatedPlan({ execution: action === "resume" ? "active" : "paused", explanation: "" }, current);
    await this.updateConversation(conversationId, { plan });
    const runtime = this.runtimes.get(conversationId);
    if (runtime && this.store.getConversation(conversationId).plan?.revision === plan.revision) {
      // Manual resume confirms the current live run too; no new agent_start
      // occurs when the user enables continuation during an existing response.
      runtime.planWorkingRevision = confirmedPlanRevision({ execution: plan.execution }, plan,
        Boolean(runtime.snapshot?.state.isStreaming && !runtime.snapshot.state.isCompacting));
      if (runtime.snapshot) runtime.snapshot.planWorkingRevision = runtime.planWorkingRevision;
      this.publish("pi:event", { conversationId, event: { type: "desktop_plan_activity", revision: runtime.planWorkingRevision } });
    }
    if (action === "pause") {
      this.goalContinuationRequested.delete(conversationId);
      return;
    }
    // Like goal resume: schedule the next run, never inject a second prompt
    // into an already streaming response or interrupt it.
    if (this.goalLaunching.has(conversationId)) this.goalContinuationRequested.add(conversationId);
    else this.launchGoal(conversationId, [], false, true);
  }

  async removePlan(conversationId: string): Promise<void> {
    const current = this.store.getConversation(conversationId).plan;
    if (!current?.steps.length) return;
    // Keep a revision tombstone: an in-flight model update must not resurrect
    // the checklist cleared by the user. Goal and response are untouched.
    await this.updateConversation(conversationId, { plan: updatedPlan({ plan: [] }, current) });
  }

  async saveNotebook(conversationId: string, content: unknown, expectedRevision: unknown, mutation?: JsonObject) {
    const current = this.store.getConversation(conversationId).notebook;
    const notebook = updatedNotebook({ ...(mutation ?? { content }), expectedRevision }, current, this.store.getNotebookCharacterLimit());
    if (notebook !== current) await this.updateConversation(conversationId, { notebook });
    return notebook;
  }

  async manageSkills(conversationId: string, command: SkillsCommand) {
    const conversation = this.store.getConversation(conversationId);
    if (this.remoteRuntime) throw new Error("Управление навыками удалённого исполнителя пока недоступно.");
    const cwd = await this.store.getConversationWorkingDirectory(conversation);
    let skills = this.skillStores.get(cwd);
    if (!skills) {
      const { SkillsStore } = await import("./skills-store.js");
      skills = new SkillsStore({ cwd, agentDir: this.store.agentDir, appRoot: app.getAppPath(), project: Boolean(conversation.projectId) });
      this.skillStores.set(cwd, skills);
    }
    return skills.command(command);
  }

  private async handleGoalRequest(conversationId: string, request: JsonObject): Promise<unknown> {
    const planning = this.store.getConversation(conversationId).planning;
    if (request.action === "update_implementation_plan") {
      const params = request.params as JsonObject | undefined;
      if (!params || Object.keys(params).length === 0) return { planning: planning ?? null };
      if (this.runtimes.get(conversationId)?.runAborted) throw new Error("Изменение плана отменено пользователем.");
      if (this.planningWrites.has(conversationId)) throw new Error("Дождитесь предыдущего сохранения плана и прочитайте актуальную версию.");
      this.planningWrites.add(conversationId);
      try {
        const conversation = this.store.getConversation(conversationId);
        const next = params.complete !== undefined ? completePlanning(params, conversation.planning, conversation.plan) : revisePlanning(params, conversation.planning);
        await this.updateConversation(conversationId, { planning: next });
        return { planning: next };
      } finally { this.planningWrites.delete(conversationId); }
    }
    if (isPlanning(planning)) {
      const tool = request.action === "update_notebook" ? "update_notebook" : String(request.action);
      if (!planningToolAllowed(tool, request.params as JsonObject ?? {})) throw new Error("Режим «План»: изменяющие действия запрещены до согласования.");
    }
    if (request.action === "manage_skills") return this.manageSkills(conversationId, request.params as SkillsCommand);
    if (request.action === "update_notebook") {
      const params = request.params as JsonObject | undefined;
      const reading = !params || ["content", "append", "old_text", "new_text"].every(key => params[key] === undefined);
      const notebook = reading ? this.store.getConversation(conversationId).notebook ?? null
        : await this.saveNotebook(conversationId, params!.content, params!.expectedRevision, params!);
      return { notebook, usage: notebookUsage(notebook ?? undefined, this.store.getNotebookCharacterLimit()) };
    }
    if (request.action === "browser") {
      this.store.getConversation(conversationId);
      if (!this.browserRequest) throw new Error("Встроенный браузер недоступен.");
      const params = request.params as JsonObject | undefined;
      if (!params || typeof params !== "object") throw new Error("Нужны параметры действия браузера.");
      return this.browserRequest(conversationId, params);
    }
    if (request.action === "update_plan") {
      const current = this.store.getConversation(conversationId).plan;
      const params = request.params as JsonObject | undefined;
      if (params?.plan === undefined && params?.execution === undefined && params?.explanation === undefined && params?.mark === undefined && params?.status === undefined) return { plan: current ?? null };
      const plan = updatedPlan(params!, current);
      await this.updateConversation(conversationId, { plan });
      const runtime = this.runtimes.get(conversationId);
      if (runtime) {
        const alreadyWorking = current !== undefined && runtime.planWorkingRevision === current.revision;
        runtime.planWorkingRevision = confirmedPlanRevision(alreadyWorking ? { ...params!, execution: plan.execution } : params!, plan, Boolean(runtime.snapshot?.state.isStreaming));
        if (runtime.snapshot) runtime.snapshot.planWorkingRevision = runtime.planWorkingRevision;
        this.publish("pi:event", { conversationId, event: { type: "desktop_plan_activity", revision: runtime.planWorkingRevision } });
      }
      return { plan };
    }
    const current = this.store.getConversation(conversationId).goal;
    const result = () => {
      const goal = this.store.getConversation(conversationId).goal;
      return { goal: goal ?? null, remainingTokens: goal?.tokenBudget === undefined ? null : Math.max(0, goal.tokenBudget - (goal.tokensUsed ?? 0)) };
    };
    if (request.action === "get_goal") return result();
    const params = request.params as JsonObject | undefined;
    if (request.action === "create_goal") {
      if (current && current.status !== "complete") throw new Error("An unfinished goal already exists.");
      const objective = params?.objective;
      if (typeof objective !== "string" || !objective.trim() || objective.length > 8000) throw new Error("Invalid goal objective.");
      if (params?.token_budget !== undefined && (!Number.isSafeInteger(params.token_budget) || Number(params.token_budget) <= 0)) throw new Error("Invalid token budget.");
      await this.updateConversation(conversationId, { goal: {
        id: randomUUID(), objective: objective.trim(), criteria: "", status: "active", progress: "", evidence: "",
        steps: 0, maxSteps: 0, stalledSteps: 0, updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(), tokensUsed: 0, tokenBudget: params?.token_budget as number | undefined,
      } });
    } else if (request.action === "update_goal") {
      if (!current) throw new Error("No goal exists.");
      if (params?.goalId !== current.id) throw new Error("Goal changed while this request was pending. Read get_goal again.");
      if (!["paused", "blocked", "complete"].includes(String(params?.status))) throw new Error("Invalid goal status.");
      if (current.status === "complete") throw new Error("Goal is already complete.");
      if (current.status === "budget_limited") throw new Error("Budget limit takes precedence. Resume is user-controlled.");
      if (params!.status !== "paused" && current.status !== "active") throw new Error("Goal is inactive. Resume is user-controlled.");
      this.goalContinuationRequested.delete(conversationId);
      await this.updateConversation(conversationId, { goal: { ...current, status: params!.status as ConversationGoal["status"], updatedAt: new Date().toISOString() } });
    } else throw new Error("Unknown goal action.");
    if (request.action === "create_goal") {
      const runtime = this.runtimes.get(conversationId);
      if (runtime) { runtime.goalTurnId = this.store.getConversation(conversationId).goal?.id; runtime.goalTurnStartedAt = Date.now(); }
    }
    return result();
  }

  async editGoal(conversationId: string, objective: string): Promise<void> {
    if (typeof objective !== "string" || !objective.trim() || objective.length > 8000)
      throw new Error("Опишите цель: от 1 до 8000 символов.");
    const goal = this.store.getConversation(conversationId).goal;
    if (!goal) throw new Error("Цель уже удалена.");
    if (objective.trim() === goal.objective) return;
    // A new identity prevents reports from the in-flight old stage from
    // completing or overwriting the edited objective. Do not abort that stage.
    const next = {
      ...goal, id: randomUUID(), objective: objective.trim(), criteria: "",
      status: goal.status === "active" ? "active" as const : "paused" as const,
      progress: "", evidence: "", steps: 0, stalledSteps: 0,
      updatedAt: new Date().toISOString(),
    };
    await this.updateConversation(conversationId, { goal: next });
    if (next.status === "active") {
      if (this.goalLaunching.has(conversationId))
        this.goalContinuationRequested.add(conversationId);
      else if (this.store.getConversation(conversationId).status === "idle")
        this.launchGoal(conversationId);
    }
  }

  private launchGoal(
    conversationId: string,
    attachments: Attachment[] = [],
    requestPlan = false,
    resumeBeforeQueue = false,
  ): void {
    if (isPlanning(this.store.getConversation(conversationId).planning) || this.planningTransitions.has(conversationId)) return;
    if (this.goalLaunching.has(conversationId)) return;
    if (this.store.getConversation(conversationId).status !== "idle" ||
      this.runtimes.get(conversationId)?.snapshot?.state.isStreaming ||
      (!resumeBeforeQueue && this.store.getQueuedPrompts(conversationId).length > 0)) return;
    const goal = approvedPlanning(this.store.getConversation(conversationId).planning) ? undefined : this.store.getConversation(conversationId).goal;
    const plan = this.store.getConversation(conversationId).plan;
    const planRevision = goal?.status !== "active" && canContinuePlan(plan, goal) ? plan!.revision : undefined;
    if (goal?.status !== "active" && planRevision === undefined) return;
    this.goalLaunching.add(conversationId);
    // Never await a prompt from the RPC event queue: its completion needs that queue.
    setTimeout(() => {
      void this.sendPrompt(
        conversationId,
        goal?.status === "active" && goal.steps === 0 ? goal.objective : "Продолжение работы (служебный запрос).",
        attachments,
        undefined,
        planRevision === undefined ? goal?.id : undefined,
        false,
        requestPlan,
        planRevision,
        resumeBeforeQueue,
      )
        .catch(async (error) => {
          const current = this.store
            .snapshot()
            .conversations.find((item) => item.id === conversationId)?.goal;
          if (goal && current?.id === goal.id && current.status === "active")
            await this.updateConversation(conversationId, {
              goal: {
                ...current,
                status: "paused",
                updatedAt: new Date().toISOString(),
                evidence:
                  error instanceof Error ? error.message : String(error),
              },
            });
          if (planRevision !== undefined) {
            const currentPlan = this.store.getConversation(conversationId).plan;
            if (currentPlan?.execution === "active") await this.updateConversation(conversationId, { plan: updatedPlan({ execution: "paused", explanation: error instanceof Error ? error.message : String(error) }, currentPlan) });
          }
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
    await this.modelCatalogSync;
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
      const SessionManager = await getSessionManager();
      SessionManager.open(
        conversation.sessionFile,
        this.store.getSessionDir(cwd, conversation.id),
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
    this.publish("pi:event", {
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
    const snapshot = structuredClone(runtime.snapshot!);
    // Manual compaction has no agent_settled event, which is the normal queue
    // release point. Defer the same one-item drain until after the compact IPC
    // response has returned so the renderer cannot overwrite a newly started
    // run with this idle snapshot.
    if (this.store.getQueuedPrompts(conversationId).length > 0) {
      setTimeout(() => {
        if (
          this.runtimes.get(conversationId) === runtime &&
          !runtime.snapshot?.state.isStreaming &&
          !runtime.snapshot?.state.isCompacting &&
          (!runtime.activeRun || runtime.activeRun.completedAt)
        )
          void this.sendNextQueuedPrompt(conversationId);
      }, 0);
    }
    return snapshot;
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
    this.publish("pi:event", {
      conversationId,
      event: { type: "desktop_queue_update", queued: structuredClone(queued) },
    });
  }

  private async sendNextQueuedPrompt(conversationId: string): Promise<void> {
    if (this.store.getConversation(conversationId).planning?.phase === "review" || this.planningTransitions.has(conversationId)) return;
    const next = this.store.getQueuedPrompts(conversationId)[0];
    if (!next) return;
    try {
      await this.sendQueuedPrompt(conversationId, next.id);
    } catch (error) {
      this.publish("pi:event", {
        conversationId,
        event: {
          type: "desktop_queue_error",
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  async shutdown(): Promise<void> {
    this.openingPreview?.abort();
    await stopSessionReads();
    for (const id of new Set([...this.startingRuntimes.keys(), ...this.runtimes.keys()])) this.invalidateStartup(id);
    await Promise.all(
      this.store
        .snapshot()
        .conversations.filter((item) => item.goal?.status === "active")
        .map((item) =>
          this.updateConversation(item.id, {
            goal: { ...item.goal!, status: "paused", updatedAt: new Date().toISOString() },
          }),
        ),
    );
    this.goalContinuationRequested.clear();
    await Promise.all(
      [...this.runtimes.values()].map(async (runtime) => {
        runtime.diffTracker?.close();
        return void (runtime.diffTracker = undefined);
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

  async rewindConversation(conversationId: string, entryId: string): Promise<ConversationSnapshot> {
    return this.changeHistory(conversationId, entryId);
  }

  async editLastMessage(conversationId: string, entryId: string, text: string): Promise<void> {
    await this.changeHistory(conversationId, entryId, text);
  }

  private async changeHistory(conversationId: string, entryId: string, text?: string): Promise<ConversationSnapshot> {
    if (this.historyMutations.has(conversationId)) throw new Error("История уже изменяется.");
    const editing = text !== undefined;
    if (editing && (typeof text !== "string" || !text.trim())) throw new Error("Сообщение не может быть пустым.");
    this.historyMutations.add(conversationId);
    try {
      const conversation = this.store.getConversation(conversationId);
      const runtime = this.runtimes.get(conversationId);
      if (conversation.status === "starting" || conversation.status === "working" || this.goalLaunching.has(conversationId))
        throw new Error("Дождитесь завершения ответа или остановите его перед изменением истории.");
      if (runtime) {
        await runtime.eventQueue;
        const state = await this.refreshState(conversationId, runtime);
        if (state.isStreaming) throw new Error("Сначала остановите текущий ответ.");
      }
      if (!conversation.sessionFile || !existsSync(conversation.sessionFile)) throw new Error("Сессия ещё не сохранена.");
      const cwd = await this.store.getConversationWorkingDirectory(conversation);
      const SessionManager = await getSessionManager();
      const manager = SessionManager.open(this.store.assertManagedSessionFile(conversation.sessionFile), this.store.getSessionDir(cwd, conversation.id), cwd);
      const target = selectHistoryTarget(manager.getBranch(), entryId, editing);
      const images = editing ? historyImageAttachments(target.message!) : [];
      const previousLeafId = manager.getLeafId();
      // Stop only an idle runtime: extensions are rebound to the new context on next prompt.
      await this.stopConversation(conversationId);
      this.goalContinuationRequested.delete(conversationId);
      const nextLeafId = editing ? target.parentId : target.id;
      if (nextLeafId === null) manager.resetLeaf();
      else manager.branch(nextLeafId);
      const restoredWorkState = historyWorkState(manager.getBranch(), conversation);
      // branch()/resetLeaf() are memory-only. An append-only custom entry persists the leaf
      // without feeding the abandoned branch or a summary of it back to the model.
      manager.appendCustomEntry("pi_desktop_history_position", { previousLeafId, entryId, editing,
        workState: { goal: restoredWorkState.goal ?? null, plan: restoredWorkState.plan ?? null } });
      for (const prompt of this.store.getQueuedPrompts(conversationId))
        await this.store.removeQueuedPrompt(conversationId, prompt.id);
      await this.updateConversation(conversationId, { status: "idle", ...restoredWorkState,
        ...(conversation.planning ? { planning: controlPlanningState("revise", conversation.planning.revision, conversation.planning) } : {}) });
      const snapshot = await this.previewConversation(this.store.getConversation(conversationId));
      this.publish("pi:event", { conversationId, event: { type: "desktop_history_rewound", snapshot } });
      if (editing) await this.sendPrompt(conversationId, text!, images, undefined, undefined, true);
      return snapshot;
    } finally {
      this.historyMutations.delete(conversationId);
    }
  }

  private async getHistoryTargets(conversation: ConversationRecord, messages: unknown[]): Promise<ConversationSnapshot["historyTargets"]> {
    if (!conversation.sessionFile || !existsSync(conversation.sessionFile)) return [];
    const cwd = await this.store.getConversationWorkingDirectory(conversation);
    const SessionManager = await getSessionManager();
    const manager = SessionManager.open(this.store.assertManagedSessionFile(conversation.sessionFile), this.store.getSessionDir(cwd, conversation.id), cwd);
    return sessionHistoryTargets(messages, manager.buildContextEntries());
  }

  private async historyAwareRun(conversation: ConversationRecord): Promise<ConversationRun | undefined> {
    const run = await this.store.getConversationRun(conversation.id);
    if (!run || !conversation.sessionFile || !existsSync(conversation.sessionFile)) return run;
    const cwd = await this.store.getConversationWorkingDirectory(conversation);
    const SessionManager = await getSessionManager();
    const manager = SessionManager.open(this.store.assertManagedSessionFile(conversation.sessionFile), this.store.getSessionDir(cwd, conversation.id), cwd);
    const navigation = [...manager.getBranch()].reverse().find(entry => entry.type === "custom" && entry.customType === "pi_desktop_history_position");
    return navigation && Date.parse(run.startedAt) <= Date.parse(navigation.timestamp) ? undefined : run;
  }

  private async previewConversation(
    conversation: ConversationRecord,
    signal?: AbortSignal,
  ): Promise<ConversationSnapshot> {
    const configuration = await this.store.getAgentConfiguration();
    signal?.throwIfAborted();
    const run = await this.store.getConversationRun(conversation.id);
    let navigationTimestamp: string | undefined;
    let messages: unknown[] = [];
    let entries: ConversationSnapshot["entries"] = [];
    let sessionModel: { provider: string; modelId: string } | null = null;
    let sessionThinkingLevel: ThinkingLevel | undefined;
    let sessionName: string | undefined;
    let historyTargets: ConversationSnapshot["historyTargets"] = [];

    if (conversation.sessionFile && existsSync(conversation.sessionFile)) {
      const cwd =
        await this.store.getConversationWorkingDirectory(conversation);
      const preview = await readSessionPreview(
        this.store.assertManagedSessionFile(conversation.sessionFile), cwd,
        this.store.getSessionDir(cwd, conversation.id), signal,
      );
      messages = preview.messages;
      entries = preview.entries;
      sessionModel = preview.model;
      sessionThinkingLevel = isThinkingLevel(preview.thinkingLevel) ? preview.thinkingLevel : undefined;
      sessionName = preview.sessionName;
      historyTargets = preview.historyTargets;
      navigationTimestamp = preview.navigationTimestamp;
    }

    const provider =
      conversation.provider ??
      sessionModel?.provider ??
      configuration.defaultProvider;
    const modelId =
      conversation.model ?? sessionModel?.modelId ?? configuration.defaultModel;
    const model = selectConfiguredModel(configuration.models, provider, modelId,
      configuration.defaultProvider, configuration.defaultModel);
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
      historyTargets,
      queuedPrompts: this.store.getQueuedPrompts(conversation.id),
      models: configuration.models,
      thinkingLevels,
      commands: structuredClone(BUILTIN_COMMANDS),
      entries,
      compactions: this.store.getCompactions(conversation.id),
      extensionState: structuredClone(this.cachedExtensionState),
      extensionUi: createExtensionUiState(),
      run: run && navigationTimestamp && Date.parse(run.startedAt) <= Date.parse(navigationTimestamp) ? undefined : run,
    };
  }

  private async ensureRuntime(conversationId: string): Promise<RuntimeRecord> {
    const startup = this.startingRuntimes.get(conversationId);
    if (startup) await startup;
    const running = this.runtimes.get(conversationId);
    if (running) return running;
    await this.startConversation(this.store.getConversation(conversationId));
    return this.runtimes.get(conversationId)!;
  }

  private async startConversation(
    conversation: ConversationRecord,
  ): Promise<ConversationSnapshot> {
    if (this.planningTransitions.has(conversation.id)) throw new Error("Дождитесь переключения режима.");
    const pending = this.startingRuntimes.get(conversation.id);
    if (pending) return pending;
    const epoch = this.startupEpochs.get(conversation.id) ?? 0;
    const startup = this.startConversationOnce(conversation);
    this.startingRuntimes.set(conversation.id, startup);
    try { return await startup; }
    catch (error) {
      const current = this.store.snapshot().conversations.find(item => item.id === conversation.id);
      // Preparation can fail before the RPC-specific cleanup is installed.
      // Do not leave the UI stuck at "starting", or overwrite a cancelled chat.
      if (current?.status === "starting" && (this.startupEpochs.get(conversation.id) ?? 0) === epoch) {
        await this.updateConversation(conversation.id, { status: "error" });
      }
      throw error;
    }
    finally {
      if (this.startingRuntimes.get(conversation.id) === startup) this.startingRuntimes.delete(conversation.id);
    }
  }

  private async startConversationOnce(conversation: ConversationRecord): Promise<ConversationSnapshot> {
    const existing = this.runtimes.get(conversation.id);
    if (existing?.snapshot) return structuredClone(existing.snapshot);
    const configuration = await this.store.getAgentConfiguration();
    const selected = selectConfiguredModel(configuration.models, conversation.provider, conversation.model,
      configuration.defaultProvider, configuration.defaultModel);
    if (!selected && conversation.provider && configuration.managedProviders.includes(conversation.provider))
      throw new Error("Прежнее API-подключение больше не доступно. Выберите модель в списке.");
    if (selected && (selected.provider !== conversation.provider || selected.id !== conversation.model))
      conversation = await this.updateConversation(conversation.id, { provider: selected.provider, model: selected.id });
    const epoch = this.startupEpochs.get(conversation.id) ?? 0;
    const assertCurrentStartup = () => {
      if ((this.startupEpochs.get(conversation.id) ?? 0) !== epoch) throw new Error("Запуск чата отменён.");
    };
    const cwd = await this.store.getConversationWorkingDirectory(conversation);
    assertCurrentStartup();
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
    assertCurrentStartup();

    const enginePath = this.store.getEngineEntryPath();
    const remote = await this.remoteRuntime?.(conversation);
    assertCurrentStartup();
    let record!: RuntimeRecord;
    const rpc = new PiRpcProcess({
      executablePath: process.execPath,
      enginePath,
      cwd,
      agentDir: this.store.agentDir,
      sessionsDir: this.store.getSessionDir(cwd, conversation.id),
      sessionId: conversation.id,
      sessionFile: conversation.sessionFile,
      provider: conversation.provider,
      model: conversation.model,
      thinkingLevel: conversation.thinkingLevel,
      appendSystemPrompt: remote ? path.join(this.store.agentDir, "APPEND_SYSTEM.md") : appendSystemPrompt,
      goalExtensionPath: fileURLToPath(
        new URL("./goal-extension.js", import.meta.url),
      ),
      goalStatePath: path.join(this.store.dataDir, "desktop-state.json"),
      planExtensionPath: fileURLToPath(new URL("./plan-extension.js", import.meta.url)),
      planningExtensionPath: fileURLToPath(new URL("./planning-extension.js", import.meta.url)),
      notebookExtensionPath: fileURLToPath(new URL("./notebook-extension.js", import.meta.url)),
      skillsExtensionPath: !remote ? fileURLToPath(new URL("./skills-extension.js", import.meta.url)) : undefined,
      skillsProject: Boolean(project),
      browserExtensionPath: !remote && this.browserRequest ? fileURLToPath(new URL("./browser-extension.js", import.meta.url)) : undefined,
      onGoalRequest: request => {
        if (this.runtimes.get(conversation.id) !== record) throw new Error("Процесс чата уже остановлен.");
        return this.handleGoalRequest(conversation.id, request);
      },
      appRoot: app.getAppPath(),
      isolatedExtensions: remote?.extensions,
      remoteEnvironment: remote?.environment,
      mcpEntryPath: path.join(
        app.getAppPath(),
        "node_modules",
        "@zavora-ai",
        "computer-use-mcp",
        "dist",
        "server.js",
      ),
      mcpDirectTools: remote ? [] : await this.store.getMcpDirectToolSelectors(),
      onEvent: (event) => {
        record.eventQueue = record.eventQueue
          .then(() => {
            if (this.runtimes.get(conversation.id) === record) return this.handleEvent(conversation.id, event);
          })
          .catch((queueError) => {
            if (queueError instanceof StatePersistenceError) {
              this.handlePersistenceFailure(conversation.id, event, queueError);
              return;
            }
            this.publish("pi:event", {
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
      onExtensionUi: (request) => {
        if (this.runtimes.get(conversation.id) === record) this.handleExtensionUi(conversation.id, request);
      },
      onExit: (error) => {
        if (this.runtimes.get(conversation.id) !== record) return;
        this.runtimes.delete(conversation.id);
        void this.handleRuntimeExit(conversation.id, record, error).catch(
          (exitError) => {
            this.publish("pi:event", {
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
      modelsRevision: configuration.revision,
      extensionUi: createExtensionUiState(),
      extensionErrors: [],
      eventQueue: Promise.resolve(),
      activeRun: await this.historyAwareRun(conversation),
      liveTools: {},
    };
    assertCurrentStartup();
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
        rpc.request<{ messages: unknown[]; messageIds?: string[] }>("get_messages"),
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
      assertCurrentStartup();
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
        historyTargets: await this.getHistoryTargets(updated, messagesData.messages ?? []),
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
      record.messageIds = messagesData.messageIds;
      return structuredClone(record.snapshot);
    } catch (error) {
      if (this.runtimes.get(conversation.id) === record) this.runtimes.delete(conversation.id);
      await rpc.stop();
      if ((this.startupEpochs.get(conversation.id) ?? 0) === epoch) await this.updateConversation(conversation.id, { status: "error" });
      throw error;
    }
  }

  private handlePersistenceFailure(conversationId: string, event: JsonObject, error: Error): void {
    const runtime = this.runtimes.get(conversationId);
    if (runtime?.snapshot) {
      if (event.type === "agent_start") runtime.snapshot.state.isStreaming = true;
      if (event.type === "agent_settled") runtime.snapshot.state.isStreaming = false;
      runtime.snapshot.conversation = this.store.getConversation(conversationId);
      this.publish("desktop:conversation-changed", runtime.snapshot.conversation);
    }
    // Disk failure is not a model failure. Do not drop its lifecycle event.
    this.publish("pi:event", { conversationId, event: { ...event, ...(runtime?.snapshot ? { state: runtime.snapshot.state } : {}) } });
    this.publish("pi:event", { conversationId, event: { type: "desktop_persistence_error", error: error.message } });
  }

  private async handleEvent(
    conversationId: string,
    event: JsonObject,
  ): Promise<void> {
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) return;
    // Track this run's outcome from events, not the last projected message:
    // Pi may omit a failed attempt from model history before retry is cancelled.
    if (event.type === "message_end" && (event.message as JsonObject | undefined)?.role === "assistant") {
      runtime.runStopReason = (event.message as JsonObject).stopReason as string | undefined;
      runtime.runError = runtime.runStopReason === "error"
        ? String((event.message as JsonObject).errorMessage || "Модель завершила запрос с ошибкой без описания.")
        : runtime.runStopReason === "length" ? "Достигнут лимит длины ответа модели. Работа не завершена." : undefined;
    }
    if (event.type === "auto_retry_end" && event.success === false) {
      runtime.runStopReason = "error";
      runtime.runError = String(event.finalError || runtime.runError || "Не удалось выполнить запрос после повторных попыток.");
    }
    if (event.type === "agent_start") {
      runtime.runStopReason = undefined;
      runtime.runError = undefined;
      const plan = this.store.getConversation(conversationId).plan;
      // Pi can emit another agent_start while recovering the same logical run.
      // Its confirmed checklist stays current until agent_settled or a revision change.
      const continuingPlan = runtime.activeRun && !runtime.activeRun.completedAt
        && plan?.revision === runtime.planWorkingRevision;
      runtime.planWorkingRevision = plan && (plan.revision === runtime.pendingPlanStartRevision || continuingPlan)
        ? confirmedPlanRevision({ execution: "active" }, plan, true) : undefined;
      runtime.pendingPlanStartRevision = undefined;
      if (runtime.snapshot) runtime.snapshot.planWorkingRevision = runtime.planWorkingRevision;
      event = { ...event, planWorkingRevision: runtime.planWorkingRevision };
      runtime.liveMessage = undefined;
      runtime.liveTools = {};
      if (!runtime.activeRun || runtime.activeRun.completedAt) {
        runtime.activeRun = { startedAt: new Date().toISOString() };
        runtime.runAborted = false;
        runtime.diffRefresh = undefined;
        runtime.diffRefreshQueued = false;
        await this.store.saveConversationRun(conversationId, runtime.activeRun);
      }
      if (runtime.snapshot)
        runtime.snapshot.run = structuredClone(runtime.activeRun);
      if (runtime.snapshot) runtime.snapshot.state.isStreaming = true;
      await this.updateConversation(conversationId, { status: "working" });
    } else if (event.type === "agent_settled") {
      runtime.planWorkingRevision = undefined;
      await this.updateConversation(conversationId, { status: "idle" });
      const messagePatch = await this.refreshRuntimeSnapshot(runtime);
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
          interruption: !runtime.runAborted && runtime.runStopReason === "stop" ? undefined : runtime.activeRun.interruption ?? {},
          error: runtime.runAborted ? undefined : runtime.runError,
          durationMs:
            Date.parse(completedAt) - Date.parse(runtime.activeRun.startedAt),
        };
        await this.store.saveConversationRun(conversationId, runtime.activeRun);
        if (runtime.snapshot)
          runtime.snapshot.run = structuredClone(runtime.activeRun);
      }
      this.publish("pi:event", {
        conversationId,
        event: {
          ...event,
          run: runtime.activeRun,
          state: runtime.snapshot?.state,
          entries: runtime.snapshot?.entries,
          historyTargets: runtime.snapshot?.historyTargets,
          messagePatch,
          messageCount: runtime.snapshot?.messages.length,
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
          this.publish("pi:event", {
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
          this.publish("pi:event", {
            conversationId,
            event: { type: "desktop_diff_error", error: message },
          });
        }
      }
      runtime.liveMessage = undefined;
      runtime.liveTools = {};
      // Settled means idle, not successful. Only a normally completed response
      // may release queued user messages or schedule another automatic turn.
      const completedNormally = !runtime.runAborted && runtime.runStopReason === "stop";
      if (!completedNormally) this.goalContinuationRequested.delete(conversationId);
      this.onConversationSettled?.(this.store.getConversation(conversationId));
      const goal = this.store.getConversation(conversationId).goal;
      if (goal && goal.id === runtime.goalTurnId && runtime.goalTurnStartedAt !== undefined) {
        await this.updateConversation(conversationId, { goal: { ...goal,
          timeUsedSeconds: (goal.timeUsedSeconds ?? 0) + Math.max(0, Date.now() - runtime.goalTurnStartedAt) / 1000,
        } });
      }
      runtime.goalTurnStartedAt = undefined;
      const settledGoal = this.store.getConversation(conversationId).goal;
      if (settledGoal?.status === "active") {
        const next =
          !completedNormally
            ? {
                ...settledGoal,
                status: "paused" as const,
                updatedAt: new Date().toISOString(),
                evidence:
                  "Ответ прерван или завершился ошибкой. Проверьте чат перед продолжением.",
              }
            : settleGoal(settledGoal, runtime.goalProgressAtStart ?? "");
        await this.updateConversation(conversationId, { goal: next });
        if (!completedNormally && runtime.activeRun)
          runtime.activeRun = { ...runtime.activeRun, interruption: { ...runtime.activeRun.interruption, goalId: settledGoal.id } };
      }
      const hasQueued = this.store.getQueuedPrompts(conversationId).length > 0;
      const currentPlan = this.store.getConversation(conversationId).plan;
      if (!completedNormally && currentPlan?.execution === "active") {
        const pausedPlan = updatedPlan({ execution: "paused", explanation: "Автопродолжение приостановлено: ошибка или прерывание. Проверьте чат и дайте команду продолжить." }, currentPlan);
        await this.updateConversation(conversationId, { plan: pausedPlan });
        if (runtime.activeRun)
          runtime.activeRun = { ...runtime.activeRun, interruption: { ...runtime.activeRun.interruption, planRevision: pausedPlan.revision } };
      }
      if (!completedNormally && runtime.activeRun) {
        runtime.activeRun = { ...runtime.activeRun, interruption: runtime.activeRun.interruption ?? {} };
        await this.store.saveConversationRun(conversationId, runtime.activeRun);
        if (runtime.snapshot) runtime.snapshot.run = structuredClone(runtime.activeRun);
        this.publish("pi:event", { conversationId, event: { type: "desktop_run_state", run: runtime.activeRun } });
      }
      if (!completedNormally || runtime.runAborted || this.runtimes.get(conversationId) !== runtime) return;
      if (hasQueued) void this.sendNextQueuedPrompt(conversationId);
      else {
        // A normal text-only response is still a completed goal turn.
        // launchGoal checks current goal/plan state before starting more work.
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
      if (runtime.messageIds && typeof event.desktopMessageId === "string")
        runtime.messageIds.push(event.desktopMessageId);
      else runtime.messageIds = undefined;
      if ((event.message as JsonObject).role === "assistant") {
        const goal = this.store.getConversation(conversationId).goal;
        const usage = (event.message as JsonObject).usage as JsonObject | undefined;
        const used = Number(usage?.totalTokens ?? 0);
        if (goal && goal.id === runtime.goalTurnId && Number.isFinite(used) && used > 0) {
          const tokensUsed = (goal.tokensUsed ?? 0) + used;
          await this.updateConversation(conversationId, { goal: { ...goal, tokensUsed,
            ...(goal.tokenBudget !== undefined && tokensUsed >= goal.tokenBudget && goal.status === "active"
              ? { status: "budget_limited" as const, evidence: "Достигнут лимит токенов цели; это не означает, что цель выполнена." } : {}),
          } });
        }
        event.state = await this.refreshState(conversationId, runtime);
        runtime.liveMessage = undefined;
      }
    } else if (
      event.type === "tool_execution_start" &&
      typeof event.toolCallId === "string"
    ) {
      runtime.liveTools[event.toolCallId] = {
        id: event.toolCallId,
        parentToolCallId: typeof event.parentToolCallId === "string" ? event.parentToolCallId : undefined,
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
        ...(typeof event.parentToolCallId === "string" ? { parentToolCallId: event.parentToolCallId } : {}),
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
        ...(typeof event.parentToolCallId === "string" ? { parentToolCallId: event.parentToolCallId } : {}),
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
    this.publish("pi:event", { conversationId, event });
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
        this.publish("pi:event", {
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
    const stoppedByUser = runtime.runAborted;
    runtime.runAborted = true;
    this.goalContinuationRequested.delete(conversationId);
    runtime.diffTracker?.close();
    runtime.diffTracker = undefined;
    const plan = this.store.getConversation(conversationId).plan;
    const pausedPlan = plan?.execution === "active" ? updatedPlan({ execution: "paused", explanation: "Процесс Pi остановлен. Продолжение — вручную." }, plan) : undefined;
    if (pausedPlan) await this.updateConversation(conversationId, { plan: pausedPlan });
    const goal = this.store.getConversation(conversationId).goal;
    if (goal?.status === "active")
      await this.updateConversation(conversationId, {
        goal: {
          ...goal,
          status: "paused",
          updatedAt: new Date().toISOString(),
          evidence: "Процесс Pi остановлен. Продолжение — вручную.",
        },
      });
    if (runtime.activeRun && !runtime.activeRun.completedAt) {
      const completedAt = new Date().toISOString();
      runtime.activeRun = {
        ...runtime.activeRun,
        completedAt,
        error: stoppedByUser ? undefined : error?.message || "Процесс Pi неожиданно завершился до окончания запроса.",
        interruption: { ...runtime.activeRun.interruption,
          ...(pausedPlan ? { planRevision: pausedPlan.revision } : {}),
          ...(goal?.status === "active" ? { goalId: goal.id } : {}),
        },
        durationMs:
          Date.parse(completedAt) - Date.parse(runtime.activeRun.startedAt),
      };
      await this.store.saveConversationRun(conversationId, runtime.activeRun);
      if (runtime.snapshot) runtime.snapshot.run = structuredClone(runtime.activeRun);
    }
    await this.updateConversation(conversationId, {
      status: error ? "error" : "idle",
    });
    this.publish("pi:event", { conversationId, event: { type: "desktop_run_state", stopped: true, run: runtime.activeRun } });
    if (error) {
      this.publish("pi:event", {
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
    this.publish("pi:extension-ui", {
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

  private async refreshRuntimeSnapshot(runtime: RuntimeRecord): Promise<MessagePatch | undefined> {
    const [stateData, messagesData, entriesData, extensionData] =
      await Promise.all([
        runtime.rpc.request<JsonObject>("get_state"),
        runtime.rpc.request<MessagePatch & { messageIds?: string[] }>("get_messages", {
          knownMessageIds: runtime.messageIds,
        }),
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
    const messagePatch = {
      startIndex: messagesData.startIndex ?? 0,
      messages: messagesData.messages ?? [],
    };
    const previousMessages = runtime.snapshot.messages;
    runtime.snapshot.messages = applyMessagePatch(previousMessages, messagePatch);
    runtime.messageIds = messagesData.messageIds;
    runtime.snapshot.historyTargets = await this.getHistoryTargets(runtime.snapshot.conversation, runtime.snapshot.messages);
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
    return runtime.snapshot.messages === previousMessages ? undefined : messagePatch;
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
    snapshot.run = runtime.activeRun ? structuredClone(runtime.activeRun) : snapshot.run;
    snapshot.liveMessage = runtime.liveMessage
      ? structuredClone(runtime.liveMessage)
      : undefined;
    snapshot.liveTools = structuredClone(runtime.liveTools);
    snapshot.planWorkingRevision = runtime.planWorkingRevision;
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
    this.publish("desktop:conversation-changed", updated);
    return updated;
  }

  private async stopConversation(conversationId: string): Promise<void> {
    this.invalidateStartup(conversationId);
    const goal = this.store
      .snapshot()
      .conversations.find((item) => item.id === conversationId)?.goal;
    if (goal?.status === "active")
      await this.updateConversation(conversationId, {
        goal: { ...goal, status: "paused", updatedAt: new Date().toISOString() },
      });
    const runtime = this.runtimes.get(conversationId);
    if (!runtime) return;
    this.runtimes.delete(conversationId);
    runtime.diffTracker?.close();
    runtime.diffTracker = undefined;
    await runtime.rpc.stop();
  }

  private invalidateStartup(conversationId: string): void {
    this.startupEpochs.set(conversationId, (this.startupEpochs.get(conversationId) ?? 0) + 1);
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
