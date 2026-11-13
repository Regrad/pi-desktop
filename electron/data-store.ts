import { createHash, randomUUID } from "node:crypto";
import { atomicStateWrite } from "./atomic-state.js";
import { notebookLimit, validateNotebookLimit } from "../shared/notebook.js";
import { migrateLegacyAdapterConfig, parseMcpConfiguration } from "../shared/mcp-config.js";
import { existsSync } from "node:fs";
import { constants } from "node:fs";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { listSessions } from "./session-read.js";
import { sessionDirectoryStamp } from "./session-index.js";
import type {
  Attachment,
  BuiltinModuleId,
  ConfiguredModelServer,
  ConfiguredModelUpdate,
  CompactionRecord,
  ConversationRecord,
  ConversationRun,
  ModelInfo,
  ModelServerDiscoveryInput,
  ModelServerDiscoveryResult,
  ModuleSettings,
  ProjectInstructions,
  ProjectRecord,
  QueuedPrompt,
  ThinkingLevel,
} from "../shared/types.js";
import {
  configuredServerView,
  discoverProvider,
  normalizeServer,
  type DiscoveredProviderConfiguration,
} from "./model-server-discovery.js";
import { migratePortableSessions, portableSessionsDir, storedSessionReference } from "./portable-sessions.js";
import { ensureComfyAddon } from "./comfy-addon.js";
import { chatDirectory, migrateChatFiles } from "./chat-storage.js";

interface DesktopState {
  version: 4;
  notebookCharacterLimit?: number;
  projects: ProjectRecord[];
  conversations: ConversationRecord[];
  queuedPrompts: Record<string, QueuedPrompt[]>;
  compactions: Record<string, CompactionRecord[]>;
  activeProjectId?: string;
  activeConversationId?: string;
  sessionIndex?: Record<string, string>;
}

interface ModelsFileConfig {
  providers?: Record<string, Record<string, unknown>>;
  desktopModelOverrides?: Record<string, Record<string, Record<string, unknown>>>;
  desktopHiddenModels?: Record<string, string[]>;
  desktopManagedProviders?: string[];
}

const EMPTY_STATE: DesktopState = {
  version: 4,
  projects: [],
  conversations: [],
  queuedPrompts: {},
  compactions: {},
};

const DEFAULT_APPEND_SYSTEM_PROMPT =
  "Before modifying any files, ask the user for permission.\n";

const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const MANAGED_PACKAGE_NAMES = [
  "pi-web-access",
  "pi-tool-repair",
  "pi-llama-cpp-stats",
  "pi-mcp-adapter",
  "pi-lens",
] as const;
const RETIRED_PACKAGE_NAMES = ["pi-token-speed", "pi-loop-police"];
const MANAGED_RESOURCE_NAMES = [
  "pi-single-slot-guard",
  "pi-llama-generation-speed",
  "pi-loop-police",
];
// Remove old managed activation packages without touching custom add-ons.
const RETIRED_RESOURCE_NAMES = ["pi-lens-all-tools"];

const BUILTIN_MODULES: Array<{
  id: BuiltinModuleId;
  name: string;
  description: string;
  kind: "package" | "resource";
  dependsOn?: BuiltinModuleId;
}> = [
  {
    id: "pi-web-access",
    name: "Web Access",
    description: "Поиск и чтение веб-страниц.",
    kind: "package",
  },
  {
    id: "pi-tool-repair",
    name: "Tool Repair",
    description: "Исправление некорректных вызовов инструментов.",
    kind: "package",
  },
  {
    id: "pi-llama-cpp-stats",
    name: "llama.cpp Stats",
    description: "Прогресс обработки промпта llama.cpp.",
    kind: "package",
  },
  {
    id: "pi-mcp-adapter",
    name: "MCP Adapter",
    description: "Подключение MCP-серверов и их инструментов.",
    kind: "package",
  },
  {
    id: "pi-lens",
    name: "Pi Lens",
    description: "LSP, линтеры и анализ кода.",
    kind: "package",
  },
  {
    id: "pi-single-slot-guard",
    name: "Single Slot Guard",
    description: "Защищает KV-кэш сервера с одним слотом.",
    kind: "resource",
    dependsOn: "pi-web-access",
  },
  {
    id: "pi-llama-generation-speed",
    name: "Generation Speed",
    description: "Текущая и средняя скорость генерации llama.cpp.",
    kind: "resource",
  },
  {
    id: "pi-loop-police",
    name: "Loop Police",
    description: "Настроенная защита от реальных циклов модели.",
    kind: "resource",
  },
];

const DEFAULT_BUILTIN_MODULES = Object.fromEntries(
  BUILTIN_MODULES.map((module) => [module.id, true]),
) as Record<BuiltinModuleId, boolean>;

export class DataStore {
  readonly dataDir: string;
  readonly agentDir: string;
  readonly sessionsDir: string;
  readonly runsDir: string;
  private readonly statePath: string;
  private readonly moduleSettingsPath: string;
  private state: DesktopState = structuredClone(EMPTY_STATE);
  private builtinModules: Record<BuiltinModuleId, boolean> = {
    ...DEFAULT_BUILTIN_MODULES,
  };
  private writeQueue: Promise<void> = Promise.resolve();
  private modelsMutationQueue: Promise<unknown> = Promise.resolve();
  private modelsRefreshedAt = 0;
  private modelsRefresh?: Promise<void>;
  private sessionRefreshes = new Map<string, Promise<void>>();

  constructor(
    dataDir: string,
    private readonly appRoot: string,
    private readonly runtimeExecutable: string,
    private readonly sharedDataDir?: string,
    private readonly remoteRoots?: string[],
  ) {
    this.dataDir = dataDir;
    this.agentDir = path.join(sharedDataDir ?? dataDir, "agent");
    this.sessionsDir = portableSessionsDir(dataDir);
    this.runsDir = path.join(dataDir, "runs");
    this.statePath = path.join(dataDir, "desktop-state.json");
    this.moduleSettingsPath = path.join(dataDir, "builtin-modules.json");
  }

  async initialize(options: { refreshSessions?: boolean } = {}): Promise<void> {
    await mkdir(this.agentDir, { recursive: true });
    await mkdir(this.sessionsDir, { recursive: true });
    await mkdir(this.runsDir, { recursive: true });
    if (!this.sharedDataDir) {
      await this.loadBuiltinModuleSettings();
      await this.initializeAgentDirectory();
    }
    let loadedState = false;
    try {
      const parsed = JSON.parse(
        await readFile(this.statePath, "utf8"),
      ) as DesktopState;
      loadedState = true;
      if (Array.isArray(parsed.conversations)) {
        const migrated = await migratePortableSessions(this.dataDir, parsed.conversations,
          this.sharedDataDir ? this.sessionsDir : resolveStandardSessionsDir());
        parsed.conversations = migrated.conversations;
        if (migrated.missing.length) console.warn("Недоступные сессии Pi:", migrated.missing);
      }
      this.state = {
        ...EMPTY_STATE,
        ...parsed,
        version: 4,
        projects: Array.isArray(parsed.projects)
          ? parsed.projects.map((project) => {
              const legacyPath =
                typeof project.path === "string" ? project.path : "";
              const legacyPaths = (
                project as ProjectRecord & { paths?: unknown }
              ).paths;
              const projectPaths = Array.isArray(legacyPaths)
                ? legacyPaths.filter(
                    (item): item is string =>
                      typeof item === "string" && item.length > 0,
                  )
                : [];
              const paths = [
                ...new Set(
                  projectPaths.length
                    ? projectPaths
                    : legacyPath
                      ? [legacyPath]
                      : [],
                ),
              ].map((item) => path.resolve(item));
              return { ...project, path: paths[0] ?? legacyPath, paths };
            })
          : [],
        conversations: Array.isArray(parsed.conversations)
          ? parsed.conversations.map((conversation) => {
              const sessionFile = conversation.sessionFile;
              return {
                ...conversation,
                plan: conversation.plan?.execution === "active"
                  ? { ...conversation.plan, execution: "paused", revision: conversation.plan.revision + 1,
                    updatedAt: new Date().toISOString(),
                    explanation: "Приложение перезапущено. Дайте команду продолжить работу по плану." }
                  : conversation.plan ? { ...conversation.plan, execution: "paused" } : undefined,
                goal:
                  conversation.goal?.status === "active"
                    ? {
                        ...conversation.goal,
                        status: "paused",
                        updatedAt: new Date().toISOString(),
                        evidence:
                          "Приложение перезапущено. Нажмите «Продолжить».",
                      }
                    : conversation.goal,
                ...(sessionFile ? { sessionFile } : { sessionFile: undefined }),
                status: conversation.status === "error" ? "error" : "idle",
              };
            })
          : [],
        queuedPrompts: normalizeQueuedPrompts(parsed.queuedPrompts),
        compactions: normalizeCompactions(parsed.compactions),
        sessionIndex: parsed.sessionIndex && typeof parsed.sessionIndex === "object" && !Array.isArray(parsed.sessionIndex)
          ? Object.fromEntries(Object.entries(parsed.sessionIndex).filter(([, stamp]) => typeof stamp === "string")) : {},
      };
    } catch (error) {
      // A failed migration must never be treated as a missing index and erase chats.
      if (loadedState || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.save();
    }
    // Persist restart pauses and migrated references even when history scans
    // are deferred, or when every cached directory is already current.
    if (loadedState) {
      await migrateChatFiles(this.dataDir, this.state.conversations);
      await this.save();
    }
    if (!this.sharedDataDir && options.refreshSessions !== false) await this.refreshAllProjectSessions();
  }

  get runtimePackagesDir(): string {
    return path.join(this.sharedDataDir ?? this.dataDir, "runtime");
  }

  getEffectivePackagePath(packageName: string): string {
    // First-party Pi packages are a single embedded, tested source revision.
    if (packageName.startsWith('@earendil-works/pi-')) return path.join(this.appRoot, 'node_modules', packageName);
    const portablePath = path.join(
      this.runtimePackagesDir,
      "node_modules",
      packageName,
    );
    return existsSync(path.join(portablePath, "package.json"))
      ? portablePath
      : path.join(this.appRoot, "node_modules", packageName);
  }

  getEngineEntryPath(): string {
    return path.join(this.appRoot, 'resources', 'pi-engine', 'worker.mjs');
  }

  async refreshManagedPackageConfiguration(): Promise<void> {
    await this.writeManagedPackageConfiguration();
  }

  private async initializeAgentDirectory(): Promise<void> {
    const templateDir = path.join(this.appRoot, "resources", "agent-template");
    await this.migrateLegacyAdapterConfiguration();
    for (const fileName of [
      "models.json",
      "mcp-adapter.json",
      "auth.json",
      "web-search.json",
    ]) {
      const destination = path.join(this.agentDir, fileName);
      try {
        await readFile(destination);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await copyFile(path.join(templateDir, fileName), destination);
      }
    }
    const appendSystemPath = path.join(this.agentDir, "APPEND_SYSTEM.md");
    try {
      await readFile(appendSystemPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(appendSystemPath, DEFAULT_APPEND_SYSTEM_PROMPT, "utf8");
    }
    await this.migrateManagedMcpServers(path.join(this.agentDir, "mcp-adapter.json"));
    await this.migrateLegacyWebSearchProvider(
      path.join(this.agentDir, "web-search.json"),
    );
    await this.migrateLegacySystemPrompt(appendSystemPath);

    const settingsPath = path.join(this.agentDir, "settings.json");
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<
        string,
        unknown
      >;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      settings = JSON.parse(
        await readFile(path.join(templateDir, "settings.json"), "utf8"),
      ) as Record<string, unknown>;
    }

    await this.writeManagedPackageConfiguration(settings);

    const extensionsDir = path.join(this.agentDir, "extensions");
    await mkdir(extensionsDir, { recursive: true });
    await this.moveManagedExtensionConfig(extensionsDir);
    await ensureComfyAddon(this.dataDir, this.appRoot);
  }

  private async writeManagedPackageConfiguration(
    existingSettings?: Record<string, unknown>,
  ): Promise<void> {
    const settingsPath = path.join(this.agentDir, "settings.json");
    let settings = existingSettings;
    if (!settings) {
      settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<
        string,
        unknown
      >;
    }
    const managedPackages = BUILTIN_MODULES.filter(
      (module) => this.builtinModules[module.id],
    )
      .filter(
        (module) => !module.dependsOn || this.builtinModules[module.dependsOn],
      )
      .map((module) =>
        module.kind === "package"
          ? this.getEffectivePackagePath(module.id)
          : path.join(this.appRoot, "resources", module.id),
      );
    const configuredPackages = Array.isArray(settings.packages)
      ? settings.packages.filter(
          (item): item is string => typeof item === "string",
        )
      : [];
    const customPackages = configuredPackages.filter(
      (item) =>
        !isManagedPackage(
          item,
          [...MANAGED_PACKAGE_NAMES, ...RETIRED_PACKAGE_NAMES],
          [...MANAGED_RESOURCE_NAMES, ...RETIRED_RESOURCE_NAMES],
        ),
    );
    settings.packages = [...managedPackages, ...customPackages];
    if (Array.isArray(settings.extensions)) {
      settings.extensions = settings.extensions.filter(item => typeof item !== "string" ||
        !isManagedPackage(item.replace(/[\\/]index\.js$/i, ""), [], RETIRED_RESOURCE_NAMES));
    }
    await writeFile(
      settingsPath,
      `${JSON.stringify(settings, null, 2)}\n`,
      "utf8",
    );
  }

  private async loadBuiltinModuleSettings(): Promise<void> {
    try {
      const parsed = JSON.parse(
        await readFile(this.moduleSettingsPath, "utf8"),
      ) as { enabled?: Record<string, unknown> };
      for (const module of BUILTIN_MODULES) {
        if (typeof parsed.enabled?.[module.id] === "boolean")
          this.builtinModules[module.id] = parsed.enabled[module.id] as boolean;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.saveBuiltinModuleSettings();
    }
  }

  private async saveBuiltinModuleSettings(): Promise<void> {
    await writeFile(
      this.moduleSettingsPath,
      `${JSON.stringify({ version: 1, enabled: this.builtinModules }, null, 2)}\n`,
      "utf8",
    );
  }

  private async moveManagedExtensionConfig(
    extensionsDir: string,
  ): Promise<void> {
    const legacyConfig = path.join(extensionsDir, "pi-tool-repair.json");
    if (!existsSync(legacyConfig)) return;
    const builtinConfigDir = path.join(this.dataDir, "builtin-config");
    await mkdir(builtinConfigDir, { recursive: true });
    await copyFile(
      legacyConfig,
      path.join(builtinConfigDir, "pi-tool-repair.json"),
    );
    await unlink(legacyConfig);
  }

  async getModuleSettings(): Promise<ModuleSettings> {
    const extensionsDir = path.join(this.agentDir, "extensions");
    await mkdir(extensionsDir, { recursive: true });
    const entries = await readdir(extensionsDir, { withFileTypes: true });
    const userExtensions = entries
      .filter(
        (entry) =>
          entry.isDirectory() ||
          (entry.isFile() && /\.(?:[cm]?js|ts)$/i.test(entry.name)),
      )
      .map((entry) => ({
        name: entry.name,
        path: path.join(extensionsDir, entry.name),
        kind: entry.isDirectory() ? ("directory" as const) : ("file" as const),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    return {
      builtins: BUILTIN_MODULES.map((module) => ({
        id: module.id,
        name: module.name,
        description: module.description,
        enabled: this.builtinModules[module.id],
        ...(module.dependsOn ? { dependsOn: module.dependsOn } : {}),
      })),
      userExtensions,
      userExtensionsDir: extensionsDir,
    };
  }

  async setBuiltinModuleEnabled(
    id: BuiltinModuleId,
    enabled: boolean,
  ): Promise<ModuleSettings> {
    if (!BUILTIN_MODULES.some((module) => module.id === id))
      throw new Error("Неизвестный встроенный модуль");
    this.builtinModules[id] = enabled;
    await this.saveBuiltinModuleSettings();
    await this.writeManagedPackageConfiguration();
    return this.getModuleSettings();
  }

  async addUserExtension(sourcePath: string): Promise<ModuleSettings> {
    const extensionsDir = path.resolve(this.agentDir, "extensions");
    const source = path.resolve(sourcePath);
    const destination = path.resolve(extensionsDir, path.basename(source));
    if (path.dirname(destination) !== extensionsDir)
      throw new Error("Недопустимое имя расширения");
    if (existsSync(destination))
      throw new Error(`Расширение «${path.basename(source)}» уже существует`);
    await cp(source, destination, { recursive: true, errorOnExist: true });
    return this.getModuleSettings();
  }

  async removeUserExtension(name: string): Promise<ModuleSettings> {
    const extensionsDir = path.resolve(this.agentDir, "extensions");
    const target = path.resolve(extensionsDir, name);
    if (path.dirname(target) !== extensionsDir || !existsSync(target))
      throw new Error("Пользовательское расширение не найдено");
    await rm(target, { recursive: true, force: false });
    return this.getModuleSettings();
  }

  private async migrateLegacyAdapterConfiguration(): Promise<void> {
    const nativePath = path.join(this.agentDir, "mcp.json");
    const adapterPath = path.join(this.agentDir, "mcp-adapter.json");
    if (!existsSync(nativePath)) return;
    const native = parseMcpConfiguration(await readFile(nativePath, "utf8"));
    const adapter = existsSync(adapterPath) ? parseMcpConfiguration(await readFile(adapterPath, "utf8")) : {};
    const result = migrateLegacyAdapterConfig(native, adapter);
    if (!result.changed) return;
    const backupPath = `${nativePath}.before-adapter-migration`;
    if (!existsSync(backupPath)) await copyFile(nativePath, backupPath, constants.COPYFILE_EXCL);
    // Save the destination first: interruption must never lose old settings.
    await atomicStateWrite(adapterPath, `${JSON.stringify(result.adapterConfig, null, 2)}\n`);
    await atomicStateWrite(nativePath, `${JSON.stringify(result.nativeConfig, null, 2)}\n`);
  }

  private async migrateManagedMcpServers(configPath: string): Promise<void> {
    const config = parseMcpConfiguration(await readFile(configPath, "utf8")) as {
      settings?: Record<string, unknown>;
      mcpServers?: Record<string, Record<string, unknown>>;
    };
    config.settings = { ...config.settings, requestTimeoutMs: 86_400_000 };
    const computerUse = config.mcpServers?.["computer-use"];
    const args = Array.isArray(computerUse?.args) ? computerUse.args : [];
    const isManagedNpxEntry =
      computerUse?.command === "npx" &&
      args.some(
        (item) =>
          typeof item === "string" &&
          item.startsWith("@zavora-ai/computer-use-mcp@"),
      );
    const isManagedDirectEntry = args.some(
      (item) =>
        typeof item === "string" &&
        item
          .replace(/\\/g, "/")
          .includes("/@zavora-ai/computer-use-mcp/dist/server.js"),
    );
    const isTemplateEntry = computerUse?.command === "${PI_DESKTOP_EXECUTABLE}";
    const directToolsEnabled = computerUse?.directTools !== false;
    if (isManagedNpxEntry || isManagedDirectEntry || isTemplateEntry) {
      config.mcpServers!["computer-use"] = {
        command: this.runtimeExecutable,
        args: [
          path.join(
            this.appRoot,
            "node_modules",
            "@zavora-ai",
            "computer-use-mcp",
            "dist",
            "server.js",
          ),
        ],
        env: { ELECTRON_RUN_AS_NODE: "1" },
        directTools: directToolsEnabled,
      };
    }
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  private async migrateLegacySystemPrompt(promptPath: string): Promise<void> {
    const current = (await readFile(promptPath, "utf8")).trim();
    if (
      current !==
      "Перед любыми правками файлов ты спрашиваешь у пользователя разрешение."
    )
      return;
    await writeFile(
      promptPath,
      "Before modifying any files, ask the user for permission.\n",
      "utf8",
    );
  }

  private async migrateLegacyWebSearchProvider(
    configPath: string,
  ): Promise<void> {
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    const keys = Object.keys(config).sort();
    const isManagedExaDefault =
      keys.length === 2 &&
      keys[0] === "provider" &&
      keys[1] === "workflow" &&
      config.provider === "exa" &&
      config.workflow === "none";
    if (!isManagedExaDefault) return;
    await writeFile(
      configPath,
      `${JSON.stringify({ provider: "duckduckgo", workflow: "none" }, null, 2)}\n`,
      "utf8",
    );
  }

  async getGlobalPrompt(): Promise<string> {
    return readFile(path.join(this.agentDir, "APPEND_SYSTEM.md"), "utf8");
  }

  async saveGlobalPrompt(prompt: string): Promise<string> {
    if (typeof prompt !== "string")
      throw new TypeError("Глобальный промпт должен быть текстом");
    if (Buffer.byteLength(prompt, "utf8") > 1_048_576)
      throw new Error("Глобальный промпт не может превышать 1 МБ");
    const normalized = prompt.replace(/\r\n?/g, "\n").trimEnd();
    const saved = normalized ? `${normalized}\n` : "";
    await writeFile(
      path.join(this.agentDir, "APPEND_SYSTEM.md"),
      saved,
      "utf8",
    );
    return saved;
  }

  async getProjectInstructions(
    projectId: string,
  ): Promise<ProjectInstructions> {
    const project = this.getProject(projectId);
    const filePath = path.join(project.path, "AGENTS.md");
    try {
      const buffer = await readFile(filePath);
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      } catch {
        throw new Error(`${filePath} не является корректным UTF-8 файлом`);
      }
      return { projectId, filePath, content, exists: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { projectId, filePath, content: "", exists: false };
      }
      throw error;
    }
  }

  async saveProjectInstructions(
    projectId: string,
    content: string,
  ): Promise<ProjectInstructions> {
    if (typeof content !== "string")
      throw new TypeError("Инструкции проекта должны быть текстом");
    if (Buffer.byteLength(content, "utf8") > 1_048_576)
      throw new Error("Инструкции проекта не могут превышать 1 МБ");
    const project = this.getProject(projectId);
    const filePath = path.join(project.path, "AGENTS.md");
    const normalized = content.replace(/\r\n?/g, "\n").trimEnd();
    const saved = normalized ? `${normalized}\n` : "";
    await writeFile(filePath, saved, "utf8");
    return { projectId, filePath, content: saved, exists: true };
  }

  async getModelServers(): Promise<ConfiguredModelServer[]> {
    const config = await this.readModelsConfig();
    return Object.entries(config.providers ?? {})
      .filter(
        ([, provider]) =>
          typeof provider.baseUrl === "string" &&
          Array.isArray(provider.models),
      )
      .map(([id, provider]) => configuredServerView(id, provider));
  }

  async refreshModelServers(force = false): Promise<void> {
    if (this.modelsRefresh) return this.modelsRefresh;
    if (!force && Date.now() - this.modelsRefreshedAt < 30_000) return;
    const refresh = this.mutateModels(async () => {
      const servers = await this.getModelServers();
      const config = await this.readModelsConfig();
      const results = await Promise.all(servers.filter(server => server.api === "openai-completions").map(async server => {
        const input = { address: server.baseUrl, port: "", providerId: server.id };
        const key = config.providers?.[server.id]?.apiKey;
        try {
          const discovered = await discoverProvider({ ...input, apiKey: typeof key === "string" && key !== "local-server" ? key : undefined });
          return { input, discovered };
        } catch {
          // Offline/auth failures are not an authoritative empty model list.
          return undefined;
        }
      }));
      for (const result of results) if (result) await this.discoverModelServerSerial(result.input, result.discovered);
      this.modelsRefreshedAt = Date.now();
    });
    this.modelsRefresh = refresh;
    try { await refresh; }
    finally { if (this.modelsRefresh === refresh) this.modelsRefresh = undefined; }
  }

  async discoverModelServer(
    input: ModelServerDiscoveryInput,
  ): Promise<ModelServerDiscoveryResult> {
    return this.mutateModels(() => this.discoverModelServerSerial(input));
  }

  private async discoverModelServerSerial(input: ModelServerDiscoveryInput, prepared?: DiscoveredProviderConfiguration): Promise<ModelServerDiscoveryResult> {
    const config = await this.readModelsConfig();
    const providers = config.providers ?? {};
    // Resolve saved credentials BEFORE probing the protected endpoint. Omitting
    // apiKey keeps it; an explicitly empty value removes it.
    const editing = input.providerId ? providers[input.providerId] : Object.values(providers).find(provider => {
      try { return typeof provider.baseUrl === "string" && normalizeServer({ address: provider.baseUrl, port: "" }).baseUrl === normalizeServer(input).baseUrl; }
      catch { return false; }
    });
    const storedKey = typeof editing?.apiKey === "string" && editing.apiKey !== "local-server" ? editing.apiKey : undefined;
    if (input.providerId && !providers[input.providerId]) throw new Error("Настраиваемый сервер больше не существует");
    const discovered = prepared ?? await discoverProvider({ ...input, apiKey: input.apiKey === undefined ? storedKey : input.apiKey });
    const addressEntry = Object.entries(providers).find(
      ([, provider]) => {
        try { return typeof provider.baseUrl === "string" && normalizeServer({ address: provider.baseUrl, port: "" }).baseUrl === discovered.baseUrl; }
        catch { return false; }
      },
    );
    if (input.providerId && !providers[input.providerId])
      throw new Error("Настраиваемый сервер больше не существует");
    if (
      input.providerId &&
      addressEntry &&
      addressEntry[0] !== input.providerId
    )
      throw new Error(
        `Этот адрес уже используется сервером «${addressEntry[0]}»`,
      );
    const matchingEntry = input.providerId
      ? ([input.providerId, providers[input.providerId]] as const)
      : addressEntry;
    let providerId = matchingEntry?.[0] ?? discovered.suggestedId;
    let suffix = 2;
    while (!matchingEntry && providers[providerId])
      providerId = `${discovered.suggestedId}-${suffix++}`;
    const existingProvider = matchingEntry?.[1] ?? {};
    const existingModels = Array.isArray(existingProvider.models)
      ? existingProvider.models.filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object" && !Array.isArray(item),
        )
      : [];
    if (!prepared && config.desktopHiddenModels) delete config.desktopHiddenModels[providerId];
    const hiddenModels = new Set(config.desktopHiddenModels?.[providerId] ?? []);
    const discoveredModels = Array.isArray(discovered.provider.models)
      ? discovered.provider.models.filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object" && !Array.isArray(item) && !hiddenModels.has(String(item.id)),
        )
      : [];
    const existingById = new Map(
      existingModels.map((model) => [String(model.id ?? ""), model]),
    );
    const mergedDetected = discoveredModels.map((model) => {
      const previous = existingById.get(String(model.id ?? "")) ?? {};
      const previousCompat =
        previous.compat &&
        typeof previous.compat === "object" &&
        !Array.isArray(previous.compat)
          ? (previous.compat as Record<string, unknown>)
          : {};
      const detectedCompat =
        model.compat &&
        typeof model.compat === "object" &&
        !Array.isArray(model.compat)
          ? (model.compat as Record<string, unknown>)
          : {};
      const merged: Record<string, unknown> = {
        ...previous,
        ...model,
        compat: { ...previousCompat, ...detectedCompat },
      };
      // Capabilities absent from the fresh detection must not survive an old template.
      for (const field of ["thinkingLevelMap", "contextWindow", "maxTokens", "samplingParams"])
        if (!(field in model)) delete merged[field];
      if (!model.reasoning) delete merged.compat;
      if (!discovered.propertiesAvailable) {
        // A failed optional /props probe is not evidence that thinking, vision
        // or context support disappeared from an otherwise reachable server.
        for (const field of ["reasoning", "input", "thinkingLevelMap", "compat", "samplingParams"])
          if (field in previous) merged[field] = previous[field];
        for (const field of ["contextWindow", "maxTokens"])
          if (!(field in model) && field in previous) merged[field] = previous[field];
      }
      for (const [field, value] of Object.entries(config.desktopModelOverrides?.[providerId]?.[String(model.id)] ?? {})) {
        if (value === null) delete merged[field]; else merged[field] = value;
      }
      return merged;
    });
    const previousCompat =
      existingProvider.compat &&
      typeof existingProvider.compat === "object" &&
      !Array.isArray(existingProvider.compat)
        ? (existingProvider.compat as Record<string, unknown>)
        : {};
    const detectedCompat =
      discovered.provider.compat &&
      typeof discovered.provider.compat === "object" &&
      !Array.isArray(discovered.provider.compat)
        ? (discovered.provider.compat as Record<string, unknown>)
        : {};
    const apiKey = input.apiKey !== undefined ? input.apiKey.trim() || "local-server" :
      (typeof existingProvider.apiKey === "string"
        ? existingProvider.apiKey
        : discovered.provider.apiKey);
    const provider = {
      ...existingProvider,
      ...discovered.provider,
      apiKey,
      compat: { ...previousCompat, ...detectedCompat },
      models: mergedDetected,
    };
    providers[providerId] = provider;
    config.providers = providers;
    config.desktopManagedProviders = [...new Set([...(config.desktopManagedProviders ?? []), providerId])];
    await this.writeModelsConfig(config);
    const addedModels = discoveredModels.filter(
      (model) => !existingById.has(String(model.id ?? "")),
    ).length;
    return {
      ...discovered.publicResult,
      server: configuredServerView(providerId, provider),
      addedModels,
      updatedModels: discoveredModels.length - addedModels,
    };
  }

  async updateConfiguredModel(
    input: ConfiguredModelUpdate,
  ): Promise<ConfiguredModelServer> {
    return this.mutateModels(() => this.updateConfiguredModelSerial(input));
  }

  private async updateConfiguredModelSerial(input: ConfiguredModelUpdate): Promise<ConfiguredModelServer> {
    const config = await this.readModelsConfig();
    const provider = config.providers?.[input.providerId];
    if (!provider) throw new Error("Сервер модели не найден");
    const models = Array.isArray(provider.models)
      ? provider.models.filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object" && !Array.isArray(item),
        )
      : [];
    const modelIndex = models.findIndex(
      (model) => String(model.id ?? "") === input.originalModelId,
    );
    if (modelIndex < 0) throw new Error("Модель не найдена");
    const id = input.id.trim();
    if (!id) throw new Error("ID модели не может быть пустым");
    if (
      models.some(
        (model, index) => index !== modelIndex && String(model.id ?? "") === id,
      )
    )
      throw new Error(`Модель «${id}» уже существует на этом сервере`);
    const contextWindow =
      input.contextWindow === undefined
        ? undefined
        : validatePositiveInteger(input.contextWindow, "Контекст");
    const maxTokens =
      input.maxTokens === undefined
        ? undefined
        : validatePositiveInteger(input.maxTokens, "Лимит ответа");
    if (contextWindow && maxTokens && maxTokens > contextWindow)
      throw new Error("Лимит ответа не может превышать размер контекста");
    const inputTypes = [
      ...new Set(["text", ...input.input.filter((item) => item === "image")]),
    ];
    const levels = [
      ...new Set(
        input.thinkingLevels.filter((level) => THINKING_LEVELS.includes(level)),
      ),
    ];
    if (input.reasoning && !levels.length)
      throw new Error("Выберите хотя бы один уровень рассуждений");
    const sampling =
      input.samplingParams &&
      typeof input.samplingParams === "object" &&
      !Array.isArray(input.samplingParams)
        ? Object.fromEntries(
            Object.entries(input.samplingParams).filter(([, value]) =>
              ["number", "boolean", "string"].includes(typeof value),
            ),
          )
        : undefined;
    const updated: Record<string, unknown> = {
      ...models[modelIndex],
      id,
      reasoning: input.reasoning,
      input: inputTypes,
    };
    if (input.name?.trim()) updated.name = input.name.trim();
    else delete updated.name;
    if (contextWindow) updated.contextWindow = contextWindow;
    else delete updated.contextWindow;
    if (maxTokens) updated.maxTokens = maxTokens;
    else delete updated.maxTokens;
    if (sampling && Object.keys(sampling).length)
      updated.samplingParams = sampling;
    else delete updated.samplingParams;
    if (input.reasoning) {
      updated.thinkingLevelMap = Object.fromEntries(
        THINKING_LEVELS.map((level) => [
          level,
          levels.includes(level) ? (level === "off" ? "none" : level) : null,
        ]),
      );
    } else {
      delete updated.thinkingLevelMap;
    }
    const previous = models[modelIndex];
    models[modelIndex] = updated;
    provider.models = models;
    const overrides = config.desktopModelOverrides ??= {};
    const providerOverrides = overrides[input.providerId] ??= {};
    const modelOverrides = providerOverrides[input.originalModelId] ?? {};
    for (const field of ["name", "reasoning", "input", "contextWindow", "maxTokens", "samplingParams", "thinkingLevelMap"])
      if (JSON.stringify(previous[field]) !== JSON.stringify(updated[field]))
        modelOverrides[field] = updated[field] ?? null;
    providerOverrides[id] = modelOverrides;
    if (id !== input.originalModelId) delete providerOverrides[input.originalModelId];
    await this.writeModelsConfig(config);
    return configuredServerView(input.providerId, provider);
  }

  async deleteConfiguredModel(
    providerId: string,
    modelId: string,
  ): Promise<ConfiguredModelServer | null> {
    return this.mutateModels(() => this.deleteConfiguredModelSerial(providerId, modelId));
  }

  private async deleteConfiguredModelSerial(providerId: string, modelId: string): Promise<ConfiguredModelServer | null> {
    const config = await this.readModelsConfig();
    const provider = config.providers?.[providerId];
    if (!provider) return null;
    const models = Array.isArray(provider.models) ? provider.models : [];
    const nextModels = models.filter(
      (item) =>
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        String((item as Record<string, unknown>).id ?? "") !== modelId,
    );
    if (nextModels.length === models.length)
      return configuredServerView(providerId, provider);
    provider.models = nextModels;
    const hiddenModels = config.desktopHiddenModels ??= {};
    hiddenModels[providerId] = [...new Set([...(hiddenModels[providerId] ?? []), modelId])];
    if (config.desktopModelOverrides?.[providerId]) delete config.desktopModelOverrides[providerId][modelId];
    await this.writeModelsConfig(config);
    return configuredServerView(providerId, provider);
  }

  async deleteModelServer(providerId: string): Promise<boolean> {
    return this.mutateModels(() => this.deleteModelServerSerial(providerId));
  }

  private async deleteModelServerSerial(providerId: string): Promise<boolean> {
    const config = await this.readModelsConfig();
    if (!config.providers?.[providerId]) return false;
    delete config.providers[providerId];
    config.desktopManagedProviders = [...new Set([...(config.desktopManagedProviders ?? []), providerId])];
    if (config.desktopModelOverrides) delete config.desktopModelOverrides[providerId];
    if (config.desktopHiddenModels) delete config.desktopHiddenModels[providerId];
    await this.writeModelsConfig(config);
    return true;
  }

  private async migrateLegacyToolRepairConfig(
    configPath: string,
  ): Promise<void> {
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      grammarRepair?: {
        enabled?: boolean;
        grammars?: unknown;
        leakModels?: unknown;
      };
    };
    const repair = config.grammarRepair;
    const isLegacyQwenGlobal =
      repair?.enabled === true &&
      Array.isArray(repair.grammars) &&
      repair.grammars.length === 1 &&
      repair.grammars[0] === "qwen" &&
      repair.leakModels === undefined;
    if (!isLegacyQwenGlobal || !repair) return;
    repair.enabled = false;
    repair.leakModels = ["qwen"];
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  }

  getNotebookCharacterLimit(): number {
    return validateNotebookLimit(this.state.notebookCharacterLimit ?? notebookLimit);
  }

  async setNotebookCharacterLimit(value: number): Promise<number> {
    this.state.notebookCharacterLimit = validateNotebookLimit(value);
    await this.save();
    return this.getNotebookCharacterLimit();
  }

  snapshot(): Omit<DesktopState, "queuedPrompts" | "compactions"> {
    return structuredClone({
      version: this.state.version,
      projects: this.state.projects,
      conversations: this.state.conversations.filter(
        (conversation) => !conversation.archived,
      ),
      activeProjectId: this.state.activeProjectId,
      activeConversationId: this.state.conversations.some(
        (conversation) =>
          conversation.id === this.state.activeConversationId &&
          !conversation.archived,
      )
        ? this.state.activeConversationId
        : undefined,
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
    const conversation = this.state.conversations.find(
      (item) => item.id === conversationId,
    );
    if (!conversation) throw new Error("Чат не найден");
    return conversation;
  }

  async addProject(
    name: string,
    folderPaths: string[],
  ): Promise<ProjectRecord> {
    const canonicalPaths = [
      ...new Set(folderPaths.map((item) => path.resolve(item))),
    ];
    if (!canonicalPaths.length)
      throw new Error("Добавьте хотя бы одну папку проекта");
    const existing = this.state.projects.find((item) =>
      pathsEqual(item.path, canonicalPaths[0]),
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
      name:
        name.trim() || path.basename(canonicalPaths[0]) || canonicalPaths[0],
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

  async refreshProjectSessions(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<ConversationRecord[]> {
    this.getProject(projectId);
    signal?.throwIfAborted();
    if (!this.sharedDataDir) {
      let pending = this.sessionRefreshes.get(projectId);
      if (!pending) {
        pending = this.refreshProjectSessionIndex(projectId, signal);
        this.sessionRefreshes.set(projectId, pending);
      }
      try { await pending; }
      finally { if (this.sessionRefreshes.get(projectId) === pending) this.sessionRefreshes.delete(projectId); }
    }
    return this.state.conversations
      .filter(
        (conversation) =>
          conversation.projectId === projectId && !conversation.archived,
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map((conversation) => structuredClone(conversation));
  }

  async refreshAllProjectSessions(signal?: AbortSignal): Promise<void> {
    for (const project of [...this.state.projects]) {
      signal?.throwIfAborted();
      if (this.state.projects.some(current => current.id === project.id)) await this.refreshProjectSessions(project.id, signal);
    }
  }

  private async refreshProjectSessionIndex(projectId: string, signal?: AbortSignal): Promise<void> {
    const project = this.getProject(projectId);
    const directories = [...new Set([this.getSessionDir(project.path), ...this.state.conversations
      .filter(chat => chat.projectId === projectId).map(chat => this.getSessionDir(project.path, chat.id))])];
    const directoryStamps = () => Promise.all(directories.map(directory => sessionDirectoryStamp(directory)));
    const stamps = await directoryStamps(), stamp = JSON.stringify(stamps);
    signal?.throwIfAborted();
    const previousStamp = this.state.sessionIndex?.[projectId];
    if (this.state.sessionIndex?.[projectId] === stamp) return;
    const expectedCount = stamps.reduce((count, value) => count + (JSON.parse(value) as unknown[]).length, 0);
    let complete = expectedCount === 0;
    let sessions: SessionInfo[] = [];
    if (expectedCount) {
      signal?.throwIfAborted();
      for (let index = 0; index < directories.length; index++) if (stamps[index] !== "[]")
        sessions.push(...await listSessions(project.path, directories[index], signal));
      signal?.throwIfAborted();
      if (!this.state.projects.some(current => current.id === projectId && current.path === project.path)) return;
      complete = sessions.length === expectedCount;
    }
    // A file may change while discovery is reading it. Never cache that scan
    // as current; the next refresh must inspect it again.
    const unchanged = JSON.stringify(await directoryStamps()) === stamp;
    signal?.throwIfAborted();
    if (!this.state.projects.some(current => current.id === projectId && current.path === project.path)) return;
    if (unchanged) for (const session of sessions) this.mergeSession(projectId, session);
    this.state.sessionIndex ??= {};
    if (complete && unchanged) this.state.sessionIndex[projectId] = stamp;
    else delete this.state.sessionIndex[projectId];
    try { await this.save(); }
    catch (error) {
      if (previousStamp === undefined) delete this.state.sessionIndex[projectId];
      else this.state.sessionIndex[projectId] = previousStamp;
      throw error;
    }
  }

  async searchConversations(query: string): Promise<string[]> {
    const normalized = query.toLocaleLowerCase().trim();
    if (!normalized)
      return this.state.conversations
        .filter((item) => !item.archived)
        .map((item) => item.id);
    const matches: string[] = [];
    for (const conversation of this.state.conversations) {
      if (conversation.archived) continue;
      if (conversation.title.toLocaleLowerCase().includes(normalized)) {
        matches.push(conversation.id);
        continue;
      }
      if (!conversation.sessionFile || !existsSync(conversation.sessionFile))
        continue;
      try {
        const content = await readFile(conversation.sessionFile, "utf8");
        if (content.toLocaleLowerCase().includes(normalized))
          matches.push(conversation.id);
      } catch {
        // A single unavailable session must not break the entire search.
      }
    }
    return matches;
  }

  async getMcpDirectToolSelectors(): Promise<string[]> {
    const config = parseMcpConfiguration(
      await readFile(path.join(this.agentDir, "mcp-adapter.json"), "utf8"),
    ) as {
      settings?: { directTools?: boolean };
      mcpServers?: Record<
        string,
        { disabled?: boolean; directTools?: boolean | string[] }
      >;
    };
    const selectors: string[] = [];
    for (const [serverName, definition] of Object.entries(
      config.mcpServers ?? {},
    )) {
      if (definition.disabled) continue;
      const directTools =
        definition.directTools ?? config.settings?.directTools ?? false;
      if (directTools === true) selectors.push(serverName);
      else if (Array.isArray(directTools)) {
        selectors.push(
          ...directTools.map((toolName) => `${serverName}/${toolName}`),
        );
      }
    }
    return selectors;
  }

  async getAgentConfiguration(): Promise<{
    revision: string;
    managedProviders: string[];
    models: ModelInfo[];
    defaultProvider?: string;
    defaultModel?: string;
    defaultThinkingLevel: ThinkingLevel;
  }> {
    const [modelsConfig, settings] = await Promise.all([
      readFile(path.join(this.agentDir, "models.json"), "utf8").then(
        (content) =>
          JSON.parse(content) as {
            desktopManagedProviders?: string[];
            providers?: Record<
              string,
              { models?: Array<Record<string, unknown>> }
            >;
          },
      ),
      readFile(path.join(this.agentDir, "settings.json"), "utf8").then(
        (content) => JSON.parse(content) as Record<string, unknown>,
      ),
    ]);
    const models: ModelInfo[] = [];
    for (const [provider, definition] of Object.entries(
      modelsConfig.providers ?? {},
    )) {
      for (const model of definition.models ?? []) {
        if (typeof model.id !== "string") continue;
        const reasoning = model.reasoning === true;
        const levelMap =
          model.thinkingLevelMap && typeof model.thinkingLevelMap === "object"
            ? (model.thinkingLevelMap as Record<string, unknown>)
            : undefined;
        const thinkingLevels = !reasoning
          ? ["off" as ThinkingLevel]
          : levelMap
            ? THINKING_LEVELS.filter(
                (level) =>
                  Object.hasOwn(levelMap, level) && levelMap[level] !== null,
              )
            : [...THINKING_LEVELS];
        models.push({
          provider,
          id: model.id,
          name: typeof model.name === "string" ? model.name : undefined,
          contextWindow:
            typeof model.contextWindow === "number"
              ? model.contextWindow
              : undefined,
          reasoning,
          thinkingLevels: thinkingLevels.length ? thinkingLevels : ["off"],
        });
      }
    }
    const configuredThinking = settings.defaultThinkingLevel;
    return {
      revision: createHash("sha256").update(JSON.stringify(modelsConfig)).digest("hex"),
      managedProviders: [...new Set([...(modelsConfig.desktopManagedProviders ?? []), ...Object.keys(modelsConfig.providers ?? {})])],
      models,
      defaultProvider:
        typeof settings.defaultProvider === "string"
          ? settings.defaultProvider
          : undefined,
      defaultModel:
        typeof settings.defaultModel === "string"
          ? settings.defaultModel
          : undefined,
      defaultThinkingLevel:
        typeof configuredThinking === "string" &&
        THINKING_LEVELS.includes(configuredThinking as ThinkingLevel)
          ? (configuredThinking as ThinkingLevel)
          : "off",
    };
  }

  getSessionDir(cwd: string, conversationId?: string): string {
    if (conversationId) return path.join(chatDirectory(this.dataDir, conversationId), "sessions");
    const resolvedCwd = path.resolve(cwd);
    const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    return path.join(this.sessionsDir, safePath);
  }

  async removeProject(projectId: string): Promise<string[]> {
    const conversationIds = this.state.conversations
      .filter((item) => item.projectId === projectId)
      .map((item) => item.id);
    this.state.projects = this.state.projects.filter(
      (item) => item.id !== projectId,
    );
    this.state.conversations = this.state.conversations.filter(
      (item) => item.projectId !== projectId,
    );
    for (const conversationId of conversationIds)
      delete this.state.queuedPrompts[conversationId];
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
    changes: Partial<
      Omit<ConversationRecord, "id" | "projectId" | "createdAt">
    >,
  ): Promise<ConversationRecord> {
    const conversation = this.getConversation(conversationId);
    Object.assign(conversation, changes, {
      updatedAt: new Date().toISOString(),
    });
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

  getConversationChatDirectory(conversation: ConversationRecord): string {
    return chatDirectory(this.dataDir, conversation.id);
  }

  getConversationDataDirectories(conversation: ConversationRecord): string[] {
    return [...new Set([this.getConversationChatDirectory(conversation), chatDirectory(this.sharedDataDir ?? this.dataDir, conversation.id)])];
  }

  async getConversationWorkingDirectory(
    conversation: ConversationRecord,
  ): Promise<string> {
    if (conversation.projectId && !this.sharedDataDir)
      return this.getProject(conversation.projectId).path;
    const workspace = path.join(
      this.getConversationChatDirectory(conversation),
      "workspace",
    );
    await mkdir(workspace, { recursive: true });
    return workspace;
  }

  async getConversationWorkspacePaths(
    conversation: ConversationRecord,
  ): Promise<string[]> {
    if (conversation.projectId)
      return [...this.getProject(conversation.projectId).paths];
    if (this.sharedDataDir) return this.remoteRoots?.length ? [...this.remoteRoots] : ["C:\\"];
    return [await this.getConversationWorkingDirectory(conversation)];
  }

  getQueuedPrompts(conversationId: string): QueuedPrompt[] {
    this.getConversation(conversationId);
    return structuredClone(this.state.queuedPrompts[conversationId] ?? []);
  }

  getCompactions(conversationId: string): CompactionRecord[] {
    this.getConversation(conversationId);
    return structuredClone(this.state.compactions[conversationId] ?? []);
  }

  async saveCompaction(
    conversationId: string,
    record: CompactionRecord,
  ): Promise<void> {
    this.getConversation(conversationId);
    const current = this.state.compactions[conversationId] ?? [];
    this.state.compactions[conversationId] = [
      ...current.filter((item) => item.entryId !== record.entryId),
      structuredClone(record),
    ].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    await this.save();
  }

  async queuePrompt(
    conversationId: string,
    message: string,
    attachments: Attachment[],
    requestPlan = false,
  ): Promise<QueuedPrompt[]> {
    this.getConversation(conversationId);
    const normalizedMessage = message.trim();
    if (!normalizedMessage)
      throw new Error("Сообщение для очереди не может быть пустым");
    const prompt: QueuedPrompt = {
      ...(requestPlan ? { requestPlan: true } : {}),
      id: randomUUID(),
      message: normalizedMessage,
      attachments: structuredClone(attachments),
      createdAt: new Date().toISOString(),
    };
    const queued = [
      ...(this.state.queuedPrompts[conversationId] ?? []),
      prompt,
    ];
    this.state.queuedPrompts[conversationId] = queued;
    await this.save();
    return structuredClone(queued);
  }

  async removeQueuedPrompt(
    conversationId: string,
    promptId: string,
  ): Promise<QueuedPrompt[]> {
    this.getConversation(conversationId);
    const current = this.state.queuedPrompts[conversationId] ?? [];
    if (!current.some((prompt) => prompt.id === promptId))
      throw new Error("Сообщение в очереди не найдено");
    const queued = current.filter((prompt) => prompt.id !== promptId);
    if (queued.length) this.state.queuedPrompts[conversationId] = queued;
    else delete this.state.queuedPrompts[conversationId];
    await this.save();
    return structuredClone(queued);
  }

  async deleteConversation(conversationId: string): Promise<void> {
    this.getConversation(conversationId);
    this.state.conversations = this.state.conversations.filter(
      (item) => item.id !== conversationId,
    );
    delete this.state.queuedPrompts[conversationId];
    delete this.state.compactions[conversationId];
    if (this.state.activeConversationId === conversationId) {
      this.state.activeConversationId = undefined;
    }
    await this.save();
    await unlink(this.getRunPath(conversationId)).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  }

  async getConversationRun(
    conversationId: string,
  ): Promise<ConversationRun | undefined> {
    try {
      return JSON.parse(
        await readFile(this.getRunPath(conversationId), "utf8"),
      ) as ConversationRun;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async saveConversationRun(
    conversationId: string,
    run: ConversationRun,
  ): Promise<void> {
    const destination = this.getRunPath(conversationId);
    const content = `${JSON.stringify(run, null, 2)}\n`;
    await this.enqueueWrite(async () => {
      await mkdir(path.dirname(destination), { recursive: true });
      await atomicStateWrite(destination, content);
    });
  }

  async setConversationArchived(
    conversationId: string,
    archived: boolean,
  ): Promise<ConversationRecord> {
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
    const chatRelative = path.relative(path.resolve(this.dataDir, "chats"), resolved).split(path.sep).join("/");
    if (/^[a-zA-Z0-9_-]{1,128}\/sessions\/[^/]+\.jsonl$/i.test(chatRelative)) return resolved;
    if (
      !relative ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      path.extname(resolved).toLocaleLowerCase() !== ".jsonl"
    ) {
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
    const savedState = {
      ...this.state,
      conversations: this.state.conversations.map((conversation) => ({
        ...conversation,
        sessionFile: conversation.sessionFile
          ? storedSessionReference(this.dataDir, conversation.sessionFile)
          : undefined,
      })),
    };
    const content = `${JSON.stringify(savedState, null, 2)}\n`;
    await this.enqueueWrite(async () => {
      await mkdir(this.dataDir, { recursive: true });
      await atomicStateWrite(this.statePath, content);
    });
  }

  private async readModelsConfig(): Promise<ModelsFileConfig> {
    return JSON.parse(
      await readFile(path.join(this.agentDir, "models.json"), "utf8"),
    ) as ModelsFileConfig;
  }

  private mutateModels<T>(task: () => Promise<T>): Promise<T> {
    // Serialise the entire read-modify-write operation, not just its final write.
    const next = this.modelsMutationQueue.then(task, task);
    this.modelsMutationQueue = next.catch(() => undefined);
    return next;
  }

  private async writeModelsConfig(config: ModelsFileConfig): Promise<void> {
    const destination = path.join(this.agentDir, "models.json");
    await this.enqueueWrite(async () => {
      if (JSON.stringify(await this.readModelsConfig()) === JSON.stringify(config)) return;
      await atomicStateWrite(destination, `${JSON.stringify(config, null, 2)}\n`);
    });
  }

  private getRunPath(conversationId: string): string {
    return path.join(chatDirectory(this.dataDir, conversationId), "run.json");
  }

  private enqueueWrite(task: () => Promise<void>): Promise<void> {
    const next = this.writeQueue.then(task, task);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
}

function normalizeQueuedPrompts(
  value: unknown,
): Record<string, QueuedPrompt[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized: Record<string, QueuedPrompt[]> = {};
  for (const [conversationId, prompts] of Object.entries(value)) {
    if (!Array.isArray(prompts)) continue;
    const valid = prompts.filter((prompt): prompt is QueuedPrompt => {
      if (!prompt || typeof prompt !== "object") return false;
      const candidate = prompt as Partial<QueuedPrompt>;
      return (
        typeof candidate.id === "string" &&
        typeof candidate.message === "string" &&
        candidate.message.trim().length > 0 &&
        typeof candidate.createdAt === "string" &&
        Array.isArray(candidate.attachments)
      );
    });
    if (valid.length) normalized[conversationId] = structuredClone(valid);
  }
  return normalized;
}

function normalizeCompactions(
  value: unknown,
): Record<string, CompactionRecord[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const normalized: Record<string, CompactionRecord[]> = {};
  for (const [conversationId, records] of Object.entries(value)) {
    if (!Array.isArray(records)) continue;
    const valid = records.filter((record): record is CompactionRecord => {
      if (!record || typeof record !== "object") return false;
      const candidate = record as Partial<CompactionRecord>;
      return (
        typeof candidate.entryId === "string" &&
        typeof candidate.timestamp === "string" &&
        typeof candidate.tokensBefore === "number" &&
        Number.isFinite(candidate.tokensBefore) &&
        typeof candidate.tokensAfter === "number" &&
        Number.isFinite(candidate.tokensAfter) &&
        (candidate.durationMs === undefined ||
          (typeof candidate.durationMs === "number" &&
            Number.isFinite(candidate.durationMs)))
      );
    });
    if (valid.length) normalized[conversationId] = structuredClone(valid);
  }
  return normalized;
}

function validatePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${label} должен быть положительным целым числом`);
  return value;
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

function isManagedPackage(
  value: string,
  packageNames: string[],
  managedResourceNames: string[],
): boolean {
  const normalized = value.replaceAll("/", "\\").toLocaleLowerCase();
  if (
    managedResourceNames.some(
      (name) =>
        normalized.endsWith(`\\resources\\${name}`) ||
        normalized.endsWith(`\\local-packages\\${name}`) ||
        normalized === `resources\\${name}` || normalized === `local-packages\\${name}`,
    )
  )
    return true;
  return packageNames.some(
    (name) =>
      normalized === `npm:${name}` ||
      normalized.endsWith(`\\node_modules\\${name}`),
  );
}

function sessionTitle(session: SessionInfo): string {
  const source =
    session.name?.trim() || session.firstMessage.trim() || "Новый чат";
  return source.replace(/\s+/g, " ").slice(0, 64);
}
