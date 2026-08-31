import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell } from "electron";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Attachment, ThinkingLevel } from "../shared/types.js";
import { DataStore } from "./data-store.js";
import { PiManager } from "./pi-manager.js";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDir, "..", "..");
let mainWindow: BrowserWindow | null = null;
let store: DataStore;
let piManager: PiManager;

function resolveDataDir(): string {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir) return path.join(portableDir, "data");
  if (!app.isPackaged) return path.join(projectRoot, "data");
  return path.join(path.dirname(process.execPath), "data");
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
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
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
}

function registerIpc(): void {
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
      title: "Добавить папки проекта",
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
  ipcMain.handle("desktop:choose-attachments", async (): Promise<Attachment[]> => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: "Добавить вложения",
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled) return [];
    return result.filePaths.map((filePath) => {
      const image = nativeImage.createFromPath(filePath);
      const isImage = !image.isEmpty();
      return {
        id: crypto.randomUUID(),
        name: path.basename(filePath),
        path: filePath,
        ...(isImage
          ? { mimeType: "image/png", data: image.toPNG().toString("base64") }
          : {}),
      };
    });
  });
  ipcMain.handle("desktop:remove-project", (_event, projectId: string) => piManager.removeProject(projectId));
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
      title: "Удалить чат?",
      message: `Удалить чат «${conversation.title}»?`,
      detail: conversation.sessionFile
        ? "Файл сессии Pi будет перемещён в корзину Windows. Это затронет и обычный Pi."
        : "Чат ещё не записан в сессию Pi и будет удалён из списка.",
      buttons: ["Отмена", "Удалить"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (result.response !== 1) return false;
    await piManager.deleteConversation(conversationId);
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
    ) => piManager.sendPrompt(conversationId, message, attachments, behavior),
  );
  ipcMain.handle("pi:abort", (_event, conversationId: string) => piManager.abort(conversationId));
  ipcMain.handle("pi:set-model", (_event, conversationId: string, provider: string, modelId: string) =>
    piManager.setModel(conversationId, provider, modelId),
  );
  ipcMain.handle("pi:set-thinking", (_event, conversationId: string, level: ThinkingLevel) =>
    piManager.setThinkingLevel(conversationId, level),
  );
  ipcMain.handle("desktop:rename-conversation", (_event, conversationId: string, title: string) =>
    piManager.renameConversation(conversationId, title),
  );
  ipcMain.handle(
    "pi:extension-ui-response",
    (_event, conversationId: string, response: Record<string, unknown>) =>
      piManager.respondToExtensionUi(conversationId, response),
  );
  ipcMain.handle("desktop:show-item", (_event, itemPath: string) => shell.showItemInFolder(itemPath));
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const dataDir = resolveDataDir();
  await mkdir(dataDir, { recursive: true });
  store = new DataStore(dataDir, projectRoot);
  await store.initialize();
  piManager = new PiManager(store, () => mainWindow);
  registerIpc();
  await createWindow();
});

app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (!piManager) return;
  event.preventDefault();
  void piManager.shutdown().finally(() => {
    piManager = undefined as unknown as PiManager;
    app.exit(0);
  });
});
