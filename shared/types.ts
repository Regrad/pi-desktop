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

export interface ConversationRecord {
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

export interface Attachment {
  id: string;
  name: string;
  path: string;
  mimeType?: string;
  data?: string;
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

export interface ConversationSnapshot {
  conversation: ConversationRecord;
  state: RuntimeState;
  messages: unknown[];
  models: ModelInfo[];
  thinkingLevels: ThinkingLevel[];
  commands: Array<{ name: string; description?: string; source: string }>;
  entries: SessionEntryView[];
  extensionState: ExtensionState;
  extensionUi: ExtensionUiState;
  run?: ConversationRun;
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
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  diff?: RunDiff;
  diffError?: string;
}

export interface PiDesktopApi {
  bootstrap(): Promise<BootstrapPayload>;
  chooseProjectFolders(): Promise<string[]>;
  createProject(name: string, paths: string[]): Promise<ProjectRecord>;
  refreshProjectSessions(projectId: string): Promise<ConversationRecord[]>;
  searchConversations(query: string): Promise<string[]>;
  chooseAttachments(): Promise<Attachment[]>;
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
  ): Promise<void>;
  abort(conversationId: string): Promise<void>;
  setModel(conversationId: string, provider: string, modelId: string): Promise<RuntimeState>;
  setThinkingLevel(conversationId: string, level: ThinkingLevel): Promise<RuntimeState>;
  setHostEditorText(conversationId: string, text: string): Promise<void>;
  clearQueue(conversationId: string): Promise<{ steering: string[]; followUp: string[] }>;
  renameConversation(conversationId: string, title: string): Promise<void>;
  respondToExtensionUi(conversationId: string, response: Record<string, unknown>): Promise<void>;
  getGlobalPrompt(): Promise<string>;
  saveGlobalPrompt(prompt: string): Promise<string>;
  getModelServers(): Promise<ConfiguredModelServer[]>;
  discoverModelServer(input: ModelServerDiscoveryInput): Promise<ModelServerDiscoveryResult>;
  showItemInFolder(path: string): Promise<void>;
  onPiEvent(listener: (payload: { conversationId: string; event: Record<string, unknown> }) => void): () => void;
  onExtensionUi(listener: (payload: { conversationId: string; request: ExtensionUiRequest }) => void): () => void;
  onConversationChanged(listener: (conversation: ConversationRecord) => void): () => void;
}
