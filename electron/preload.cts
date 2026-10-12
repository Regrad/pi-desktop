import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { PiDesktopApi } from "../shared/types.js";

function subscribe(channel: string, listener: (...args: any[]) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const api: PiDesktopApi = {
  manageSkills: (id, command) => ipcRenderer.invoke("desktop:skills", id, command),
  getNotebookCharacterLimit: () => ipcRenderer.invoke("desktop:get-notebook-limit"),
  setNotebookCharacterLimit: (value) => ipcRenderer.invoke("desktop:set-notebook-limit", value),
  getWebAccessSettings: () => ipcRenderer.invoke("desktop:get-web-access-settings"),
  saveWebAccessSettings: (settings) => ipcRenderer.invoke("desktop:save-web-access-settings", settings),
  bootstrap: () => ipcRenderer.invoke("desktop:bootstrap"),
  chooseProjectFolders: () => ipcRenderer.invoke("desktop:choose-project-folders"),
  createProject: (name, paths) => ipcRenderer.invoke("desktop:create-project", name, paths),
  refreshProjectSessions: (projectId) => ipcRenderer.invoke("desktop:refresh-project-sessions", projectId),
  searchConversations: (query) => ipcRenderer.invoke("desktop:search-conversations", query),
  chooseAttachments: () => ipcRenderer.invoke("desktop:choose-attachments"),
  getDroppedFilePath: (file) => webUtils.getPathForFile(file),
  attachFilePaths: (paths) => ipcRenderer.invoke("desktop:attach-file-paths", paths),
  removeProject: (projectId) => ipcRenderer.invoke("desktop:remove-project", projectId),
  renameProject: (projectId, name) => ipcRenderer.invoke("desktop:rename-project", projectId, name),
  createConversation: (projectId) => ipcRenderer.invoke("desktop:create-conversation", projectId),
  openConversation: (conversationId) => ipcRenderer.invoke("desktop:open-conversation", conversationId),
  deleteConversation: (conversationId) => ipcRenderer.invoke("desktop:delete-conversation", conversationId),
  archiveConversation: (conversationId) => ipcRenderer.invoke("desktop:archive-conversation", conversationId),
  restoreConversation: (conversationId) => ipcRenderer.invoke("desktop:restore-conversation", conversationId),
  sendPrompt: (conversationId, message, attachments, behavior, requestPlan) =>
    ipcRenderer.invoke("pi:send-prompt", conversationId, message, attachments, behavior, requestPlan),
  queuePrompt: (conversationId, message, attachments, requestPlan) =>
    ipcRenderer.invoke("desktop:queue-prompt", conversationId, message, attachments, requestPlan),
  sendQueuedPrompt: (conversationId, promptId) =>
    ipcRenderer.invoke("desktop:send-queued-prompt", conversationId, promptId),
  removeQueuedPrompt: (conversationId, promptId) =>
    ipcRenderer.invoke("desktop:remove-queued-prompt", conversationId, promptId),
  abort: (conversationId) => ipcRenderer.invoke("pi:abort", conversationId),
  rewindConversation: (conversationId, entryId) => ipcRenderer.invoke("pi:rewind", conversationId, entryId),
  editLastMessage: (conversationId, entryId, text) => ipcRenderer.invoke("pi:edit-last-message", conversationId, entryId, text),
  setGoal: (id, objective, attachments, requestPlan) => ipcRenderer.invoke("pi:set-goal", id, objective, attachments, requestPlan),
  controlGoal: (id, action) => ipcRenderer.invoke("pi:control-goal", id, action),
  editGoal: (id, objective) => ipcRenderer.invoke("pi:edit-goal", id, objective),
  removePlan: (id) => ipcRenderer.invoke("pi:remove-plan", id),
  controlPlan: (id, action) => ipcRenderer.invoke("pi:control-plan", id, action),
  saveNotebook: (id, content, revision) => ipcRenderer.invoke("pi:save-notebook", id, content, revision),
  browserUi: (command) => ipcRenderer.invoke("desktop:browser", command),
  onBrowserChanged: (listener) => subscribe("desktop:browser-changed", listener),
  setModel: (conversationId, provider, modelId) =>
    ipcRenderer.invoke("pi:set-model", conversationId, provider, modelId),
  setThinkingLevel: (conversationId, level) =>
    ipcRenderer.invoke("pi:set-thinking", conversationId, level),
  setHostEditorText: (conversationId, text) =>
    ipcRenderer.invoke("pi:set-editor-text", conversationId, text),
  clearQueue: (conversationId) => ipcRenderer.invoke("pi:clear-queue", conversationId),
  compactConversation: (conversationId, customInstructions) => ipcRenderer.invoke("pi:compact", conversationId, customInstructions),
  reloadRuntime: (conversationId) => ipcRenderer.invoke("pi:reload", conversationId),
  renameConversation: (conversationId, title) =>
    ipcRenderer.invoke("desktop:rename-conversation", conversationId, title),
  respondToExtensionUi: (conversationId, response) =>
    ipcRenderer.invoke("pi:extension-ui-response", conversationId, response),
  getGlobalPrompt: () => ipcRenderer.invoke("desktop:get-global-prompt"),
  getComfySettings: () => ipcRenderer.invoke("desktop:get-comfy-settings"),
  saveComfySettings: (settings) => ipcRenderer.invoke("desktop:save-comfy-settings", settings),
  checkComfyConnection: (url) => ipcRenderer.invoke("desktop:check-comfy-connection", url),
  importComfyWorkflow: () => ipcRenderer.invoke("desktop:import-comfy-workflow"),
  saveGlobalPrompt: (prompt) => ipcRenderer.invoke("desktop:save-global-prompt", prompt),
  getProjectInstructions: (projectId) => ipcRenderer.invoke("desktop:get-project-instructions", projectId),
  saveProjectInstructions: (projectId, content) => ipcRenderer.invoke("desktop:save-project-instructions", projectId, content),
  getModelServers: () => ipcRenderer.invoke("desktop:get-model-servers"),
  discoverModelServer: (input) => ipcRenderer.invoke("desktop:discover-model-server", input),
  updateConfiguredModel: (input) => ipcRenderer.invoke("desktop:update-configured-model", input),
  deleteConfiguredModel: (providerId, modelId) => ipcRenderer.invoke("desktop:delete-configured-model", providerId, modelId),
  deleteModelServer: (providerId) => ipcRenderer.invoke("desktop:delete-model-server", providerId),
  getUpdateStatus: (force) => ipcRenderer.invoke("desktop:get-update-status", force),
  updateComponent: (id) => ipcRenderer.invoke("desktop:update-component", id),
  updateAllComponents: () => ipcRenderer.invoke("desktop:update-all-components"),
  getModuleSettings: () => ipcRenderer.invoke("desktop:get-module-settings"),
  setBuiltinModuleEnabled: (id, enabled) => ipcRenderer.invoke("desktop:set-builtin-module-enabled", id, enabled),
  addUserExtension: (kind) => ipcRenderer.invoke("desktop:add-user-extension", kind),
  removeUserExtension: (name) => ipcRenderer.invoke("desktop:remove-user-extension", name),
  showItemInFolder: (path) => ipcRenderer.invoke("desktop:show-item", path),
  showGeneratedFile: (kind, filename) => ipcRenderer.invoke("desktop:show-generated", kind, filename),
  openGeneratedLink: (url) => ipcRenderer.invoke("desktop:open-generated-link", url),
  onPiEvent: (listener) => subscribe("pi:event", listener),
  onExtensionUi: (listener) => subscribe("pi:extension-ui", listener),
  onConversationChanged: (listener) => subscribe("desktop:conversation-changed", listener),
  onControlSelect: (listener) => subscribe("desktop:control-select", listener),
  controlSelectionReady: (requestId) => ipcRenderer.send("desktop:control-selected", requestId),
};

contextBridge.exposeInMainWorld("piDesktop", api);
