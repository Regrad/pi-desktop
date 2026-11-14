import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, shell, protocol } from "electron";
import { appendFile, mkdir, realpath, rename, stat } from "node:fs/promises";
import path from "node:path";
import { portableDataDirectory } from "./portable-paths.js";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Attachment, BuiltinModuleId, ConfiguredModelUpdate, ModelServerDiscoveryInput, ThinkingLevel, UpdateComponentId, UpdateResult } from "../shared/types.js";
import { DataStore } from "./data-store.js";
import { PiManager } from "./pi-manager.js";
import { BrowserManager } from "./browser-manager.js";
import type { BrowserUiCommand } from "../shared/browser.js";
import { UpdateManager } from "./update-manager.js";
import { loadComfySettings, saveComfySettings, checkComfyConnection, importComfyWorkflow } from "./comfy-client.js";
import type { ComfySettings } from "../shared/comfy.js";
import { generatedFile, generatedMediaResponse } from "./generated-media.js";
import { parseGeneratedLink } from "../shared/generated-links.js";
import { randomUUID } from "node:crypto";
import type { RemoteRuntime } from "./remote-runtime.js";
import { StartupTasks } from "./startup-tasks.js";
import { installImageContextMenu } from "./image-context-menu.js";
import { translateUi, type InterfaceLanguage } from "../shared/interface-language.js";
import type { WebAccessSettings } from "../shared/web-access.js";

protocol.registerSchemesAsPrivileged([{ scheme: "pi-generated", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..", "..");
let mainWindow: BrowserWindow | null = null;
let store: DataStore;
const t = (key: string, ...values: unknown[]) => translateUi(key, store?.getInterfaceLanguage() ?? "en", ...values);
let piManager: PiManager;
let browserManager: BrowserManager;
let shuttingDown = false;
let updateManager: UpdateManager;
let logPath = "";
let controlApi: Awaited<ReturnType<typeof import("../resources/control-api/server.mjs").startControlApi>> | undefined;
let webAccess: import("../resources/web-access/server.mjs").WebAccessService | undefined;
let remoteRuntime: RemoteRuntime | undefined;
const startupTasks = new StartupTasks();
const startupAbort = new AbortController();
let windowShown = false, rendererReady = false, backgroundStarted = false;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

async function writeDiagnostic(scope: string, error: unknown): Promise<void> {
  if (!logPath) return;
  const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
  try {
    const info = await stat(logPath).catch(() => undefined);
    if (info && info.size > 5 * 1024 * 1024) {
      await rename(logPath, `${logPath}.previous`).catch(() => undefined);
    }
    await appendFile(logPath, `${new Date().toISOString()} [${scope}] ${message}\n`, "utf8");
  } catch {
    // Diagnostics must never bring down the application.
  }
}

async function prepareAttachments(paths: string[]): Promise<Attachment[]> {
  if (!Array.isArray(paths) || paths.some((filePath) => typeof filePath !== "string" || !path.isAbsolute(filePath)))
    throw new Error(t("Нужны абсолютные пути к файлам вложений"));
  return Promise.all([...new Set(paths)].map(async (filePath) => {
    if (!(await stat(filePath)).isFile()) throw new Error(t("Можно прикреплять только файлы: {0}", filePath));
    const image = nativeImage.createFromPath(filePath);
    return {
      id: crypto.randomUUID(), name: path.basename(filePath), path: filePath,
      ...(!image.isEmpty() ? { mimeType: "image/png", data: image.toPNG().toString("base64") } : {}),
    };
  }));
}

function resolveDataDir(): string {
  return portableDataDirectory(projectRoot, process.execPath, app.isPackaged, process.env.PORTABLE_EXECUTABLE_DIR);
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1520,
    height: 960,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#f7f7f5",
    title: "Pi Desktop",
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#f6f6f4",
      symbolColor: "#656560",
      height: 36,
    },
    show: false,
    webPreferences: {
      preload: path.join(currentDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  installImageContextMenu(mainWindow, () => store?.getInterfaceLanguage() ?? "en");
  const shown = new Promise<void>(resolve => {
    mainWindow!.once("ready-to-show", () => { mainWindow?.show(); resolve(); });
    mainWindow!.once("closed", resolve);
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    // Hidden offscreen browser windows must not keep the application alive.
    app.quit();
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const currentUrl = mainWindow?.webContents.getURL();
    if (url !== currentUrl) event.preventDefault();
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) await mainWindow.loadURL(devUrl);
  else await mainWindow.loadFile(path.join(projectRoot, "dist", "index.html"));
  await shown;
}

function registerIpc(): void {
  ipcMain.on("desktop:renderer-ready", event => {
    if (event.sender !== mainWindow?.webContents) return;
    rendererReady = true;
    startBackgroundServices();
  });
  ipcMain.handle("desktop:skills", (event, id: string, command: import("../shared/skills.js").SkillsCommand) => {
    if (event.sender !== mainWindow?.webContents) throw new Error(t("Управление навыками разрешено только интерфейсу Pi Desktop."));
    return piManager.manageSkills(id, command);
  });
  ipcMain.handle("desktop:browser", (event, command: BrowserUiCommand) => {
    if (event.sender !== mainWindow?.webContents) throw new Error(t("Доступ к браузеру разрешён только интерфейсу Pi Desktop."));
    if (command.conversationId) store.getConversation(command.conversationId);
    return browserManager.ui(command);
  });
  ipcMain.handle("desktop:get-web-access-settings", async () => (await ensureWebAccess()).status());
  ipcMain.handle("desktop:save-web-access-settings", async (_event, settings: WebAccessSettings) => (await ensureWebAccess()).configure(settings));
  ipcMain.handle("desktop:bootstrap", () => {
    const state = store.snapshot();
    return {
      ...state,
      archivedConversations: store.getArchivedConversations(),
      dataDir: store.dataDir,
      sessionsDir: store.sessionsDir,
    };
  });
  ipcMain.handle("desktop:choose-project-folders", async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: t("Добавить папки проекта"),
      properties: ["openDirectory", "createDirectory", "multiSelections"],
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle("desktop:create-project", async (_event, name: string, paths: string[]) => {
    const project = await store.addProject(name, paths);
    const conversations = await store.refreshProjectSessions(project.id);
    for (const conversation of conversations) {
      mainWindow?.webContents.send("desktop:conversation-changed", conversation);
    }
    return project;
  });
  ipcMain.handle("desktop:refresh-project-sessions", (_event, projectId: string) =>
    store.refreshProjectSessions(projectId),
  );
  ipcMain.handle("desktop:search-conversations", (_event, query: string) =>
    store.searchConversations(query),
  );
  ipcMain.handle("desktop:choose-attachments", async (): Promise<Attachment[]> => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: t("Добавить вложения"),
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled) return [];
    return prepareAttachments(result.filePaths);
  });
  ipcMain.handle("desktop:attach-file-paths", (_event, paths: string[]) => prepareAttachments(paths));
  ipcMain.handle("desktop:remove-project", async (_event, projectId: string) => {
    const project = store.getProject(projectId);
    const result = await dialog.showMessageBox(mainWindow!, {
      type: "question",
      title: t("Убрать проект?"),
      message: t("Убрать проект «{0}» из Pi Desktop?", project.name),
      detail: t("Папка и штатные сессии Pi останутся на диске. Удалится только запись проекта из приложения."),
      buttons: [t("Отмена"), t("Убрать")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) return false;
    await piManager.removeProject(projectId);
    return true;
  });
  ipcMain.handle("desktop:rename-project", (_event, projectId: string, name: string) =>
    piManager.renameProject(projectId, name),
  );
  ipcMain.handle("desktop:create-conversation", (_event, projectId?: string) =>
    piManager.createConversation(projectId),
  );
  ipcMain.handle("desktop:open-conversation", (_event, conversationId: string) =>
    piManager.openConversation(conversationId),
  );
  ipcMain.handle("desktop:delete-conversation", async (_event, conversationId: string) => {
    const conversation = store.getConversation(conversationId);
    const result = await dialog.showMessageBox(mainWindow!, {
      type: "warning",
      title: t("Удалить чат?"),
      message: t("Удалить чат «{0}»?", conversation.title),
      detail: t("История и собственные файлы чата будут перемещены в корзину Windows. Внешние проекты и файлы-ссылки останутся нетронутыми."),
      buttons: [t("Отмена"), t("Удалить")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) return false;
    await piManager.deleteConversation(conversationId);
    browserManager.closeConversation(conversationId);
    return true;
  });
  ipcMain.handle("desktop:archive-conversation", (_event, conversationId: string) =>
    piManager.archiveConversation(conversationId),
  );
  ipcMain.handle("desktop:restore-conversation", (_event, conversationId: string) =>
    piManager.restoreConversation(conversationId),
  );
  ipcMain.handle(
    "pi:send-prompt",
    (
      _event,
      conversationId: string,
      message: string,
      attachments: Attachment[],
      behavior?: "steer" | "followUp",
      requestPlan?: boolean,
    ) => piManager.sendPrompt(conversationId, message, attachments, behavior, undefined, false, requestPlan === true),
  );
  ipcMain.handle("desktop:queue-prompt", (_event, conversationId: string, message: string, attachments: Attachment[], requestPlan?: boolean) =>
    piManager.queuePrompt(conversationId, message, attachments, requestPlan === true),
  );
  ipcMain.handle("desktop:send-queued-prompt", (_event, conversationId: string, promptId: string) =>
    piManager.sendQueuedPrompt(conversationId, promptId),
  );
  ipcMain.handle("desktop:remove-queued-prompt", (_event, conversationId: string, promptId: string) =>
    piManager.removeQueuedPrompt(conversationId, promptId),
  );
  ipcMain.handle("pi:abort", (_event, conversationId: string) => piManager.abort(conversationId));
  ipcMain.handle("pi:resume", (_event, conversationId: string) => piManager.resumeConversation(conversationId));
  ipcMain.handle("pi:set-goal", (_event, id: string, objective: string, attachments: Attachment[], requestPlan?: boolean) =>
    piManager.setGoal(id, objective, attachments, requestPlan === true));
  ipcMain.handle("pi:control-goal", (_event, id: string, action: "pause" | "resume" | "remove") =>
    piManager.controlGoal(id, action));
  ipcMain.handle("pi:edit-goal", (_event, id: string, objective: string) =>
    piManager.editGoal(id, objective));
  ipcMain.handle("pi:remove-plan", (_event, id: string) => piManager.removePlan(id));
  ipcMain.handle("pi:control-plan", (_event, id: string, action: "pause" | "resume") => piManager.controlPlan(id, action));
  ipcMain.handle("pi:control-planning", (_event, id: string, action: "start" | "revise" | "approve" | "cancel", revision: number) => piManager.controlPlanning(id, action, revision));
  ipcMain.handle("pi:save-notebook", (_event, id: string, content: string, revision: number) => piManager.saveNotebook(id, content, revision));
  ipcMain.handle("desktop:get-notebook-limit", () => store.getNotebookCharacterLimit());
  ipcMain.handle("desktop:set-interface-language", (_event, language: InterfaceLanguage) => store.setInterfaceLanguage(language));
  ipcMain.handle("desktop:set-notebook-limit", (_event, value: number) => store.setNotebookCharacterLimit(value));
  ipcMain.handle("pi:set-model", (_event, conversationId: string, provider: string, modelId: string) =>
    piManager.setModel(conversationId, provider, modelId),
  );
  ipcMain.handle("pi:set-thinking", (_event, conversationId: string, level: ThinkingLevel) =>
    piManager.setThinkingLevel(conversationId, level),
  );
  ipcMain.handle("pi:rewind", (_event, conversationId: string, entryId: string) =>
    piManager.rewindConversation(conversationId, entryId),
  );
  ipcMain.handle("pi:edit-last-message", (_event, conversationId: string, entryId: string, text: string) =>
    piManager.editLastMessage(conversationId, entryId, text),
  );
  ipcMain.handle("pi:set-editor-text", (_event, conversationId: string, text: string) =>
    piManager.setHostEditorText(conversationId, text),
  );
  ipcMain.handle("pi:clear-queue", (_event, conversationId: string) =>
    piManager.clearQueue(conversationId),
  );
  ipcMain.handle("pi:compact", (_event, conversationId: string, customInstructions?: string) =>
    piManager.compactConversation(conversationId, customInstructions),
  );
  ipcMain.handle("pi:reload", (_event, conversationId: string) =>
    piManager.reloadRuntime(conversationId),
  );
  ipcMain.handle("desktop:rename-conversation", (_event, conversationId: string, title: string) =>
    piManager.renameConversation(conversationId, title),
  );
  ipcMain.handle(
    "pi:extension-ui-response",
    (_event, conversationId: string, response: Record<string, unknown>) =>
      piManager.respondToExtensionUi(conversationId, response),
  );
  ipcMain.handle("desktop:get-global-prompt", () => store.getGlobalPrompt());
  ipcMain.handle("desktop:get-comfy-settings", () => loadComfySettings(store.dataDir));
  ipcMain.handle("desktop:save-comfy-settings", (_event, settings: ComfySettings) => saveComfySettings(store.dataDir, settings));
  ipcMain.handle("desktop:check-comfy-connection", (_event, url: string) => checkComfyConnection(url));
  ipcMain.handle("desktop:import-comfy-workflow", async () => {
    const selection = await dialog.showOpenDialog(mainWindow!, { title: t("Workflow ComfyUI в формате API"), filters: [{ name: "API workflow", extensions: ["json"] }], properties: ["openFile"] });
    return selection.canceled || !selection.filePaths[0] ? null : importComfyWorkflow(store.dataDir, selection.filePaths[0]);
  });
  ipcMain.handle("desktop:save-global-prompt", async (_event, prompt: string) => {
    const saved = await store.saveGlobalPrompt(prompt);
    piManager.invalidateInstructions();
    remoteRuntime?.invalidateInstructions();
    return saved;
  });
  ipcMain.handle("desktop:get-project-instructions", (_event, projectId: string) => store.getProjectInstructions(projectId));
  ipcMain.handle("desktop:save-project-instructions", async (_event, projectId: string, content: string) => {
    const saved = await store.saveProjectInstructions(projectId, content);
    piManager.invalidateInstructions(projectId);
    return saved;
  });
  ipcMain.handle("desktop:get-model-servers", () => piManager.getModelServers());
  ipcMain.handle("desktop:discover-model-server", async (_event, input: ModelServerDiscoveryInput) => {
    const result = await store.discoverModelServer(input);
    await piManager.modelConfigurationChanged();
    return result;
  });
  ipcMain.handle("desktop:update-configured-model", async (_event, input: ConfiguredModelUpdate) => {
    const result = await store.updateConfiguredModel(input);
    await piManager.modelConfigurationChanged();
    return result;
  });
  ipcMain.handle("desktop:delete-configured-model", async (_event, providerId: string, modelId: string) => {
    const server = (await store.getModelServers()).find((item) => item.id === providerId);
    const model = server?.models.find((item) => item.id === modelId);
    if (!server || !model) return null;
    const result = await dialog.showMessageBox(mainWindow!, {
      type: "warning",
      title: t("Удалить модель?"),
      message: t("Удалить модель «{0}»?", model.name ?? model.id),
      detail: t("Она будет удалена из конфигурации сервера «{0}». Файлы модели на сервере не затрагиваются.", providerId),
      buttons: [t("Отмена"), t("Удалить")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) return null;
    const updated = await store.deleteConfiguredModel(providerId, modelId);
    await piManager.modelConfigurationChanged();
    return updated;
  });
  ipcMain.handle("desktop:delete-model-server", async (_event, providerId: string) => {
    const server = (await store.getModelServers()).find((item) => item.id === providerId);
    if (!server) return false;
    const result = await dialog.showMessageBox(mainWindow!, {
      type: "warning",
      title: t("Удалить сервер?"),
      message: t("Удалить сервер «{0}» из Pi?", providerId),
      detail: t("Из models.json будут удалены сервер и {0} {1}. Сам сервер и файлы моделей не затрагиваются.", server.models.length, server.models.length === 1 ? t("модель") : t("моделей")),
      buttons: [t("Отмена"), t("Удалить")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) return false;
    const deleted = await store.deleteModelServer(providerId);
    await piManager.modelConfigurationChanged();
    return deleted;
  });
  ipcMain.handle("desktop:get-update-status", (_event, force?: boolean) => updateManager.getStatus(Boolean(force)));
  ipcMain.handle("desktop:update-component", async (_event, id: UpdateComponentId): Promise<UpdateResult> => {
    const status = await updateManager.getStatus();
    const component = status.components.find((item) => item.id === id && item.updateable);
    if (!component) throw new Error(t("Этот компонент нельзя обновить из Pi Desktop"));
    const result = await dialog.showMessageBox(mainWindow!, {
      type: "question",
      title: t("Обновить {0}?", component.name),
      message: component.updateAvailable
        ? t("Установить {0} {1}?", component.name, component.latestVersion)
        : t("{0} уже имеет последнюю доступную версию.", component.name),
      detail: component.updateAvailable
        ? t("Открытые процессы Pi будут перезапущены при следующем сообщении. Активная генерация не прерывается: во время неё обновление будет отклонено.")
        : t("Обновление не требуется."),
      buttons: component.updateAvailable ? [t("Отмена"), t("Обновить")] : [t("Закрыть")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (!component.updateAvailable || result.response !== 1) return { status, updated: [], errors: [] };
    await piManager.prepareForRuntimeUpdate();
    return updateManager.updateComponent(id);
  });
  ipcMain.handle("desktop:update-all-components", async (): Promise<UpdateResult> => {
    const status = await updateManager.getStatus();
    const pending = status.components.filter((item) => item.updateable && item.updateAvailable);
    if (!pending.length) return { status, updated: [], errors: [] };
    const result = await dialog.showMessageBox(mainWindow!, {
      type: "question",
      title: t("Обновить дополнения?"),
      message: t("Будет обновлено компонентов: {0}.", pending.length),
      detail: t("{0}\n\nЛокальные защищённые модули не изменяются.", pending.map((item) => `${item.name}: ${item.currentVersion ?? "?"} → ${item.latestVersion ?? "?"}`).join("\n")),
      buttons: [t("Отмена"), t("Обновить всё")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) return { status, updated: [], errors: [] };
    await piManager.prepareForRuntimeUpdate();
    return updateManager.updateAll();
  });
  ipcMain.handle("desktop:get-module-settings", () => store.getModuleSettings());
  ipcMain.handle("desktop:set-builtin-module-enabled", async (_event, id: BuiltinModuleId, enabled: boolean) => {
    await piManager.prepareForRuntimeUpdate();
    return store.setBuiltinModuleEnabled(id, Boolean(enabled));
  });
  ipcMain.handle("desktop:add-user-extension", async (_event, kind: "file" | "directory") => {
    const result = await dialog.showOpenDialog(mainWindow!, kind === "directory"
      ? { title: t("Добавить папку расширения Pi"), properties: ["openDirectory"] }
      : {
          title: t("Добавить файл расширения Pi"),
          properties: ["openFile"],
          filters: [{ name: t("Расширения Pi"), extensions: ["ts", "js", "mjs", "cjs"] }],
        });
    if (result.canceled || !result.filePaths[0]) return null;
    await piManager.prepareForRuntimeUpdate();
    return store.addUserExtension(result.filePaths[0]);
  });
  ipcMain.handle("desktop:remove-user-extension", async (_event, name: string) => {
    const settings = await store.getModuleSettings();
    const extension = settings.userExtensions.find((item) => item.name === name);
    if (!extension) return null;
    const result = await dialog.showMessageBox(mainWindow!, {
      type: "warning",
      title: t("Удалить пользовательское расширение?"),
      message: t("Удалить «{0}»?", extension.name),
      detail: t("Расширение будет удалено из пользовательской папки Pi Desktop. Встроенные модули эта операция не затрагивает."),
      buttons: [t("Отмена"), t("Удалить")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) return null;
    await piManager.prepareForRuntimeUpdate();
    return store.removeUserExtension(extension.name);
  });
  ipcMain.handle("desktop:show-item", (_event, itemPath: string) => shell.showItemInFolder(itemPath));
  ipcMain.handle("desktop:show-generated", async (_event, kind: string, filename: string) => shell.showItemInFolder(await generatedFile(store.dataDir, kind, filename)));
  ipcMain.handle("desktop:open-generated-link", async (_event, url: string) => {
    const link = typeof url === "string" ? parseGeneratedLink(url) : undefined;
    if (!link) throw new Error(t("Некорректная ссылка на медиафайл"));
    const file = await generatedFile(store.dataDir, link.kind, link.filename);
    // The original absolute path is historical. Open only the asset resolved
    // inside current data, including results moved into their owning chat.
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
  });
}

async function initializeDesktop(): Promise<void> {
  Menu.setApplicationMenu(null);
  const dataDir = resolveDataDir();
  await mkdir(dataDir, { recursive: true });
  const logsDir = path.join(dataDir, "logs");
  await mkdir(logsDir, { recursive: true });
  logPath = path.join(logsDir, "pi-desktop.log");
  store = new DataStore(dataDir, projectRoot, process.execPath);
  await store.initialize({ refreshSessions: false });
  protocol.handle("pi-generated", (request) => generatedMediaResponse(store.dataDir, request));
  browserManager = new BrowserManager(store.dataDir, () => mainWindow, state => mainWindow?.webContents.send("desktop:browser-changed", state));
  piManager = new PiManager(store, () => mainWindow, (conversation) => {
    // inspectConversation captures the snapshot before Pi launches queued work.
    void piManager.inspectConversation(conversation.id).then((snapshot) => controlApi?.settled(conversation.id, snapshot)).catch((error) => writeDiagnostic("control-api-result", error));
    if (!mainWindow?.isFocused() && Notification.isSupported()) {
      new Notification({ title: "Pi Desktop", body: t("Задача завершена: {0}", conversation.title) }).show();
    }
  }, (channel, payload) => webAccess?.publish(channel, payload), undefined, (id, params) => browserManager.request(id, params), id => browserManager.cancel(id));
  updateManager = new UpdateManager(store, projectRoot, process.execPath);
  registerIpc();
  await createWindow();
  windowShown = true;
  startBackgroundServices();
}

function startBackgroundServices(): void {
  if (shuttingDown || !mainWindow || !windowShown || !rendererReady || backgroundStarted) return;
  backgroundStarted = true;
  // A slow/failed optional service must not postpone the first usable window.
  for (const [scope, start] of [
    ["session-index", refreshSessionIndex], ["web-access", ensureWebAccess], ["control-api", ensureControlApi],
  ] as const) void start().catch(error => { if (!shuttingDown) void writeDiagnostic(scope, error); });
}

async function refreshSessionIndex(): Promise<void> {
  await startupTasks.start("session-index", async () => {
    const before = new Map(store.snapshot().conversations.map(conversation => [conversation.id, JSON.stringify(conversation)]));
    await store.refreshAllProjectSessions(startupAbort.signal);
    if (shuttingDown) return;
    for (const conversation of store.snapshot().conversations) {
      if (before.get(conversation.id) === JSON.stringify(conversation)) continue;
      mainWindow?.webContents.send("desktop:conversation-changed", conversation);
      webAccess?.publish("desktop:conversation-changed", conversation);
    }
  });
}

async function ensureWebAccess() {
  const service = await startupTasks.start("web-access", async () => {
    const dataDir = store.dataDir;
    const [{ webBackend }, { RemoteRuntime }] = await Promise.all([import("./web-backend.js"), import("./remote-runtime.js")]);
    const { createWebAccess } = await import(pathToFileURL(path.join(projectRoot, "resources", "web-access", "server.mjs")).href) as typeof import("../resources/web-access/server.mjs");
    remoteRuntime = new RemoteRuntime(store, projectRoot, process.execPath, (channel, payload, id) => webAccess?.publish(channel, payload, id));
    const helperFile = path.join(projectRoot, "resources", "client-agent", "Pi Desktop Agent.exe");
    return createWebAccess({ dataDir, rendererDir: path.join(projectRoot, "dist"), backend: webBackend(store, piManager, { methods: {
      chooseProjectFolders: async () => { const result = await dialog.showOpenDialog(mainWindow!, { properties: ["openDirectory", "multiSelections"] }); return result.canceled ? [] : result.filePaths; },
      createProject: (name: string, paths: string[]) => store.addProject(name, paths),
      saveComfySettings: (settings: ComfySettings) => saveComfySettings(store.dataDir, settings),
      checkComfyConnection: (url: string) => checkComfyConnection(url),
      refreshProjectSessions: (id: string) => store.refreshProjectSessions(id),
      renameProject: (id: string, name: string) => piManager.renameProject(id, name),
      removeProject: async (id: string) => { await piManager.removeProject(id); return true; },
      deleteConversation: async (id: string) => { await piManager.deleteConversation(id); return true; },
      getProjectInstructions: (id: string) => store.getProjectInstructions(id),
      saveProjectInstructions: async (id: string, content: string) => { const result = await store.saveProjectInstructions(id, content); piManager.invalidateInstructions(id); return result; },
    } }),
      helperFile: await stat(helperFile).then(() => helperFile).catch(() => undefined),
      remoteBackend: (id, broker, credential) => remoteRuntime!.backend(id, broker, credential),
      onDeviceDisconnected: id => remoteRuntime?.disconnect(id),
    });
  }, value => value.close());
  webAccess = service;
  return service;
}

async function ensureControlApi() {
  const service = await startupTasks.start("control-api", async () => {
    const dataDir = store.dataDir;
    const { startControlApi } = await import(pathToFileURL(path.join(projectRoot, "resources", "control-api", "server.mjs")).href) as typeof import("../resources/control-api/server.mjs");
    return startControlApi({
      dataDir,
      backend: {
        projects: () => store.snapshot().projects,
        chats: () => store.snapshot().conversations.map(({ id, projectId, title, status }) => ({ id, projectId, title, status })),
        attachments: prepareAttachments,
        create: (projectId) => piManager.createConversation(projectId),
        inspect: (id) => piManager.inspectConversation(id),
        select: async (id) => {
          if (!mainWindow || mainWindow.isDestroyed()) throw new Error(t("Окно Pi Desktop не готово"));
          const selected = await piManager.openConversation(id);
          const requestId = randomUUID();
          const contents = mainWindow.webContents;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => { cleanup(); reject(new Error(t("Интерфейс Pi Desktop не ответил"))); }, 10000);
            const listener = (event: Electron.IpcMainEvent, acknowledged: string) => {
              if (event.sender !== contents || acknowledged !== requestId) return;
              cleanup(); resolve();
            };
            const cleanup = () => { clearTimeout(timer); ipcMain.removeListener("desktop:control-selected", listener); };
            ipcMain.on("desktop:control-selected", listener);
            contents.send("desktop:control-select", { requestId, snapshot: selected });
          });
        },
        prompt: (id, message, attachments) => piManager.sendPrompt(id, message, attachments),
        abort: (id) => piManager.abort(id),
        reply: (id, response) => piManager.respondToExtensionUi(id, response),
      },
    });
  }, value => value.close());
  controlApi = service;
  return service;
}

if (hasSingleInstanceLock) void app.whenReady().then(initializeDesktop).catch(async (error) => {
  await writeDiagnostic("startup", error);
  dialog.showErrorBox(t("Не удалось запустить Pi Desktop"), error instanceof Error ? error.message : String(error));
  app.quit();
});

process.on("uncaughtException", (error) => {
  void writeDiagnostic("uncaughtException", error).finally(() => app.exit(1));
});
process.on("unhandledRejection", (error) => void writeDiagnostic("unhandledRejection", error));

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (!piManager) return;
  event.preventDefault();
  if (shuttingDown) return;
  shuttingDown = true;
  startupAbort.abort();
  void Promise.all([startupTasks.close(), piManager.shutdown(), browserManager?.dispose()]).finally(() => remoteRuntime?.close()).finally(() => {
    piManager = undefined as unknown as PiManager;
    app.exit(0);
  });
});
