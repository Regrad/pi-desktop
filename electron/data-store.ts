import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { ConversationRecord, ProjectRecord } from "../shared/types.js";

interface DesktopState {
  version: 3;
  projects: ProjectRecord[];
  conversations: ConversationRecord[];
  activeProjectId?: string;
  activeConversationId?: string;
}

const EMPTY_STATE: DesktopState = {
  version: 3,
  projects: [],
  conversations: [],
};

export class DataStore {
  readonly dataDir: string;
  readonly agentDir: string;
  readonly sessionsDir: string;
  private readonly statePath: string;
  private state: DesktopState = structuredClone(EMPTY_STATE);

  constructor(dataDir: string, private readonly appRoot: string) {
    this.dataDir = dataDir;
    this.agentDir = path.join(dataDir, "agent");
    this.sessionsDir = resolveStandardSessionsDir();
    this.statePath = path.join(dataDir, "desktop-state.json");
  }

  async initialize(): Promise<void> {
    await mkdir(this.agentDir, { recursive: true });
    await mkdir(this.sessionsDir, { recursive: true });
    await this.initializeAgentDirectory();
    try {
      const parsed = JSON.parse(await readFile(this.statePath, "utf8")) as DesktopState;
      this.state = {
        ...EMPTY_STATE,
        ...parsed,
        version: 3,
        projects: Array.isArray(parsed.projects)
          ? parsed.projects.map((project) => {
              const legacyPath = typeof project.path === "string" ? project.path : "";
              const legacyPaths = (project as ProjectRecord & { paths?: unknown }).paths;
              const projectPaths = Array.isArray(legacyPaths)
                ? legacyPaths.filter((item): item is string => typeof item === "string" && item.length > 0)
                : [];
              const paths = [...new Set(projectPaths.length ? projectPaths : legacyPath ? [legacyPath] : [])]
                .map((item) => path.resolve(item));
              return { ...project, path: paths[0] ?? legacyPath, paths };
            })
          : [],
        conversations: Array.isArray(parsed.conversations)
          ? parsed.conversations.map((conversation) => {
              const sessionFile = conversation.sessionFile && existsSync(conversation.sessionFile)
                ? conversation.sessionFile
                : undefined;
              return {
                ...conversation,
                ...(sessionFile ? { sessionFile } : { sessionFile: undefined }),
                status: conversation.status === "error" ? "error" : "idle",
              };
            })
          : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.save();
    }
    await this.refreshAllProjectSessions();
  }

  private async initializeAgentDirectory(): Promise<void> {
    const templateDir = path.join(this.appRoot, "resources", "agent-template");
    for (const fileName of ["models.json", "mcp.json", "auth.json", "APPEND_SYSTEM.md"]) {
      const destination = path.join(this.agentDir, fileName);
      try {
        await readFile(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await copyFile(path.join(templateDir, fileName), destination);
      }
    }

    const settingsPath = path.join(this.agentDir, "settings.json");
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      settings = JSON.parse(await readFile(path.join(templateDir, "settings.json"), "utf8")) as Record<string, unknown>;
    }

    const packageNames = [
      "pi-web-access",
      "pi-tool-repair",
      "pi-llama-cpp-stats",
      "pi-token-speed",
      "pi-mcp-adapter",
      "pi-lens",
      "pi-loop-police",
    ];
    settings.packages = [
      ...packageNames.map((name) => path.join(this.appRoot, "node_modules", name)),
      path.join(this.appRoot, "resources", "pi-lens-all-tools"),
    ];
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  }

  snapshot(): DesktopState {
    return structuredClone({
      ...this.state,
      conversations: this.state.conversations.filter((conversation) => !conversation.archived),
      activeConversationId: this.state.conversations.some(
        (conversation) => conversation.id === this.state.activeConversationId && !conversation.archived,
      ) ? this.state.activeConversationId : undefined,
    });
  }

  getArchivedConversations(): ConversationRecord[] {
    return this.state.conversations
      .filter((conversation) => conversation.archived)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((conversation) => structuredClone(conversation));
  }

  getProject(projectId: string): ProjectRecord {
    const project = this.state.projects.find((item) => item.id === projectId);
    if (!project) throw new Error("Проект не найден");
    return project;
  }

  getConversation(conversationId: string): ConversationRecord {
    const conversation = this.state.conversations.find((item) => item.id === conversationId);
    if (!conversation) throw new Error("Чат не найден");
    return conversation;
  }

  async addProject(name: string, folderPaths: string[]): Promise<ProjectRecord> {
    const canonicalPaths = [...new Set(folderPaths.map((item) => path.resolve(item)))];
    if (!canonicalPaths.length) throw new Error("Добавьте хотя бы одну папку проекта");
    const existing = this.state.projects.find(
      (item) => pathsEqual(item.path, canonicalPaths[0]),
    );
    const now = new Date().toISOString();
    if (existing) {
      existing.paths = canonicalPaths;
      existing.path = canonicalPaths[0];
      existing.lastOpenedAt = now;
      this.state.activeProjectId = existing.id;
      await this.refreshProjectSessions(existing.id);
      return structuredClone(existing);
    }

    const project: ProjectRecord = {
      id: randomUUID(),
      name: name.trim() || path.basename(canonicalPaths[0]) || canonicalPaths[0],
      path: canonicalPaths[0],
      paths: canonicalPaths,
      addedAt: now,
      lastOpenedAt: now,
    };
    this.state.projects.unshift(project);
    this.state.activeProjectId = project.id;
    this.state.activeConversationId = undefined;
    await this.refreshProjectSessions(project.id);
    return structuredClone(project);
  }

  async refreshProjectSessions(projectId: string): Promise<ConversationRecord[]> {
    const project = this.getProject(projectId);
    const sessionDir = this.getSessionDir(project.path);
    const sessions = await SessionManager.list(project.path, sessionDir);
    for (const session of sessions) this.mergeSession(project.id, session);
    await this.save();
    return this.state.conversations
      .filter((conversation) => conversation.projectId === projectId && !conversation.archived)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((conversation) => structuredClone(conversation));
  }

  async refreshAllProjectSessions(): Promise<void> {
    for (const project of this.state.projects) {
      const sessions = await SessionManager.list(project.path, this.getSessionDir(project.path));
      for (const session of sessions) this.mergeSession(project.id, session);
    }
    await this.save();
  }

  getSessionDir(cwd: string): string {
    const resolvedCwd = path.resolve(cwd);
    const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    return path.join(this.sessionsDir, safePath);
  }

  async removeProject(projectId: string): Promise<string[]> {
    const conversationIds = this.state.conversations
      .filter((item) => item.projectId === projectId)
      .map((item) => item.id);
    this.state.projects = this.state.projects.filter((item) => item.id !== projectId);
    this.state.conversations = this.state.conversations.filter((item) => item.projectId !== projectId);
    if (this.state.activeProjectId === projectId) {
      this.state.activeProjectId = this.state.projects[0]?.id;
      this.state.activeConversationId = undefined;
    }
    await this.save();
    return conversationIds;
  }

  async createConversation(projectId?: string): Promise<ConversationRecord> {
    if (projectId) this.getProject(projectId);
    const now = new Date().toISOString();
    const conversation: ConversationRecord = {
      id: randomUUID(),
      ...(projectId ? { projectId } : {}),
      title: "Новый чат",
      createdAt: now,
      updatedAt: now,
      status: "starting",
    };
    this.state.conversations.unshift(conversation);
    this.state.activeProjectId = projectId;
    this.state.activeConversationId = conversation.id;
    await this.save();
    return structuredClone(conversation);
  }

  async updateConversation(
    conversationId: string,
    changes: Partial<Omit<ConversationRecord, "id" | "projectId" | "createdAt">>,
  ): Promise<ConversationRecord> {
    const conversation = this.getConversation(conversationId);
    Object.assign(conversation, changes, { updatedAt: new Date().toISOString() });
    await this.save();
    return structuredClone(conversation);
  }

  async activateConversation(conversationId: string): Promise<void> {
    const conversation = this.getConversation(conversationId);
    this.state.activeProjectId = conversation.projectId;
    this.state.activeConversationId = conversationId;
    if (conversation.projectId) {
      const project = this.getProject(conversation.projectId);
      project.lastOpenedAt = new Date().toISOString();
    }
    await this.save();
  }

  async getConversationWorkingDirectory(conversation: ConversationRecord): Promise<string> {
    if (conversation.projectId) return this.getProject(conversation.projectId).path;
    const workspace = path.join(this.dataDir, "chats", conversation.id, "workspace");
    await mkdir(workspace, { recursive: true });
    return workspace;
  }

  async getConversationWorkspacePaths(conversation: ConversationRecord): Promise<string[]> {
    if (conversation.projectId) return [...this.getProject(conversation.projectId).paths];
    return [await this.getConversationWorkingDirectory(conversation)];
  }

  async deleteConversation(conversationId: string): Promise<void> {
    this.getConversation(conversationId);
    this.state.conversations = this.state.conversations.filter((item) => item.id !== conversationId);
    if (this.state.activeConversationId === conversationId) {
      this.state.activeConversationId = undefined;
    }
    await this.save();
  }

  async setConversationArchived(conversationId: string, archived: boolean): Promise<ConversationRecord> {
    const conversation = this.getConversation(conversationId);
    conversation.archived = archived;
    conversation.status = "idle";
    conversation.updatedAt = new Date().toISOString();
    if (archived && this.state.activeConversationId === conversationId) {
      this.state.activeConversationId = undefined;
    }
    await this.save();
    return structuredClone(conversation);
  }

  assertManagedSessionFile(sessionFile: string): string {
    const resolved = path.resolve(sessionFile);
    const relative = path.relative(this.sessionsDir, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.extname(resolved).toLocaleLowerCase() !== ".jsonl") {
      throw new Error("Некорректный файл сессии Pi: удаление отменено");
    }
    return resolved;
  }

  private mergeSession(projectId: string, session: SessionInfo): void {
    const normalizedSessionPath = normalizePathKey(session.path);
    const existing = this.state.conversations.find((conversation) =>
      conversation.sessionFile
        ? normalizePathKey(conversation.sessionFile) === normalizedSessionPath
        : conversation.id === session.id,
    );
    const title = sessionTitle(session);
    if (existing) {
      existing.projectId = projectId;
      existing.title = title;
      existing.sessionFile = session.path;
      existing.createdAt = session.created.toISOString();
      existing.updatedAt = session.modified.toISOString();
      return;
    }
    this.state.conversations.push({
      id: session.id,
      projectId,
      title,
      sessionFile: session.path,
      createdAt: session.created.toISOString(),
      updatedAt: session.modified.toISOString(),
      status: "idle",
    });
  }

  private async save(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const tempPath = `${this.statePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(tempPath, this.statePath);
  }
}

function resolveStandardSessionsDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  let agentDir: string;
  if (!configured) agentDir = path.join(homedir(), ".pi", "agent");
  else if (configured === "~") agentDir = homedir();
  else if (configured.startsWith("~/") || configured.startsWith("~\\")) {
    agentDir = path.join(homedir(), configured.slice(2));
  } else agentDir = path.resolve(configured);
  return path.join(agentDir, "sessions");
}

function normalizePathKey(value: string): string {
  return path.resolve(value).replaceAll("/", "\\").toLocaleLowerCase();
}

function pathsEqual(left: string, right: string): boolean {
  return normalizePathKey(left) === normalizePathKey(right);
}

function sessionTitle(session: SessionInfo): string {
  const source = session.name?.trim() || session.firstMessage.trim() || "Новый чат";
  return source.replace(/\s+/g, " ").slice(0, 64);
}
