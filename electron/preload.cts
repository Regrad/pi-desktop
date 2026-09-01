import { contextBridge, ipcRenderer } from "electron";
import type { PiDesktopApi } from "../shared/types.js";

function subscribe(channel: string, listener: (...args: any[]) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: PiDesktopApi = {
  bootstrap: () => ipcRenderer.invoke("desktop:bootstrap"),
  chooseProjectFolders: () => ipcRenderer.invoke("desktop:choose-project-folders"),
  createProject: (name, paths) => ipcRenderer.invoke("desktop:create-project", name, paths),
  refreshProjectSessions: (projectId) => ipcRenderer.invoke("desktop:refresh-project-sessions", projectId),
  searchConversations: (query) => ipcRenderer.invoke("desktop:search-conversations", query),
  chooseAttachments: () => ipcRenderer.invoke("desktop:choose-attachments"),
  removeProject: (projectId) => ipcRenderer.invoke("desktop:remove-project", projectId),
  renameProject: (projectId, name) => ipcRenderer.invoke("desktop:rename-project", projectId, name),
  createConversation: (projectId) => ipcRenderer.invoke("desktop:create-conversation", projectId),
  openConversation: (conversationId) => ipcRenderer.invoke("desktop:open-conversation", conversationId),
  deleteConversation: (conversationId) => ipcRenderer.invoke("desktop:delete-conversation", conversationId),
  archiveConversation: (conversationId) => ipcRenderer.invoke("desktop:archive-conversation", conversationId),
  restoreConversation: (conversationId) => ipcRenderer.invoke("desktop:restore-conversation", conversationId),
  sendPrompt: (conversationId, message, attachments, behavior) =>
    ipcRenderer.invoke("pi:send-prompt", conversationId, message, attachments, behavior),
  abort: (conversationId) => ipcRenderer.invoke("pi:abort", conversationId),
  setModel: (conversationId, provider, modelId) =>
    ipcRenderer.invoke("pi:set-model", conversationId, provider, modelId),
  setThinkingLevel: (conversationId, level) =>
    ipcRenderer.invoke("pi:set-thinking", conversationId, level),
  setHostEditorText: (conversationId, text) =>
    ipcRenderer.invoke("pi:set-editor-text", conversationId, text),
  clearQueue: (conversationId) => ipcRenderer.invoke("pi:clear-queue", conversationId),
  renameConversation: (conversationId, title) =>
    ipcRenderer.invoke("desktop:rename-conversation", conversationId, title),
  respondToExtensionUi: (conversationId, response) =>
    ipcRenderer.invoke("pi:extension-ui-response", conversationId, response),
  getGlobalPrompt: () => ipcRenderer.invoke("desktop:get-global-prompt"),
  saveGlobalPrompt: (prompt) => ipcRenderer.invoke("desktop:save-global-prompt", prompt),
  getModelServers: () => ipcRenderer.invoke("desktop:get-model-servers"),
  discoverModelServer: (input) => ipcRenderer.invoke("desktop:discover-model-server", input),
  updateConfiguredModel: (input) => ipcRenderer.invoke("desktop:update-configured-model", input),
  deleteConfiguredModel: (providerId, modelId) => ipcRenderer.invoke("desktop:delete-configured-model", providerId, modelId),
  deleteModelServer: (providerId) => ipcRenderer.invoke("desktop:delete-model-server", providerId),
  showItemInFolder: (path) => ipcRenderer.invoke("desktop:show-item", path),
  onPiEvent: (listener) => subscribe("pi:event", listener),
  onExtensionUi: (listener) => subscribe("pi:extension-ui", listener),
  onConversationChanged: (listener) => subscribe("desktop:conversation-changed", listener),
};

contextBridge.exposeInMainWorld("piDesktop", api);
