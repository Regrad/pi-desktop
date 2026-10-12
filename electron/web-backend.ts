import type { DataStore } from "./data-store.js";
import type { PiManager } from "./pi-manager.js";
import type { Attachment, ThinkingLevel } from "../shared/types.js";
import { loadComfySettings } from "./comfy-client.js";
import { generatedMediaResponse } from "./generated-media.js";
import { nativeImage } from "electron";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { imageSize } from "image-size";

/** Browser calls are explicitly allowed here, not forwarded to arbitrary IPC. */
export function webBackend(store: DataStore, manager: PiManager, options?: { methods?: Record<string, (...args: any[]) => unknown>; mediaDataDir?: string; validateAttachments?: (attachments: Attachment[]) => void }) {
  const methods = {
    uploadAttachment: async (input: { name: string; data: string }): Promise<Attachment> => {
      if (!input || typeof input.name !== "string" || input.name.length > 255 || typeof input.data !== "string" || input.data.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw new Error("Неверное вложение");
      const bytes = Buffer.from(input.data, "base64");
      if (!bytes.length || bytes.length > 8 * 1024 * 1024) throw new Error("Вложение должно быть не больше 8 МБ");
      let dimensions;
      try { dimensions = imageSize(bytes); } catch { /* Non-image attachments are allowed. */ }
      if (dimensions && dimensions.width * dimensions.height > 40_000_000) throw new Error("Изображение слишком большое: максимум 40 мегапикселей");
      const id = randomUUID();
      const image = nativeImage.createFromBuffer(bytes);
      const folder = path.join(store.dataDir, "web-attachments");
      await mkdir(folder, { recursive: true });
      const extension = /^\.[a-z0-9]{1,10}$/i.test(path.extname(input.name)) ? path.extname(input.name) : ".bin";
      const file = path.join(folder, `${id}${image.isEmpty() ? extension : ".png"}`);
      const data = image.isEmpty() ? bytes : image.toPNG();
      await writeFile(file, data, { flag: "wx" });
      return { id, name: input.name, path: file, ...(!image.isEmpty() ? { mimeType: "image/png", data: data.toString("base64") } : {}) };
    },
    bootstrap: () => ({ ...store.snapshot(), archivedConversations: store.getArchivedConversations(), dataDir: store.dataDir, sessionsDir: store.sessionsDir }),
    createConversation: (id?: string) => manager.createConversation(id),
    openConversation: (id: string) => manager.inspectConversation(id),
    searchConversations: (query: string) => store.searchConversations(query),
    renameConversation: (id: string, title: string) => manager.renameConversation(id, title),
    archiveConversation: (id: string) => manager.archiveConversation(id),
    restoreConversation: (id: string) => manager.restoreConversation(id),
    sendPrompt: (id: string, message: string, attachments: Attachment[], behavior?: "steer" | "followUp") => manager.sendPrompt(id, message, attachments, behavior),
    queuePrompt: (id: string, message: string, attachments: Attachment[]) => manager.queuePrompt(id, message, attachments),
    sendQueuedPrompt: (id: string, prompt: string) => manager.sendQueuedPrompt(id, prompt),
    removeQueuedPrompt: (id: string, prompt: string) => manager.removeQueuedPrompt(id, prompt),
    abort: (id: string) => manager.abort(id),
    setGoal: (id: string, objective: string, attachments: Attachment[]) => manager.setGoal(id, objective, attachments),
    controlGoal: (id: string, action: "pause" | "resume" | "remove") => manager.controlGoal(id, action),
    controlPlan: (id: string, action: "pause" | "resume") => manager.controlPlan(id, action),
    editGoal: (id: string, objective: string) => manager.editGoal(id, objective),
    rewindConversation: (id: string, entryId: string) => manager.rewindConversation(id, entryId),
    editLastMessage: (id: string, entryId: string, text: string) => manager.editLastMessage(id, entryId, text),
    setModel: (id: string, provider: string, model: string) => manager.setModel(id, provider, model),
    setThinkingLevel: (id: string, level: ThinkingLevel) => manager.setThinkingLevel(id, level),
    setHostEditorText: (id: string, text: string) => manager.setHostEditorText(id, text),
    clearQueue: (id: string) => manager.clearQueue(id),
    compactConversation: (id: string, instructions?: string) => manager.compactConversation(id, instructions),
    reloadRuntime: (id: string) => manager.reloadRuntime(id),
    respondToExtensionUi: (id: string, response: Record<string, unknown>) => manager.respondToExtensionUi(id, response),
    getGlobalPrompt: () => store.getGlobalPrompt(),
    getProjectInstructions: (id: string) => store.getProjectInstructions(id),
    getComfySettings: () => loadComfySettings(store.dataDir),
    getModelServers: () => store.getModelServers(),
    getModuleSettings: () => store.getModuleSettings(),
    manageSkills: (id: string, command: import("../shared/skills.js").SkillsCommand) => manager.manageSkills(id, command),
    ...options?.methods,
  };
  return {
    async call(method: string, args: unknown[]): Promise<unknown> {
      if (!Object.hasOwn(methods, method)) throw new Error("Эта операция доступна только в приложении Pi Desktop");
      if (["sendPrompt", "queuePrompt", "setGoal"].includes(method)) {
        const [id, message, attachments, behavior] = args;
        if (typeof id !== "string" || typeof message !== "string" || !message.trim() || !Array.isArray(attachments) || attachments.length > 20 ||
          attachments.some((item: Attachment) => !item || typeof item.name !== "string" || typeof item.path !== "string" || typeof item.id !== "string" || (item.data !== undefined && typeof item.data !== "string")) ||
          (method === "sendPrompt" && behavior !== undefined && !["steer", "followUp"].includes(String(behavior)))) throw new Error("Неверное сообщение");
        options?.validateAttachments?.(attachments as Attachment[]);
      }
      return Reflect.apply(methods[method as keyof typeof methods], undefined, args);
    },
    media(kind: string, filename: string, method: string, range?: string) {
      return generatedMediaResponse(options?.mediaDataDir ?? store.dataDir, new Request(`pi-generated://${kind}/${encodeURIComponent(filename)}`, {
        method, headers: range ? { range } : {},
      }));
    },
  };
}
