import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import type { ConversationRecord, ConversationRun, ModelInfo, ProjectRecord, ThinkingLevel } from "../shared/types.js";

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

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export class DataStore {
  readonly dataDir: string;
  readonly agentDir: string;
  readonly sessionsDir: string;
  readonly runsDir: string;
  private readonly statePath: string;
  private state: DesktopState = structuredClone(EMPTY_STATE);
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly appRoot: string,
    private readonly runtimeExecutable: string,
  ) {
    this.dataDir = dataDir;
    this.agentDir = path.join(dataDir, "agent");
    this.sessionsDir = resolveStandardSessionsDir();
    this.runsDir = path.join(dataDir, "runs");
    this.statePath = path.join(dataDir, "desktop-state.json");
  }

  async initialize(): Promise<void> {
    await mkdir(this.agentDir, { recursive: true });
    await mkdir(this.sessionsDir, { recursive: true });
    await mkdir(this.runsDir, { recursive: true });
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
    for (const fileName of ["models.json", "mcp.json", "auth.json", "APPEND_SYSTEM.md", "web-search.json"]) {
      const destination = path.join(this.agentDir, fileName);
      try {
        await readFile(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await copyFile(path.join(templateDir, fileName), destination);
      }
    }
    await this.migrateManagedMcpServers(path.join(this.agentDir, "mcp.json"));
    await this.migrateLegacySystemPrompt(path.join(this.agentDir, "APPEND_SYSTEM.md"));

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
    const managedPackages = [
      ...packageNames.map((name) => path.join(this.appRoot, "node_modules", name)),
      path.join(this.appRoot, "resources", "pi-lens-all-tools"),
    ];
    const configuredPackages = Array.isArray(settings.packages)
      ? settings.packages.filter((item): item is string => typeof item === "string")
      : [];
    const customPackages = configuredPackages.filter((item) => !isManagedPackage(item, packageNames));
    settings.packages = [...managedPackages, ...customPackages];
    await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");

    const extensionsDir = path.join(this.agentDir, "extensions");
    await mkdir(extensionsDir, { recursive: true });
    const repairConfig = path.join(extensionsDir, "pi-tool-repair.json");
    if (!existsSync(repairConfig)) {
      await copyFile(path.join(templateDir, "pi-tool-repair.json"), repairConfig);
    }
    await this.migrateLegacyToolRepairConfig(repairConfig);
  }

  private async migrateManagedMcpServers(configPath: string): Promise<void> {
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      settings?: Record<string, unknown>;
      mcpServers?: Record<string, Record<string, unknown>>;
    };
    config.settings = { ...config.settings, requestTimeoutMs: 86_400_000 };
    const computerUse = config.mcpServers?.["computer-use"];
    const args = Array.isArray(computerUse?.args) ? computerUse.args : [];
    const isManagedNpxEntry = computerUse?.command === "npx"
      && args.some((item) => typeof item === "string" && item.startsWith("@zavora-ai/computer-use-mcp@"));
    const isManagedDirectEntry = args.some((item) => typeof item === "string"
      && item.replace(/\\/g, "/").includes("/@zavora-ai/computer-use-mcp/dist/server.js"));
    const isTemplateEntry = computerUse?.command === "${PI_DESKTOP_EXECUTABLE}";
    const directToolsEnabled = computerUse?.directTools !== false;
    if (isManagedNpxEntry || isManagedDirectEntry || isTemplateEntry) {
      config.mcpServers!["computer-use"] = {
        command: this.runtimeExecutable,
        args: [path.join(this.appRoot, "node_modules", "@zavora-ai", "computer-use-mcp", "dist", "server.js")],
        env: { ELECTRON_RUN_AS_NODE: "1" },
        directTools: directToolsEnabled,
      };
    }
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  private async migrateLegacySystemPrompt(promptPath: string): Promise<void> {
    const current = (await readFile(promptPath, "utf8")).trim();
    if (current !== "Перед любыми правками файлов ты спрашиваешь у пользователя разрешение.") return;
    await writeFile(promptPath, "Before modifying any files, ask the user for permission.\n", "utf8");
  }

  private async migrateLegacyToolRepairConfig(configPath: string): Promise<void> {
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      grammarRepair?: { enabled?: boolean; grammars?: unknown; leakModels?: unknown };
    };
    const repair = config.grammarRepair;
    const isLegacyQwenGlobal = repair?.enabled === true
      && Array.isArray(repair.grammars)
      && repair.grammars.length === 1
      && repair.grammars[0] === "qwen"
      && repair.leakModels === undefined;
    if (!isLegacyQwenGlobal || !repair) return;
    repair.enabled = false;
    repair.leakModels = ["qwen"];
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
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

  async searchConversations(query: string): Promise<string[]> {
    const normalized = query.toLocaleLowerCase().trim();
    if (!normalized) return this.state.conversations.filter((item) => !item.archived).map((item) => item.id);
    const matches: string[] = [];
    for (const conversation of this.state.conversations) {
      if (conversation.archived) continue;
      if (conversation.title.toLocaleLowerCase().includes(normalized)) {
        matches.push(conversation.id);
        continue;
      }
      if (!conversation.sessionFile || !existsSync(conversation.sessionFile)) continue;
      try {
        const content = await readFile(conversation.sessionFile, "utf8");
        if (content.toLocaleLowerCase().includes(normalized)) matches.push(conversation.id);
      } catch {
        // A single unavailable session must not break the entire search.
      }
    }
    return matches;
  }

  async getMcpDirectToolSelectors(): Promise<string[]> {
    const config = JSON.parse(await readFile(path.join(this.agentDir, "mcp.json"), "utf8")) as {
      settings?: { directTools?: boolean };
      mcpServers?: Record<string, { disabled?: boolean; directTools?: boolean | string[] }>;
    };
    const selectors: string[] = [];
    for (const [serverName, definition] of Object.entries(config.mcpServers ?? {})) {
      if (definition.disabled) continue;
      const directTools = definition.directTools ?? config.settings?.directTools ?? false;
      if (directTools === true) selectors.push(serverName);
      else if (Array.isArray(directTools)) {
        selectors.push(...directTools.map((toolName) => `${serverName}/${toolName}`));
      }
    }
    return selectors;
  }

  async getAgentConfiguration(): Promise<{
    models: ModelInfo[];
    defaultProvider?: string;
    defaultModel?: string;
    defaultThinkingLevel: ThinkingLevel;
  }> {
    const [modelsConfig, settings] = await Promise.all([
      readFile(path.join(this.agentDir, "models.json"), "utf8").then((content) => JSON.parse(content) as {
        providers?: Record<string, { models?: Array<Record<string, unknown>> }>;
      }),
      readFile(path.join(this.agentDir, "settings.json"), "utf8").then((content) => JSON.parse(content) as Record<string, unknown>),
    ]);
    const models: ModelInfo[] = [];
    for (const [provider, definition] of Object.entries(modelsConfig.providers ?? {})) {
      for (const model of definition.models ?? []) {
        if (typeof model.id !== "string") continue;
        const reasoning = model.reasoning === true;
        const levelMap = model.thinkingLevelMap && typeof model.thinkingLevelMap === "object"
          ? model.thinkingLevelMap as Record<string, unknown>
          : undefined;
        const thinkingLevels = !reasoning
          ? ["off" as ThinkingLevel]
          : levelMap
            ? THINKING_LEVELS.filter((level) => Object.hasOwn(levelMap, level) && levelMap[level] !== null)
            : [...THINKING_LEVELS];
        models.push({
          provider,
          id: model.id,
          name: typeof model.name === "string" ? model.name : undefined,
          contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : undefined,
          reasoning,
          thinkingLevels: thinkingLevels.length ? thinkingLevels : ["off"],
        });
      }
    }
    const configuredThinking = settings.defaultThinkingLevel;
    return {
      models,
      defaultProvider: typeof settings.defaultProvider === "string" ? settings.defaultProvider : undefined,
      defaultModel: typeof settings.defaultModel === "string" ? settings.defaultModel : undefined,
      defaultThinkingLevel: typeof configuredThinking === "string" && THINKING_LEVELS.includes(configuredThinking as ThinkingLevel)
        ? configuredThinking as ThinkingLevel
        : "off",
    };
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

  async renameProject(projectId: string, name: string): Promise<ProjectRecord> {
    const project = this.getProject(projectId);
    const normalized = name.replace(/\s+/g, " ").trim();
    if (!normalized) throw new Error("Название проекта не может быть пустым");
    project.name = normalized;
    project.lastOpenedAt = new Date().toISOString();
    await this.save();
    return structuredClone(project);
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
      status: "idle",
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
    await unlink(this.getRunPath(conversationId)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async getConversationRun(conversationId: string): Promise<ConversationRun | undefined> {
    try {
      return JSON.parse(await readFile(this.getRunPath(conversationId), "utf8")) as ConversationRun;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async saveConversationRun(conversationId: string, run: ConversationRun): Promise<void> {
    const destination = this.getRunPath(conversationId);
    const tempPath = `${destination}.tmp`;
    const content = `${JSON.stringify(run, null, 2)}\n`;
    await this.enqueueWrite(async () => {
      await mkdir(this.runsDir, { recursive: true });
      await writeFile(tempPath, content, "utf8");
      await rename(tempPath, destination);
    });
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
    const tempPath = `${this.statePath}.tmp`;
    const content = `${JSON.stringify(this.state, null, 2)}\n`;
    await this.enqueueWrite(async () => {
      await mkdir(this.dataDir, { recursive: true });
      await writeFile(tempPath, content, "utf8");
      await rename(tempPath, this.statePath);
    });
  }

  private getRunPath(conversationId: string): string {
    return path.join(this.runsDir, `${conversationId}.json`);
  }

  private enqueueWrite(task: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(task, task);
    this.writeQueue = next.catch(() => undefined);
    return next;
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

function isManagedPackage(value: string, packageNames: string[]): boolean {
  const normalized = value.replaceAll("/", "\\").toLocaleLowerCase();
  if (normalized.endsWith("\\resources\\pi-lens-all-tools") || normalized.endsWith("\\local-packages\\pi-lens-all-tools")) {
    return true;
  }
  return packageNames.some((name) =>
    normalized === `npm:${name}` ||
    normalized.endsWith(`\\node_modules\\${name}`),
  );
}

function sessionTitle(session: SessionInfo): string {
  const source = session.name?.trim() || session.firstMessage.trim() || "Новый чат";
  return source.replace(/\s+/g, " ").slice(0, 64);
}
