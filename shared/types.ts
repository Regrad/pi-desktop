export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type JsonObject = Record<string, unknown>;

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  paths: string[];
  addedAt: string;
  lastOpenedAt: string;
}

export interface ProjectInstructions {
  projectId: string;
  filePath: string;
  content: string;
  exists: boolean;
}

export interface ConversationRecord {
  notebook?: ConversationNotebook;
  goal?: ConversationGoal;
  plan?: ConversationPlan;
  id: string;
  projectId?: string;
  title: string;
  sessionFile?: string;
  createdAt: string;
  updatedAt: string;
  model?: string;
  provider?: string;
  thinkingLevel?: ThinkingLevel;
  archived?: boolean;
  status: "idle" | "starting" | "working" | "error";
}

export interface PlanStep {
  step: string;
  status: "pending" | "in_progress" | "completed";
}

export interface ConversationNotebook {
  content: string;
  revision: number;
  updatedAt: string;
}

export interface ConversationPlan {
  steps: PlanStep[];
  execution?: "active" | "paused";
  explanation?: string;
  revision: number;
  updatedAt: string;
}

export interface ConversationGoal {
  id: string;
  objective: string;
  criteria: string;
  status: "active" | "paused" | "blocked" | "complete" | "budget_limited";
  tokenBudget?: number;
  tokensUsed?: number;
  createdAt?: string;
  timeUsedSeconds?: number;
  progress: string;
  evidence: string;
  steps: number;
  maxSteps: number;
  stalledSteps: number;
  updatedAt: string;
}

export interface ModelInfo {
  provider: string;
  id: string;
  name?: string;
  contextWindow?: number;
  reasoning?: boolean;
  thinkingLevels?: ThinkingLevel[];
}

export interface ConfiguredModelInfo {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning: boolean;
  input: string[];
  thinkingLevels: ThinkingLevel[];
  samplingParams?: Record<string, number | boolean | string>;
}

export interface ConfiguredModelServer {
  id: string;
  baseUrl: string;
  api: string;
  apiKeyConfigured: boolean;
  models: ConfiguredModelInfo[];
}

export interface ModelServerDiscoveryInput {
  address: string;
  port: string;
  apiKey?: string;
  providerId?: string;
}

export interface ConfiguredModelUpdate {
  providerId: string;
  originalModelId: string;
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning: boolean;
  input: string[];
  thinkingLevels: ThinkingLevel[];
  samplingParams?: Record<string, number | boolean | string>;
}

export interface ModelServerDiscoveryResult {
  server: ConfiguredModelServer;
  serverKind: string;
  buildInfo?: string;
  health?: string;
  capabilities: string[];
  addedModels: number;
  updatedModels: number;
}

export type UpdateComponentId =
  | "pi-core"
  | "pi-web-access"
  | "pi-tool-repair"
  | "pi-llama-cpp-stats"
  | "pi-mcp-adapter"
  | "pi-lens";

export interface UpdateComponentStatus {
  id: UpdateComponentId | string;
  packageName?: string;
  name: string;
  description: string;
  currentVersion?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  updateable: boolean;
  source: "bundled" | "portable" | "local";
  error?: string;
}

export interface UpdateStatus {
  checkedAt?: string;
  npmAvailable: boolean;
  components: UpdateComponentStatus[];
}

export interface UpdateResult {
  status: UpdateStatus;
  updated: string[];
  errors: string[];
}

export type BuiltinModuleId =
  | "pi-web-access"
  | "pi-tool-repair"
  | "pi-llama-cpp-stats"
  | "pi-mcp-adapter"
  | "pi-lens"
  | "pi-single-slot-guard"
  | "pi-llama-generation-speed"
  | "pi-loop-police";

export interface BuiltinModuleInfo {
  id: BuiltinModuleId;
  name: string;
  description: string;
  enabled: boolean;
  dependsOn?: BuiltinModuleId;
}

export interface UserExtensionInfo {
  name: string;
  path: string;
  kind: "file" | "directory";
}

export interface ModuleSettings {
  builtins: BuiltinModuleInfo[];
  userExtensions: UserExtensionInfo[];
  userExtensionsDir: string;
}

export interface Attachment {
  id: string;
  name: string;
  path: string;
  mimeType?: string;
  data?: string;
  maskFor?: string;
}

export interface QueuedPrompt {
  requestPlan?: boolean;
  id: string;
  message: string;
  attachments: Attachment[];
  createdAt: string;
}

export interface RuntimeState {
  model: ModelInfo | null;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  isCompacting?: boolean;
  steeringMode?: "all" | "one-at-a-time";
  followUpMode?: "all" | "one-at-a-time";
  autoCompactionEnabled?: boolean;
  messageCount?: number;
  pendingMessageCount?: number;
  steeringMessages?: string[];
  followUpMessages?: string[];
  workingVisible?: boolean;
  workingIndicator?: { frames?: string[]; intervalMs?: number };
  hiddenThinkingLabel?: string;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
}

export interface ExtensionToolInfo {
  name: string;
  description?: string;
  source?: string;
  active: boolean;
}

export interface ExtensionState {
  extensionPaths: string[];
  activeTools: string[];
  tools: ExtensionToolInfo[];
  commandDiagnostics: unknown[];
  shortcutDiagnostics: unknown[];
  errors: Array<{ extensionPath?: string; event?: string; error: string }>;
}

export interface SessionEntryView extends JsonObject {
  type: string;
  id?: string;
  timestamp?: string;
  customType?: string;
  renderedLines?: string[];
}

export interface ExtensionWidgetState {
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

export interface ExtensionUiState {
  statuses: Record<string, string>;
  widgets: ExtensionWidgetState[];
  headerLines: string[];
  footerLines: string[];
  workingMessage?: string;
  workingVisible: boolean;
  workingIndicator?: { frames?: string[]; intervalMs?: number };
  hiddenThinkingLabel?: string;
  title?: string;
  pendingDialogs: ExtensionUiRequest[];
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

export interface FileDiff {
  path: string;
  relativePath: string;
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface RunDiff {
  files: FileDiff[];
  additions: number;
  deletions: number;
  incomplete: boolean;
}

export interface BootstrapPayload {
  projects: ProjectRecord[];
  conversations: ConversationRecord[];
  archivedConversations: ConversationRecord[];
  activeProjectId?: string;
  activeConversationId?: string;
  dataDir: string;
  sessionsDir: string;
}

export interface SessionHistoryTarget {
  entryId: string;
  messageIndex: number;
  editable: boolean;
}

export interface ConversationSnapshot {
  planWorkingRevision?: number;
  historyTargets?: SessionHistoryTarget[];
  conversation: ConversationRecord;
  state: RuntimeState;
  messages: unknown[];
  queuedPrompts: QueuedPrompt[];
  models: ModelInfo[];
  thinkingLevels: ThinkingLevel[];
  commands: Array<{ name: string; description?: string; source: string }>;
  entries: SessionEntryView[];
  compactions: CompactionRecord[];
  extensionState: ExtensionState;
  extensionUi: ExtensionUiState;
  run?: ConversationRun;
  liveMessage?: unknown;
  liveTools?: Record<string, LiveToolActivity>;
}

export interface LiveToolActivity {
  id: string;
  name: string;
  parentToolCallId?: string;
  args?: unknown;
  partialArguments?: string;
  result?: unknown;
  running: boolean;
  preparing?: boolean;
  error?: boolean;
  startedAt: number;
}

export interface CompactionRecord {
  entryId: string;
  timestamp: string;
  tokensBefore: number;
  tokensAfter: number;
  durationMs?: number;
}

export interface ExtensionUiRequest {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWorkingMessage" | "setWorkingVisible" | "setWorkingIndicator" | "setHiddenThinkingLabel" | "setWidget" | "setHeader" | "setFooter" | "setTitle" | "set_editor_text" | "custom" | "customClose";
  title?: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  notifyType?: "info" | "warning" | "error";
  statusKey?: string;
  statusText?: string;
  workingText?: string;
  widgetKey?: string;
  widgetLines?: string[];
  widgetPlacement?: "aboveEditor" | "belowEditor";
  customLines?: string[];
  overlay?: boolean;
  overlayOptions?: JsonObject;
  workingVisible?: boolean;
  workingIndicator?: { frames?: string[]; intervalMs?: number };
  hiddenThinkingLabel?: string;
  text?: string;
}

export interface ConversationRun {
  interruption?: { planRevision?: number; goalId?: string };
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  diff?: RunDiff;
  diffError?: string;
}

export interface PiDesktopApi {
  manageSkills(conversationId: string, command: import("./skills.js").SkillsCommand): Promise<import("./skills.js").SkillsCatalog | import("./skills.js").SkillDocument | { valid: boolean; errors: string[] }>;
  getNotebookCharacterLimit(): Promise<number>;
  setNotebookCharacterLimit(value: number): Promise<number>;
  readonly webClient?: boolean;
  readonly webMode?: "local" | "remote";
  getGeneratedMediaUrl?(kind: string, filename: string): string;
  showGeneratedOnClient?(kind: string, filename: string): Promise<unknown>;
  getWebAccessSettings(): Promise<import("./web-access.js").WebAccessStatus>;
  saveWebAccessSettings(settings: import("./web-access.js").WebAccessSettings): Promise<import("./web-access.js").WebAccessStatus>;
  bootstrap(): Promise<BootstrapPayload>;
  rendererReady(): void;
  chooseProjectFolders(): Promise<string[]>;
  createProject(name: string, paths: string[]): Promise<ProjectRecord>;
  refreshProjectSessions(projectId: string): Promise<ConversationRecord[]>;
  searchConversations(query: string): Promise<string[]>;
  chooseAttachments(): Promise<Attachment[]>;
  getDroppedFilePath(file: File): string;
  attachFilePaths(paths: string[]): Promise<Attachment[]>;
  removeProject(projectId: string): Promise<boolean>;
  renameProject(projectId: string, name: string): Promise<ProjectRecord>;
  createConversation(projectId?: string): Promise<ConversationSnapshot>;
  openConversation(conversationId: string): Promise<ConversationSnapshot>;
  deleteConversation(conversationId: string): Promise<boolean>;
  archiveConversation(conversationId: string): Promise<void>;
  restoreConversation(conversationId: string): Promise<void>;
  sendPrompt(
    conversationId: string,
    message: string,
    attachments: Attachment[],
    behavior?: "steer" | "followUp",
    requestPlan?: boolean,
  ): Promise<void>;
  queuePrompt(conversationId: string, message: string, attachments: Attachment[], requestPlan?: boolean): Promise<QueuedPrompt[]>;
  sendQueuedPrompt(conversationId: string, promptId: string): Promise<QueuedPrompt[]>;
  removeQueuedPrompt(conversationId: string, promptId: string): Promise<QueuedPrompt[]>;
  abort(conversationId: string): Promise<void>;
  resumeConversation(conversationId: string): Promise<void>;
  rewindConversation(conversationId: string, entryId: string): Promise<ConversationSnapshot>;
  editLastMessage(conversationId: string, entryId: string, text: string): Promise<void>;
  setGoal(conversationId: string, objective: string, attachments: Attachment[], requestPlan?: boolean): Promise<void>;
  controlGoal(conversationId: string, action: "pause" | "resume" | "remove"): Promise<void>;
  editGoal(conversationId: string, objective: string): Promise<void>;
  removePlan(conversationId: string): Promise<void>;
  controlPlan(conversationId: string, action: "pause" | "resume"): Promise<void>;
  saveNotebook(conversationId: string, content: string, expectedRevision: number): Promise<ConversationNotebook>;
  browserUi(command: import("./browser.js").BrowserUiCommand): Promise<import("./browser.js").BrowserState>;
  onBrowserChanged(listener: (state: import("./browser.js").BrowserState) => void): () => void;
  setModel(conversationId: string, provider: string, modelId: string): Promise<RuntimeState>;
  setThinkingLevel(conversationId: string, level: ThinkingLevel): Promise<RuntimeState>;
  setHostEditorText(conversationId: string, text: string): Promise<void>;
  clearQueue(conversationId: string): Promise<{ steering: string[]; followUp: string[] }>;
  compactConversation(conversationId: string, customInstructions?: string): Promise<ConversationSnapshot>;
  reloadRuntime(conversationId: string): Promise<ConversationSnapshot>;
  renameConversation(conversationId: string, title: string): Promise<void>;
  respondToExtensionUi(conversationId: string, response: Record<string, unknown>): Promise<void>;
  getGlobalPrompt(): Promise<string>;
  getComfySettings(): Promise<import("./comfy.js").ComfySettings>;
  saveComfySettings(settings: import("./comfy.js").ComfySettings): Promise<import("./comfy.js").ComfySettings>;
  checkComfyConnection(url: string): Promise<string>;
  listComfyWorkflows(query?: string, offset?: number): Promise<import("./comfy.js").ComfyWorkflowSummary>;
  inspectComfyWorkflow(id: string): Promise<import("./comfy.js").ComfyWorkflowInspection>;
  importComfyWorkflow(): Promise<string | null>;
  saveGlobalPrompt(prompt: string): Promise<string>;
  getProjectInstructions(projectId: string): Promise<ProjectInstructions>;
  saveProjectInstructions(projectId: string, content: string): Promise<ProjectInstructions>;
  getModelServers(): Promise<ConfiguredModelServer[]>;
  discoverModelServer(input: ModelServerDiscoveryInput): Promise<ModelServerDiscoveryResult>;
  updateConfiguredModel(input: ConfiguredModelUpdate): Promise<ConfiguredModelServer>;
  deleteConfiguredModel(providerId: string, modelId: string): Promise<ConfiguredModelServer | null>;
  deleteModelServer(providerId: string): Promise<boolean>;
  getUpdateStatus(force?: boolean): Promise<UpdateStatus>;
  updateComponent(id: UpdateComponentId): Promise<UpdateResult>;
  updateAllComponents(): Promise<UpdateResult>;
  getModuleSettings(): Promise<ModuleSettings>;
  setBuiltinModuleEnabled(id: BuiltinModuleId, enabled: boolean): Promise<ModuleSettings>;
  addUserExtension(kind: "file" | "directory"): Promise<ModuleSettings | null>;
  removeUserExtension(name: string): Promise<ModuleSettings | null>;
  showItemInFolder(path: string): Promise<void>;
  showGeneratedFile(kind: "image" | "music" | "model3d", filename: string): Promise<void>;
  openGeneratedLink(url: string): Promise<void>;
  onPiEvent(listener: (payload: { conversationId: string; event: Record<string, unknown> }) => void): () => void;
  onExtensionUi(listener: (payload: { conversationId: string; request: ExtensionUiRequest }) => void): () => void;
  onConversationChanged(listener: (conversation: ConversationRecord) => void): () => void;
  onControlSelect(listener: (selection: { requestId: string; snapshot: ConversationSnapshot }) => void): () => void;
  controlSelectionReady(requestId: string): void;
}
