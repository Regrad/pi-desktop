export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

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
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
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
}

export interface ExtensionUiRequest {
  type: "extension_ui_request";
  id: string;
  method: "select" | "confirm" | "input" | "editor" | "notify" | "setStatus" | "setWorkingMessage" | "setWidget" | "setTitle" | "set_editor_text";
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
  text?: string;
}

export interface PiDesktopApi {
  bootstrap(): Promise<BootstrapPayload>;
  chooseProjectFolders(): Promise<string[]>;
  createProject(name: string, paths: string[]): Promise<ProjectRecord>;
  refreshProjectSessions(projectId: string): Promise<ConversationRecord[]>;
  chooseAttachments(): Promise<Attachment[]>;
  removeProject(projectId: string): Promise<void>;
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
  renameConversation(conversationId: string, title: string): Promise<void>;
  respondToExtensionUi(conversationId: string, response: Record<string, unknown>): Promise<void>;
  showItemInFolder(path: string): Promise<void>;
  onPiEvent(listener: (payload: { conversationId: string; event: Record<string, unknown> }) => void): () => void;
  onExtensionUi(listener: (payload: { conversationId: string; request: ExtensionUiRequest }) => void): () => void;
  onConversationChanged(listener: (conversation: ConversationRecord) => void): () => void;
}
