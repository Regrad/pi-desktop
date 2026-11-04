import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { DataStore } from "./data-store.js";
import { PiManager } from "./pi-manager.js";
import { webBackend } from "./web-backend.js";
import { loadComfySettings } from "./comfy-client.js";
import type { Attachment } from "../shared/types.js";
import type { DeviceBroker } from "../resources/web-access/device-broker.mjs";
import type { WebBackend } from "../resources/web-access/server.mjs";

/** Separate stores and Pi subprocesses; client paths never become host working directories. */
export class RemoteRuntime {
  private readonly devices = new Map<string, Promise<{ store: DataStore; manager: PiManager; backend: WebBackend }>>();
  private readonly stopping = new Map<string, Promise<void>>();
  constructor(private readonly host: DataStore, private readonly appRoot: string, private readonly executable: string, private readonly publish: (channel: string, payload: unknown, id: string) => void) {}

  async backend(id: string, broker: DeviceBroker, credential: { url: string; token: string }): Promise<WebBackend> {
    await this.stopping.get(id);
    if (!broker.info(id)) throw new Error("ПК не привязан");
    if (!this.devices.has(id)) {
      const pending = this.create(id, broker, credential);
      this.devices.set(id, pending);
      void pending.catch(() => { if (this.devices.get(id) === pending) this.devices.delete(id); });
    }
    return (await this.devices.get(id)!).backend;
  }

  private async create(id: string, broker: DeviceBroker, credential: { url: string; token: string }) {
    const { collectMediaGrants } = await import(pathToFileURL(path.join(this.appRoot, "resources", "web-access", "media-grants.mjs")).href) as typeof import("../resources/web-access/media-grants.mjs");
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Некорректный ID устройства");
    const store = new DataStore(path.join(this.host.dataDir, "remote-chats", id), this.appRoot, this.executable, this.host.dataDir, broker.info(id)?.drives);
    await store.initialize();
    const grants = new Set<string>();
    // Load only this device's own tool-result history. Never scan other devices' sessions.
    for (const chat of [...store.snapshot().conversations, ...store.getArchivedConversations()]) if (chat.sessionFile) {
      const file = path.resolve(chat.sessionFile);
      if (!file.startsWith(path.resolve(store.sessionsDir) + path.sep)) throw new Error("Сессия удалённого чата вне его папки");
      const lines = (await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return ""; throw error; })).split("\n");
      for (const line of lines) if (line.trim()) {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message?.role === "toolResult" && /^(media_|comfyui_|desktop_show_image$)/.test(entry.message.toolName ?? "")) collectMediaGrants(entry.message, this.host.dataDir, grants);
      }
    }
    const connected = () => { const info = broker.info(id); if (!info?.connected) throw new Error("Клиентский ПК отключён; сервер не используется вместо него"); return info; };
    const manager = new PiManager(store, () => null, undefined, (channel, payload) => {
      const event = (payload as { event?: { type?: string; toolName?: string; result?: unknown; message?: { role?: string; toolName?: string } } })?.event;
      if (event?.type === "tool_execution_end" && /^(media_|comfyui_|desktop_show_image$)/.test(event.toolName ?? "")) collectMediaGrants(event.result, this.host.dataDir, grants);
      if (event?.type === "message_end" && event.message?.role === "toolResult" && /^(media_|comfyui_|desktop_show_image$)/.test(event.message.toolName ?? "")) collectMediaGrants(event.message, this.host.dataDir, grants);
      this.publish(channel, payload, id);
    }, async conversation => {
      const info = connected();
      const cwd = conversation.projectId ? store.getProject(conversation.projectId).path : info.cwd;
      const comfy = path.join(this.host.agentDir, "extensions", "pi-comfyui", "index.ts");
      const extensions = [path.join(this.appRoot, "resources", "remote-execution", "index.ts")];
      // Only the explicitly selected ComfyUI add-on is allowed to execute on the server.
      if (existsSync(comfy)) extensions.push(comfy);
      return { extensions, environment: {
        PI_DESKTOP_REMOTE: "1", PI_DESKTOP_REMOTE_URL: credential.url, PI_DESKTOP_REMOTE_TOKEN: credential.token,
        PI_DESKTOP_REMOTE_DEVICE: id, PI_DESKTOP_REMOTE_CWD: cwd,
        PI_DESKTOP_REMOTE_ROOTS: JSON.stringify(conversation.projectId ? store.getProject(conversation.projectId).paths : [cwd]),
        PI_DESKTOP_REMOTE_UPLOAD_DIR: path.join(store.dataDir, "web-attachments"),
      } };
    });
    const invoke = (operation: string, args: Record<string, unknown> = {}) => { connected(); return broker.invoke(id, operation, args); };
    const attachments = async (paths: string[]): Promise<Attachment[]> => {
      if (!Array.isArray(paths) || paths.length > 20 || paths.some(file => !path.win32.isAbsolute(file))) throw new Error("Неверные пути вложений");
      return Promise.all(paths.map(async file => {
        const image = /\.(png|jpe?g|webp)$/i.test(file);
        const input = image ? await invoke("read", { path: file }) : undefined;
        if (image && (!input.exists || input.unsupported)) throw new Error("Изображение отсутствует или больше 8 МБ");
        return { id: randomUUID(), name: path.win32.basename(file), path: file, ...(image ? { data: input.data, mimeType: /\.png$/i.test(file) ? "image/png" : /\.webp$/i.test(file) ? "image/webp" : "image/jpeg" } : {}) };
      }));
    };
    const instructions = async (projectId: string) => {
      const filePath = path.win32.join(store.getProject(projectId).path, "AGENTS.md");
      const input = await invoke("read", { path: filePath });
      if (input.unsupported) throw new Error("Инструкции слишком большие");
      return { projectId, filePath, content: input.exists ? new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(input.data, "base64")) : "", exists: Boolean(input.exists) };
    };
    const base = webBackend(store, manager, { mediaDataDir: this.host.dataDir, validateAttachments: items => {
      for (const item of items) if (!path.win32.isAbsolute(item.path)) throw new Error("Нужен путь клиентского ПК или загруженного вложения");
    }, methods: {
      getComfySettings: () => loadComfySettings(this.host.dataDir),
      getModuleSettings: () => this.host.getModuleSettings(),
      chooseProjectFolders: () => invoke("chooseFolders"),
      createProject: async (name: string, paths: string[]) => {
        if (typeof name !== "string" || !Array.isArray(paths) || !paths.length || paths.length > 20) throw new Error("Неверный проект");
        for (const file of paths) if (!path.win32.isAbsolute(file) || !(await invoke("stat", { path: file })).directory) throw new Error("Папка отсутствует на клиентском ПК");
        return store.addProject(name, paths);
      },
      refreshProjectSessions: (projectId: string) => store.refreshProjectSessions(projectId),
      renameProject: (projectId: string, name: string) => manager.renameProject(projectId, name),
      removeProject: async (projectId: string) => { await manager.removeProject(projectId); return true; },
      deleteConversation: async (chatId: string) => { await manager.deleteConversation(chatId); return true; },
      chooseAttachments: async () => attachments(await invoke("chooseFiles")),
      attachFilePaths: attachments,
      showItemInFolder: (file: string) => invoke("showFile", { path: file }),
      showGeneratedFile: async (kind: string, filename: string) => {
        if (!grants.has(`${kind}/${filename}`)) throw new Error("Файл не принадлежит этому устройству");
        connected(); return broker.invoke(id, "download", { url: `/api/agent/media/${kind}/${encodeURIComponent(filename)}`, filename }, { timeout: 3600000 });
      },
      getProjectInstructions: instructions,
      saveProjectInstructions: async (projectId: string, content: string) => {
        if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > 1048576) throw new Error("Некорректные инструкции");
        const current = await instructions(projectId);
        await invoke("write", { path: current.filePath, content }); manager.invalidateInstructions(projectId);
        return { ...current, content, exists: true };
      },
    } });
    const readOnly = new Set(["bootstrap", "openConversation", "searchConversations", "getGlobalPrompt", "getComfySettings", "getModelServers", "getModuleSettings", "uploadAttachment"]);
    const backend: WebBackend = {
      call: async (method, args) => { if (!readOnly.has(method)) connected(); return base.call(method, args); },
      media: async (kind, filename, method, range) => grants.has(`${kind}/${filename}`) ? base.media(kind, filename, method, range) : new Response(null, { status: 404 }),
    };
    return { store, manager, backend };
  }

  disconnect(id: string): void {
    const pending = this.devices.get(id); this.devices.delete(id);
    if (!pending) return;
    const operation = Promise.resolve(this.stopping.get(id)).then(async () => { await (await pending).manager.shutdown(); }).catch(error => { console.error("remote-runtime shutdown", error); });
    this.stopping.set(id, operation);
    void operation.finally(() => { if (this.stopping.get(id) === operation) this.stopping.delete(id); });
  }
  invalidateInstructions(): void { for (const runtime of this.devices.values()) void runtime.then(item => item.manager.invalidateInstructions()).catch(() => {}); }
  async close(): Promise<void> { for (const id of [...this.devices.keys()]) this.disconnect(id); await Promise.all(this.stopping.values()); }
}
