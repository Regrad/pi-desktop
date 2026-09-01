import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bot,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Clock3,
  Cpu,
  FileText,
  Folder,
  FolderOpen,
  Gauge,
  Menu,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeft,
  Paperclip,
  Plus,
  Search,
  Send,
  Settings,
  Sparkles,
  Pencil,
  Trash2,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  Attachment,
  BootstrapPayload,
  ConversationRecord,
  ConversationSnapshot,
  ExtensionState,
  ExtensionUiRequest,
  ExtensionWidgetState,
  DiffHunk,
  ModelInfo,
  ProjectRecord,
  RunDiff,
  ThinkingLevel,
} from "../shared/types";

type JsonObject = Record<string, any>;

interface ToolActivity {
  id: string;
  name: string;
  args?: unknown;
  result?: unknown;
  running: boolean;
  error?: boolean;
  startedAt: number;
}

interface Notice {
  id: string;
  message: string;
  type: "info" | "warning" | "error";
}

type SettingsSection = "general" | "models" | "modules" | "configuration" | "archive" | "about";

interface ConversationMenuState {
  conversationId: string;
  x: number;
  y: number;
}

interface ProjectMenuState {
  projectId: string;
  x: number;
  y: number;
}

const THINKING_LABELS: Record<ThinkingLevel, string> = {
  off: "Без рассуждений",
  minimal: "Минимально",
  low: "Низкая",
  medium: "Средняя",
  high: "Высокая",
  xhigh: "Очень высокая",
  max: "Максимальная",
};

function messageKey(message: JsonObject, index: number): string {
  return String(message.id ?? message.timestamp ?? `${message.role}-${index}`);
}

function messageText(message: JsonObject): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part: JsonObject) => part?.type === "text")
    .map((part: JsonObject) => String(part.text ?? ""))
    .join("\n");
}

function textFromResult(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const content = (result as JsonObject).content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item?.type === "text") return String(item.text ?? "");
        if (item?.type === "image") return `[Изображение: ${String(item.mimeType ?? "image")}]`;
        if (item?.type === "audio") return `[Аудио: ${String(item.mimeType ?? "audio")}]`;
        if (item?.type === "resource_link") return `[Ресурс: ${String(item.title ?? item.name ?? item.uri ?? "ссылка")}]`;
        if (item?.type === "resource") return `[Встроенный ресурс: ${String(item.resource?.uri ?? "данные")}]`;
        return `[${String(item?.type ?? "данные")}]`;
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(result, null, 2);
}

function mediaSource(part: JsonObject): string | undefined {
  if (typeof part.data === "string") {
    return `data:${String(part.mimeType ?? "application/octet-stream")};base64,${part.data}`;
  }
  if (typeof part.url === "string") return part.url;
  if (typeof part.image_url === "string") return part.image_url;
  return undefined;
}

function ContentParts({ content }: { content: JsonObject[] }) {
  return <>{content.map((part, index) => {
    if (part.type === "text") return <Markdown key={index} text={String(part.text ?? "")} />;
    if (part.type === "image") {
      const src = mediaSource(part);
      return src ? <img className="content-image" key={index} src={src} alt="Изображение" /> : <div className="muted" key={index}>Изображение недоступно</div>;
    }
    if (part.type === "audio") {
      const src = mediaSource(part);
      return src ? <audio className="content-audio" key={index} src={src} controls /> : <div className="muted" key={index}>Аудио недоступно</div>;
    }
    if (part.type === "resource_link") {
      const href = String(part.uri ?? "");
      return <a className="resource-link" key={index} href={href} target="_blank" rel="noreferrer">{String(part.title ?? part.name ?? href)}</a>;
    }
    if (part.type === "resource") {
      const resource = part.resource as JsonObject | undefined;
      return <pre className="embedded-resource" key={index}>{String(resource?.text ?? `[${resource?.uri ?? "Ресурс"}]`)}</pre>;
    }
    return null;
  })}</>;
}

function MessageContent({ message, thinkingLabel }: { message: JsonObject; thinkingLabel?: string }) {
  const content = message.content;
  if (typeof content === "string") {
    return (
      <>
        <Markdown text={content} />
        {Array.isArray(message.attachments) && (
          <div className="message-attachments">
            {message.attachments.map((name: string) => <span key={name}><Paperclip size={12} />{name}</span>)}
          </div>
        )}
      </>
    );
  }
  if (!Array.isArray(content)) return null;
  return (
    <>
      {content.map((part: JsonObject, index: number) => {
        if (["text", "image", "audio", "resource", "resource_link"].includes(String(part.type))) {
          return <ContentParts key={index} content={[part]} />;
        }
        if (part.type === "thinking") {
          return (
            <details className="thinking-block" key={index}>
              <summary><Sparkles size={14} /> {thinkingLabel || "Рассуждения"}</summary>
              <div>{String(part.thinking ?? part.text ?? "")}</div>
            </details>
          );
        }
        if (part.type === "toolCall" || part.type === "tool_call") {
          return (
            <div className="inline-tool" key={index}>
              <Wrench size={14} />
              <span>{String(part.name ?? "Инструмент")}</span>
              {part.arguments && <code>{typeof part.arguments === "string" ? part.arguments : JSON.stringify(part.arguments)}</code>}
            </div>
          );
        }
        return null;
      })}
    </>
  );
}

function PersistedToolResult({ message }: { message: JsonObject }) {
  const [expanded, setExpanded] = useState(Boolean(message.isError));
  const content = Array.isArray(message.content)
    ? message.content as JsonObject[]
    : typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : [];
  return (
    <div className={`tool-card persisted ${message.isError ? "error" : ""}`}>
      <button className="tool-card-head" onClick={() => setExpanded((value) => !value)}>
        {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <Wrench size={15} />
        <span>{String(message.toolName ?? message.name ?? "Инструмент")}</span>
        <span className="tool-state">{message.isError ? "Ошибка" : "Результат"}</span>
      </button>
      {expanded && <div className="tool-card-body"><ContentParts content={content} /></div>}
    </div>
  );
}

function ToolResultContent({ result }: { result: unknown }) {
  if (result && typeof result === "object" && Array.isArray((result as JsonObject).content)) {
    return <ContentParts content={(result as JsonObject).content as JsonObject[]} />;
  }
  return <pre>{textFromResult(result)}</pre>;
}

function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
      a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
      code: ({ children, className }) => <code className={className}>{children}</code>,
    }}>
      {text}
    </ReactMarkdown>
  );
}

function ToolCard({ tool }: { tool: ToolActivity }) {
  const [expanded, setExpanded] = useState(tool.running);
  useEffect(() => {
    if (tool.error) setExpanded(true);
  }, [tool.error]);
  return (
    <div className={`tool-card ${tool.error ? "error" : ""}`}>
      <button className="tool-card-head" onClick={() => setExpanded((value) => !value)}>
        {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <Wrench size={15} />
        <span>{tool.name}</span>
        <span className="tool-state">{tool.running ? "Выполняется…" : tool.error ? "Ошибка" : "Готово"}</span>
      </button>
      {expanded && (
        <div className="tool-card-body">
          {tool.args !== undefined && <pre>{JSON.stringify(tool.args, null, 2)}</pre>}
          {tool.result !== undefined && <ToolResultContent result={tool.result} />}
        </div>
      )}
    </div>
  );
}

function WorkingIndicator({ indicator }: { indicator?: { frames?: string[]; intervalMs?: number } }) {
  const frames = indicator?.frames?.filter(Boolean) ?? [];
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0);
    if (frames.length < 2) return;
    const timer = setInterval(() => setIndex((value) => (value + 1) % frames.length), Math.max(60, indicator?.intervalMs ?? 100));
    return () => clearInterval(timer);
  }, [frames.join("\u0000"), indicator?.intervalMs]);
  return frames.length ? <span className="working-frame">{frames[index] ?? frames[0]}</span> : <span className="spinner" />;
}

function DiffHunkView({ hunk }: { hunk: DiffHunk }) {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return (
    <div className="diff-hunk">
      <div className="diff-hunk-header">@@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@</div>
      {hunk.lines.map((line, index) => {
        const marker = line[0] ?? " ";
        const isAdded = marker === "+";
        const isRemoved = marker === "-";
        const oldNumber = isAdded ? "" : oldLine++;
        const newNumber = isRemoved ? "" : newLine++;
        return (
          <div className={`diff-line ${isAdded ? "added" : isRemoved ? "removed" : "context"}`} key={`${index}-${line}`}>
            <span>{oldNumber}</span><span>{newNumber}</span><code>{line}</code>
          </div>
        );
      })}
    </div>
  );
}

function DiffPanel({ diff, onClose }: { diff: RunDiff; onClose: () => void }) {
  return (
    <aside className="diff-panel">
      <header className="diff-panel-title"><strong>Изменения за прогон</strong><button className="icon-button" onClick={onClose}><X size={17} /></button></header>
      <div className="diff-panel-summary">
        <span>{diff.files.length} {pluralFiles(diff.files.length)}</span>
        <span className="diff-add">+{diff.additions}</span>
        <span className="diff-remove">−{diff.deletions}</span>
      </div>
      {diff.incomplete && <div className="diff-warning">Некоторые большие или двоичные файлы изменились и не показаны.</div>}
      <div className="diff-files">
        {diff.files.map((file) => (
          <section className="diff-file" key={file.path}>
            <div className="diff-file-head" title={file.path}>
              <FileText size={14} /><span>{file.relativePath}</span><small className="diff-add">+{file.additions}</small><small className="diff-remove">−{file.deletions}</small>
            </div>
            {file.hunks.map((hunk, index) => <DiffHunkView hunk={hunk} key={`${hunk.oldStart}-${hunk.newStart}-${index}`} />)}
          </section>
        ))}
        {!diff.files.length && <div className="diff-empty">Текстовые файлы не изменялись.</div>}
      </div>
    </aside>
  );
}

function ExtensionDialog({
  item,
  onClose,
}: {
  item: { conversationId: string; request: ExtensionUiRequest };
  onClose: () => void;
}) {
  const { conversationId, request } = item;
  const [value, setValue] = useState(request.prefill ?? "");
  const respond = async (payload: Record<string, unknown>) => {
    await window.piDesktop.respondToExtensionUi(conversationId, { id: request.id, ...payload });
    if (typeof payload.customInput !== "string") onClose();
  };

  useEffect(() => {
    if (request.method !== "custom") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const input = terminalInputFromKeyboard(event);
      if (!input) return;
      event.preventDefault();
      event.stopPropagation();
      void respond({ customInput: input });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [conversationId, request.id, request.method]);

  return (
    <div className="modal-backdrop">
      <div className="modal-card">
        <div className="modal-head">
          <strong>{request.title ?? "Расширение Pi"}</strong>
          <button className="icon-button" onClick={() => void respond({ cancelled: true })}><X size={17} /></button>
        </div>
        {request.message && <p>{request.message}</p>}
        {request.method === "custom" && (
          <pre className="extension-custom-frame">{(request.customLines ?? []).join("\n")}</pre>
        )}
        {request.method === "select" && (
          <div className="select-list">
            {(request.options ?? []).map((option) => (
              <button key={option} onClick={() => void respond({ value: option })}>{option}</button>
            ))}
          </div>
        )}
        {(request.method === "input" || request.method === "editor") && (
          request.method === "editor"
            ? <textarea className="modal-editor" value={value} onChange={(event) => setValue(event.target.value)} autoFocus />
            : <input className="modal-input" value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} autoFocus />
        )}
        <div className="modal-actions">
          <button onClick={() => void respond({ cancelled: true })}>{request.method === "custom" ? "Закрыть" : "Отмена"}</button>
          {request.method === "confirm" && <button onClick={() => void respond({ confirmed: false })}>Нет</button>}
          {request.method === "confirm" && <button className="primary" onClick={() => void respond({ confirmed: true })}>Да</button>}
          {(request.method === "input" || request.method === "editor") && (
            <button className="primary" onClick={() => void respond({ value })}>Готово</button>
          )}
        </div>
      </div>
    </div>
  );
}

function terminalInputFromKeyboard(event: KeyboardEvent): string | undefined {
  if (event.ctrlKey && event.key.length === 1) {
    const code = event.key.toLocaleLowerCase().charCodeAt(0);
    if (code >= 97 && code <= 122) return String.fromCharCode(code - 96);
  }
  const special: Record<string, string> = {
    ArrowUp: "\u001b[A",
    ArrowDown: "\u001b[B",
    ArrowRight: "\u001b[C",
    ArrowLeft: "\u001b[D",
    Enter: "\r",
    Escape: "\u001b",
    Tab: "\t",
    Backspace: "\u007f",
    Delete: "\u001b[3~",
    Home: "\u001b[H",
    End: "\u001b[F",
    PageUp: "\u001b[5~",
    PageDown: "\u001b[6~",
  };
  if (special[event.key]) return special[event.key];
  if (!event.altKey && !event.metaKey && event.key.length === 1) return event.key;
  return undefined;
}

function ProjectDialog({
  onClose,
  onCreated,
  onError,
}: {
  onClose: () => void;
  onCreated: (project: ProjectRecord) => void;
  onError: (message: string) => void;
}) {
  const [name, setName] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const addFolders = async () => {
    const selected = await window.piDesktop.chooseProjectFolders();
    if (!selected.length) return;
    setFolders((current) => [...current, ...selected.filter((item) => !current.includes(item))]);
    if (!name.trim()) {
      const suggested = selected[0].split(/[\\/]/).filter(Boolean).at(-1);
      if (suggested) setName(suggested);
    }
  };

  const create = async () => {
    if (!folders.length || saving) return;
    setSaving(true);
    try {
      const project = await window.piDesktop.createProject(name, folders);
      onCreated(project);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-card project-dialog">
        <div className="modal-head">
          <strong>Создать проект</strong>
          <button className="icon-button" onClick={onClose}><X size={17} /></button>
        </div>
        <label className="project-name-field">
          <span>Название</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Название проекта" autoFocus />
        </label>
        <div className="project-folders-head"><strong>Рабочие папки</strong><span>Первая папка будет основной</span></div>
        <div className="project-folders">
          {folders.map((folder, index) => (
            <div className="project-folder-chip" key={folder}>
              <Folder size={15} /><span>{folder}</span>{index === 0 && <small>Основная</small>}
              <button title="Убрать папку" onClick={() => setFolders((current) => current.filter((item) => item !== folder))}><X size={14} /></button>
            </div>
          ))}
          <button className="add-folders-button" onClick={() => void addFolders()}><Plus size={16} /> Добавить папки</button>
        </div>
        <div className="modal-actions">
          <button onClick={onClose}>Отмена</button>
          <button className="primary" disabled={!folders.length || saving} onClick={() => void create()}>{saving ? "Создание…" : "Создать проект"}</button>
        </div>
      </div>
    </div>
  );
}

function RenameConversationDialog({
  title,
  heading = "Переименовать чат",
  onClose,
  onSave,
}: {
  title: string;
  heading?: string;
  onClose: () => void;
  onSave: (title: string) => void;
}) {
  const [value, setValue] = useState(title);
  return (
    <div className="modal-backdrop">
      <form className="modal-card rename-dialog" onSubmit={(event) => {
        event.preventDefault();
        const normalized = value.trim();
        if (normalized) onSave(normalized);
      }}>
        <div className="modal-head"><strong>{heading}</strong><button type="button" className="icon-button" onClick={onClose}><X size={17} /></button></div>
        <input className="modal-input" value={value} onChange={(event) => setValue(event.target.value)} autoFocus />
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Отмена</button>
          <button className="primary" type="submit" disabled={!value.trim()}>Сохранить</button>
        </div>
      </form>
    </div>
  );
}

function SettingRow({
  title,
  description,
  value,
  action,
}: {
  title: string;
  description: string;
  value?: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="setting-row">
      <div><strong>{title}</strong><p>{description}</p></div>
      <div className="setting-row-control">
        {value && <span className="setting-value">{value}</span>}
        {action && <button onClick={action.onClick}>{action.label}</button>}
      </div>
    </div>
  );
}

function SettingsPage({
  section,
  onSectionChange,
  onBack,
  dataDir,
  sessionsDir,
  models,
  currentModel,
  thinkingLevels,
  extensionState,
  archivedConversations,
  projects,
  onRestoreConversation,
  onDeleteConversation,
}: {
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onBack: () => void;
  dataDir?: string;
  sessionsDir?: string;
  models: ModelInfo[];
  currentModel?: ModelInfo | null;
  thinkingLevels: ThinkingLevel[];
  extensionState?: ExtensionState;
  archivedConversations: ConversationRecord[];
  projects: ProjectRecord[];
  onRestoreConversation: (conversationId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const sections: Array<{ id: SettingsSection; label: string; icon: typeof Settings }> = [
    { id: "general", label: "Общее", icon: Settings },
    { id: "models", label: "Модели", icon: Cpu },
    { id: "modules", label: "Модули", icon: Boxes },
    { id: "configuration", label: "Конфигурация Pi", icon: FileText },
    { id: "archive", label: "Архивированные чаты", icon: Archive },
    { id: "about", label: "О программе", icon: Bot },
  ];
  const visibleSections = sections.filter((item) => item.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const showDataFolder = () => {
    if (dataDir) void window.piDesktop.showItemInFolder(dataDir);
  };
  const showSessionsFolder = () => {
    if (sessionsDir) void window.piDesktop.showItemInFolder(sessionsDir);
  };

  return (
    <div className="settings-page">
      <aside className="settings-sidebar">
        <button className="settings-back" onClick={onBack}><ArrowLeft size={15} /> Вернуться в приложение</button>
        <div className="settings-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск настроек…" /></div>
        <div className="settings-group-title">Настройки Pi Desktop</div>
        <nav className="settings-nav">
          {visibleSections.map((item) => {
            const Icon = item.icon;
            return <button key={item.id} className={section === item.id ? "selected" : ""} onClick={() => onSectionChange(item.id)}><Icon size={15} />{item.label}</button>;
          })}
        </nav>
      </aside>
      <main className="settings-content">
        <div className="settings-inner">
          {section === "general" && (
            <>
              <h1>Общее</h1>
              <h2>Портативность</h2>
              <div className="settings-card">
                <SettingRow title="Папка данных приложения" description="Здесь находятся список проектов, настройки интерфейса и портативная конфигурация Pi." value={dataDir} action={{ label: "Показать", onClick: showDataFolder }} />
                <SettingRow title="История сессий Pi" description="Общее штатное хранилище, используемое обычным Pi и Pi Desktop без копирования сессий." value={sessionsDir} action={{ label: "Показать", onClick: showSessionsFolder }} />
                <SettingRow title="Обновления модулей" description="Версии расширений зафиксированы внутри переносимой сборки." value="Отключены" />
                <SettingRow title="Таймаут запроса" description="Максимальное ожидание ответа модели и RPC-команд." value="24 часа" />
              </div>
              <h2>Доступ</h2>
              <div className="settings-card">
                <SettingRow title="Режим Pi" description="Pi запущен с разрешением на штатные инструменты и подтверждённые расширения." value="Полный доступ" />
                <SettingRow title="Хранение" description="История хранится локально в исходном формате Pi и доступна обоим интерфейсам." value="Общее с Pi" />
              </div>
            </>
          )}
          {section === "models" && (
            <>
              <h1>Модели</h1>
              <h2>Текущий чат</h2>
              <div className="settings-card">
                <SettingRow title="Активная модель" description="Модель меняется непосредственно в нижней панели чата." value={currentModel?.name ?? currentModel?.id ?? "Чат не открыт"} />
                <SettingRow title="Доступные уровни рассуждений" description="Набор зависит от выбранной модели." value={thinkingLevels.length ? thinkingLevels.map((level) => THINKING_LABELS[level]).join(", ") : "Чат не открыт"} />
              </div>
              <h2>Доступные модели</h2>
              <div className="settings-card model-settings-list">
                {models.length ? models.map((model) => <SettingRow key={`${model.provider}/${model.id}`} title={model.name ?? model.id} description={`${model.provider} · контекст ${model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k` : "не указан"}`} value={model.reasoning ? "Рассуждения" : "Обычная"} />) : <div className="settings-empty">Откройте чат, чтобы Pi загрузил список моделей.</div>}
              </div>
            </>
          )}
          {section === "modules" && (
            <>
              <h1>Модули</h1>
              <p className="settings-lead">Фактическое состояние модулей, инструментов и ошибок из работающего процесса Pi.</p>
              <div className="settings-card module-list">
                {extensionState?.extensionPaths.length ? extensionState.extensionPaths.map((extensionPath) => {
                  const name = extensionName(extensionPath);
                  const normalizedName = `/${name}/`;
                  const tools = extensionState.tools.filter((tool) => tool.source?.replace(/\\/g, "/").includes(normalizedName));
                  const activeTools = tools.filter((tool) => tool.active).length;
                  const errors = extensionState.errors.filter((error) => error.extensionPath?.replace(/\\/g, "/").includes(normalizedName));
                  return <SettingRow
                    key={extensionPath}
                    title={name}
                    description={`${extensionPath}${tools.length ? ` · инструменты ${activeTools}/${tools.length}` : ""}${errors.length ? ` · ошибок ${errors.length}` : ""}`}
                    value={errors.length ? "Есть ошибки" : "Загружен"}
                  />;
                }) : <div className="settings-empty">Откройте чат, чтобы получить состояние расширений непосредственно из Pi.</div>}
              </div>
              {extensionState && <>
                <h2>Инструменты</h2>
                <div className="settings-card module-list">
                  <SettingRow title="Активные инструменты" description="Именно этот набор сейчас передаётся модели." value={`${extensionState.activeTools.length} из ${extensionState.tools.length}`} />
                  {extensionState.errors.map((error, index) => <SettingRow key={`${error.extensionPath}-${index}`} title="Ошибка расширения" description={`${error.extensionPath ?? "Неизвестный модуль"}: ${error.error}`} value={error.event ?? "runtime"} />)}
                </div>
                <details className="module-tools-details">
                  <summary>Показать активные инструменты</summary>
                  <div>{extensionState.activeTools.map((tool) => <code key={tool}>{tool}</code>)}</div>
                </details>
              </>}
            </>
          )}
          {section === "configuration" && (
            <>
              <h1>Конфигурация Pi</h1>
              <div className="settings-card">
                <SettingRow title="Модели" description="Конфигурация провайдеров и локальных моделей." value="data\\agent\\models.json" action={{ label: "Показать", onClick: showDataFolder }} />
                <SettingRow title="MCP" description="Подключения Godot AI и управления компьютером." value="data\\agent\\mcp.json" action={{ label: "Показать", onClick: showDataFolder }} />
                <SettingRow title="Глобальный промпт" description="Общие правила поведения моделей во всех проектах." value="data\\agent\\APPEND_SYSTEM.md" action={{ label: "Показать", onClick: showDataFolder }} />
                <SettingRow title="Настройки ядра" description="Параметры Pi, модулей, таймаутов и инструментов." value="data\\agent\\settings.json" action={{ label: "Показать", onClick: showDataFolder }} />
              </div>
            </>
          )}
          {section === "about" && (
            <>
              <h1>О программе</h1>
              <div className="settings-card">
                <SettingRow title="Pi Desktop" description="Портативный настольный интерфейс для Pi." value="0.1.0" />
                <SettingRow title="Pi Core" description="Встроенное ядро агента." value="0.84.2" />
                <SettingRow title="Интерфейс расширений" description="Инструменты, статусы, уведомления и диалоги работают через RPC." value="Активен" />
              </div>
            </>
          )}
          {section === "archive" && (
            <>
              <h1>Архивированные чаты</h1>
              <p className="settings-lead">Архив скрывает чат, но сохраняет исходную сессию Pi.</p>
              <div className="settings-card archived-chat-list">
                {archivedConversations.map((conversation) => (
                  <div className="archived-chat-row" key={conversation.id}>
                    <div>
                      <strong>{conversation.title}</strong>
                      <p>{conversation.projectId ? projects.find((project) => project.id === conversation.projectId)?.name ?? "Проект" : "Самостоятельный чат"}</p>
                    </div>
                    <div className="archived-chat-actions">
                      <button onClick={() => onRestoreConversation(conversation.id)}><ArchiveRestore size={14} /> Восстановить</button>
                      <button className="danger" onClick={() => onDeleteConversation(conversation.id)}><Trash2 size={14} /> Удалить</button>
                    </div>
                  </div>
                ))}
                {!archivedConversations.length && <div className="settings-empty">Архив пуст.</div>}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

export default function App() {
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [archivedConversations, setArchivedConversations] = useState<ConversationRecord[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const [activeConversationId, setActiveConversationId] = useState<string>();
  const [snapshot, setSnapshot] = useState<ConversationSnapshot>();
  const [messages, setMessages] = useState<JsonObject[]>([]);
  const [streamingMessage, setStreamingMessage] = useState<JsonObject | null>(null);
  const [tools, setTools] = useState<Record<string, ToolActivity>>({});
  const [working, setWorking] = useState(false);
  const [startedAt, setStartedAt] = useState<number>();
  const [elapsed, setElapsed] = useState(0);
  const [lastDuration, setLastDuration] = useState<number>();
  const [runDiff, setRunDiff] = useState<RunDiff>();
  const [diffOpen, setDiffOpen] = useState(false);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchMatches, setSearchMatches] = useState<Set<string>>();
  const [extensionDialog, setExtensionDialog] = useState<{ conversationId: string; request: ExtensionUiRequest }>();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [workingMessage, setWorkingMessage] = useState("");
  const [workingVisible, setWorkingVisible] = useState(true);
  const [workingIndicator, setWorkingIndicator] = useState<{ frames?: string[]; intervalMs?: number }>();
  const [hiddenThinkingLabel, setHiddenThinkingLabel] = useState("");
  const [widgets, setWidgets] = useState<ExtensionWidgetState[]>([]);
  const [headerLines, setHeaderLines] = useState<string[]>([]);
  const [footerLines, setFooterLines] = useState<string[]>([]);
  const [steeringMessages, setSteeringMessages] = useState<string[]>([]);
  const [followUpMessages, setFollowUpMessages] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [conversationMenu, setConversationMenu] = useState<ConversationMenuState>();
  const [projectMenu, setProjectMenu] = useState<ProjectMenuState>();
  const [renameConversation, setRenameConversation] = useState<ConversationRecord>();
  const [renameProject, setRenameProject] = useState<ProjectRecord>();
  const endRef = useRef<HTMLDivElement>(null);
  const activeIdRef = useRef<string | undefined>(undefined);
  const conversationsRef = useRef<ConversationRecord[]>([]);
  const startedAtRef = useRef<number | undefined>(undefined);
  const editorSyncRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchSequenceRef = useRef(0);
  const navigationSequenceRef = useRef(0);

  useEffect(() => {
    activeIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    if (!activeConversationId) return;
    clearTimeout(editorSyncRef.current);
    editorSyncRef.current = setTimeout(() => {
      void window.piDesktop.setHostEditorText(activeConversationId, input).catch(() => undefined);
    }, 180);
    return () => clearTimeout(editorSyncRef.current);
  }, [activeConversationId, input]);

  const addNotice = useCallback((message: string, type: Notice["type"] = "info") => {
    const notice = { id: crypto.randomUUID(), message, type };
    setNotices((current) => [...current, notice]);
    setTimeout(() => setNotices((current) => current.filter((item) => item.id !== notice.id)), 5_000);
  }, []);

  useEffect(() => {
    const query = search.trim();
    const sequence = ++searchSequenceRef.current;
    if (!query) {
      setSearchMatches(undefined);
      return;
    }
    const timer = setTimeout(() => {
      void window.piDesktop.searchConversations(query).then((ids) => {
        if (searchSequenceRef.current === sequence) setSearchMatches(new Set(ids));
      }).catch((error) => addNotice(error instanceof Error ? error.message : String(error), "error"));
    }, 250);
    return () => clearTimeout(timer);
  }, [search, addNotice]);

  useEffect(() => {
    void window.piDesktop.bootstrap().then((payload) => {
      setBootstrap(payload);
      setProjects(payload.projects);
      setConversations(payload.conversations);
      setArchivedConversations(payload.archivedConversations);
      setActiveProjectId(payload.activeProjectId);
      setActiveConversationId(payload.activeConversationId);
      setLoading(false);
      if (payload.activeConversationId) void openConversation(payload.activeConversationId);
    }).catch((error) => {
      setLoading(false);
      addNotice(String(error), "error");
    });
  }, [addNotice]);

  useEffect(() => window.piDesktop.onConversationChanged((conversation) => {
    setConversations((current) => {
      const found = current.some((item) => item.id === conversation.id);
      return found ? current.map((item) => item.id === conversation.id ? conversation : item) : [conversation, ...current];
    });
    setSnapshot((current) => current?.conversation.id === conversation.id
      ? { ...current, conversation }
      : current);
  }), []);

  useEffect(() => window.piDesktop.onPiEvent(({ conversationId, event }) => {
    if (conversationId !== activeIdRef.current) {
      if (event.type === "agent_settled") {
        const title = conversationsRef.current.find((item) => item.id === conversationId)?.title ?? "Фоновый чат";
        addNotice(`Задача завершена: ${title}`);
      }
      return;
    }
    handlePiEvent(event);
  }), [addNotice]);

  useEffect(() => window.piDesktop.onExtensionUi(({ conversationId, request }) => {
    if (request.method === "notify") {
      addNotice(request.message ?? "Уведомление расширения", request.notifyType ?? "info");
      return;
    }
    if (conversationId !== activeIdRef.current) {
      if (["select", "confirm", "input", "editor", "custom"].includes(request.method)) {
        const title = conversationsRef.current.find((item) => item.id === conversationId)?.title ?? "Фоновый чат";
        addNotice(`Расширение ожидает действие в чате «${title}»`, "warning");
      }
      return;
    }
    if (request.method === "setStatus" && request.statusKey) {
      setStatuses((current) => {
        const next = { ...current };
        const statusText = sanitizeStatusText(request.statusText);
        if (statusText) next[request.statusKey!] = statusText;
        else delete next[request.statusKey!];
        return next;
      });
      return;
    }
    if (request.method === "setWorkingMessage") {
      setWorkingMessage(sanitizeStatusText(request.workingText));
      return;
    }
    if (request.method === "setWorkingVisible") {
      setWorkingVisible(request.workingVisible !== false);
      return;
    }
    if (request.method === "setWorkingIndicator") {
      setWorkingIndicator(request.workingIndicator);
      return;
    }
    if (request.method === "setHiddenThinkingLabel") {
      setHiddenThinkingLabel(request.hiddenThinkingLabel ?? "");
      return;
    }
    if (request.method === "setWidget" && request.widgetKey) {
      setWidgets((current) => {
        const next = current.filter((widget) => widget.key !== request.widgetKey);
        if (request.widgetLines) next.push({
          key: request.widgetKey!,
          lines: request.widgetLines,
          placement: request.widgetPlacement ?? "aboveEditor",
        });
        return next;
      });
      return;
    }
    if (request.method === "setHeader") {
      setHeaderLines(request.customLines ?? []);
      return;
    }
    if (request.method === "setFooter") {
      setFooterLines(request.customLines ?? []);
      return;
    }
    if (request.method === "setTitle" && request.title) {
      document.title = request.title;
      return;
    }
    if (request.method === "set_editor_text") {
      setInput(request.text ?? "");
      return;
    }
    if (["select", "confirm", "input", "editor", "custom"].includes(request.method)) {
      setExtensionDialog({ conversationId, request });
      return;
    }
    if (request.method === "customClose") {
      setExtensionDialog((current) => current?.request.id === request.id ? undefined : current);
    }
  }), [addNotice]);

  useEffect(() => {
    if (!working || !startedAt) return;
    const update = () => setElapsed(Date.now() - startedAt);
    update();
    const timer = setInterval(update, 1_000);
    return () => clearInterval(timer);
  }, [working, startedAt]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, streamingMessage, tools]);

  const handlePiEvent = (event: JsonObject) => {
    if (event.type === "desktop_run_started" || event.type === "agent_start") {
      const runStartedAt = typeof event.run?.startedAt === "string" ? Date.parse(event.run.startedAt) : NaN;
      const now = Number.isFinite(runStartedAt) ? runStartedAt : (startedAtRef.current ?? Date.now());
      setWorking(true);
      setStartedAt(now);
      startedAtRef.current = now;
      setElapsed(0);
      setWorkingMessage("");
      setLastDuration(undefined);
      setRunDiff(undefined);
      setDiffOpen(false);
    } else if (event.type === "agent_settled") {
      setWorking(false);
      setWorkingMessage("");
      setStreamingMessage(null);
      const savedDuration = typeof event.run?.durationMs === "number" ? event.run.durationMs : undefined;
      if (startedAtRef.current || savedDuration !== undefined) {
        const duration = savedDuration ?? (Date.now() - startedAtRef.current!);
        setElapsed(duration);
        setLastDuration(duration);
        startedAtRef.current = undefined;
      }
      setTools({});
      if (event.state) {
        setSnapshot((current) => current ? {
          ...current,
          state: event.state,
          entries: Array.isArray(event.entries) ? event.entries : current.entries,
          extensionState: event.extensionState ?? current.extensionState,
        } : current);
      }
    } else if (event.type === "message_start") {
      if (event.message?.role === "assistant") setStreamingMessage(structuredClone(event.message));
      else if (event.message) {
        setMessages((current) => {
          const incomingText = messageText(event.message);
          let optimisticIndex = current.findIndex((item) => item.optimistic && messageText(item) === incomingText);
          if (optimisticIndex < 0) optimisticIndex = current.findIndex((item) => item.optimistic);
          if (optimisticIndex < 0) return [...current, event.message];
          const next = [...current];
          next[optimisticIndex] = { ...next[optimisticIndex], optimistic: false };
          return next;
        });
      }
    } else if (event.type === "message_update") {
      const delta = event.assistantMessageEvent;
      if (!delta) return;
      setStreamingMessage((current) => {
        const next = current ? structuredClone(current) : { role: "assistant", content: [] };
        if (!Array.isArray(next.content)) next.content = [];
        const index = Number(delta.contentIndex ?? 0);
        while (next.content.length <= index) next.content.push({ type: "text", text: "" });
        if (delta.type === "text_start") next.content[index] = { type: "text", text: "" };
        if (delta.type === "thinking_start") next.content[index] = { type: "thinking", thinking: "" };
        if (delta.type === "toolcall_start") next.content[index] = { type: "toolCall", name: delta.toolCall?.name ?? "Инструмент", arguments: "" };
        if (delta.type === "text_delta") next.content[index].text = `${next.content[index].text ?? ""}${delta.delta ?? ""}`;
        if (delta.type === "thinking_delta") next.content[index].thinking = `${next.content[index].thinking ?? ""}${delta.delta ?? ""}`;
        if (delta.type === "toolcall_delta") next.content[index].arguments = `${next.content[index].arguments ?? ""}${delta.delta ?? ""}`;
        if (delta.type === "toolcall_end" && delta.toolCall) next.content[index] = delta.toolCall;
        return next;
      });
    } else if (event.type === "message_end" && event.message) {
      if (event.message.role === "assistant") {
        setMessages((current) => [...current, event.message]);
        setStreamingMessage(null);
      } else if (event.message.role === "toolResult" || event.message.role === "tool") {
        setMessages((current) => [...current, event.message]);
      }
    } else if (event.type === "tool_execution_start") {
      setTools((current) => ({
        ...current,
        [event.toolCallId]: {
          id: event.toolCallId,
          name: event.toolName,
          args: event.args,
          running: true,
          startedAt: Date.now(),
        },
      }));
    } else if (event.type === "tool_execution_update") {
      setTools((current) => ({
        ...current,
        [event.toolCallId]: {
          ...(current[event.toolCallId] ?? { id: event.toolCallId, name: event.toolName, running: true, startedAt: Date.now() }),
          result: event.partialResult,
        },
      }));
    } else if (event.type === "tool_execution_end") {
      setTools((current) => ({
        ...current,
        [event.toolCallId]: {
          ...(current[event.toolCallId] ?? { id: event.toolCallId, name: event.toolName, startedAt: Date.now() }),
          result: event.result,
          running: false,
          error: Boolean(event.isError),
        },
      }));
    } else if (event.type === "queue_update") {
      const steering = Array.isArray(event.steering) ? event.steering.map(String) : [];
      const followUp = Array.isArray(event.followUp) ? event.followUp.map(String) : [];
      setSteeringMessages(steering);
      setFollowUpMessages(followUp);
      setSnapshot((current) => current ? {
        ...current,
        state: { ...current.state, steeringMessages: steering, followUpMessages: followUp, pendingMessageCount: steering.length + followUp.length },
      } : current);
    } else if (event.type === "runtime_error" || event.type === "extension_error") {
      addNotice(String(event.error ?? "Ошибка Pi"), "error");
      setWorking(false);
      setWorkingMessage("");
      if (typeof event.run?.durationMs === "number") setLastDuration(event.run.durationMs);
    } else if (event.type === "desktop_run_diff" && event.diff) {
      setRunDiff(event.diff as RunDiff);
      if (typeof event.run?.durationMs === "number") setLastDuration(event.run.durationMs);
    } else if (event.type === "desktop_preparing") {
      setWorking(true);
      setWorkingMessage(String(event.message ?? "Подготовка…"));
    } else if (event.type === "desktop_diff_error") {
      addNotice(`Не удалось построить diff: ${String(event.error ?? "неизвестная ошибка")}`, "warning");
    }
  };

  const openConversation = async (conversationId: string) => {
    const navigationSequence = ++navigationSequenceRef.current;
    setActiveConversationId(conversationId);
    const conversation = conversations.find((item) => item.id === conversationId);
    if (conversation) setActiveProjectId(conversation.projectId);
    setLoading(true);
    setMessages([]);
    setStreamingMessage(null);
    setTools({});
    setAttachments([]);
    setStatuses({});
    setWorkingMessage("");
    setWorkingVisible(true);
    setWorkingIndicator(undefined);
    setHiddenThinkingLabel("");
    setWidgets([]);
    setHeaderLines([]);
    setFooterLines([]);
    setSteeringMessages([]);
    setFollowUpMessages([]);
    setExtensionDialog(undefined);
    setLastDuration(undefined);
    setRunDiff(undefined);
    setDiffOpen(false);
    try {
      const next = await window.piDesktop.openConversation(conversationId);
      if (navigationSequenceRef.current !== navigationSequence) return;
      setSnapshot(next);
      setActiveProjectId(next.conversation.projectId);
      setMessages(next.messages as JsonObject[]);
      setWorking(next.state.isStreaming);
      setStatuses(next.extensionUi.statuses);
      setWorkingMessage(next.extensionUi.workingMessage ?? "");
      setWorkingVisible(next.extensionUi.workingVisible);
      setWorkingIndicator(next.extensionUi.workingIndicator);
      setHiddenThinkingLabel(next.extensionUi.hiddenThinkingLabel ?? "");
      setWidgets(next.extensionUi.widgets);
      setHeaderLines(next.extensionUi.headerLines);
      setFooterLines(next.extensionUi.footerLines);
      setSteeringMessages(next.state.steeringMessages ?? []);
      setFollowUpMessages(next.state.followUpMessages ?? []);
      setExtensionDialog(next.extensionUi.pendingDialogs[0]
        ? { conversationId, request: next.extensionUi.pendingDialogs[0] }
        : undefined);
      document.title = next.extensionUi.title || "Pi Desktop";
      setRunDiff(next.run?.diff);
      setLastDuration(next.run?.durationMs);
      if (next.state.isStreaming) {
        const savedStartedAt = next.run?.startedAt ? Date.parse(next.run.startedAt) : NaN;
        const now = Number.isFinite(savedStartedAt) ? savedStartedAt : Date.now();
        setStartedAt(now);
        startedAtRef.current = now;
      } else {
        setStartedAt(undefined);
        startedAtRef.current = undefined;
      }
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      if (navigationSequenceRef.current === navigationSequence) setLoading(false);
    }
  };

  const newChat = async (projectId?: string) => {
    const navigationSequence = ++navigationSequenceRef.current;
    setLoading(true);
    try {
      const next = await window.piDesktop.createConversation(projectId);
      if (navigationSequenceRef.current !== navigationSequence) return;
      setConversations((current) => [next.conversation, ...current]);
      setActiveConversationId(next.conversation.id);
      setSnapshot(next);
      setActiveProjectId(next.conversation.projectId);
      setMessages([]);
      setTools({});
      setAttachments([]);
      setWorking(false);
      setWorkingMessage("");
      setWorkingVisible(true);
      setWorkingIndicator(next.extensionUi.workingIndicator);
      setHiddenThinkingLabel(next.extensionUi.hiddenThinkingLabel ?? "");
      setStatuses(next.extensionUi.statuses);
      setWidgets(next.extensionUi.widgets);
      setHeaderLines(next.extensionUi.headerLines);
      setFooterLines(next.extensionUi.footerLines);
      setSteeringMessages([]);
      setFollowUpMessages([]);
      setExtensionDialog(undefined);
      document.title = "Pi Desktop";
      setLastDuration(undefined);
      setRunDiff(undefined);
      setDiffOpen(false);
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      if (navigationSequenceRef.current === navigationSequence) setLoading(false);
    }
  };

  const projectCreated = async (project: ProjectRecord) => {
    setProjectDialogOpen(false);
    setProjects((current) => [project, ...current.filter((item) => item.id !== project.id)]);
    setActiveProjectId(project.id);
    try {
      const chats = await window.piDesktop.refreshProjectSessions(project.id);
      setConversations((current) => [
        ...chats,
        ...current.filter((item) => item.projectId !== project.id),
      ]);
      if (chats.length) await openConversation(chats[0].id);
      else await newChat(project.id);
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const showConversationMenu = (event: React.MouseEvent, conversationId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setConversationMenu({
      conversationId,
      x: Math.min(event.clientX, window.innerWidth - 220),
      y: Math.min(event.clientY, window.innerHeight - 150),
    });
  };

  const showProjectMenu = (event: React.MouseEvent, projectId: string) => {
    event.preventDefault();
    event.stopPropagation();
    setProjectMenu({
      projectId,
      x: Math.min(event.clientX, window.innerWidth - 230),
      y: Math.min(event.clientY, window.innerHeight - 180),
    });
  };

  const clearConversationView = (conversationId: string) => {
    if (activeConversationId !== conversationId) return;
    setActiveConversationId(undefined);
    setActiveProjectId(undefined);
    setSnapshot(undefined);
    setMessages([]);
    setStreamingMessage(null);
    setTools({});
    setWorking(false);
    setWorkingMessage("");
    setWorkingIndicator(undefined);
    setHiddenThinkingLabel("");
    setWidgets([]);
    setHeaderLines([]);
    setFooterLines([]);
    setSteeringMessages([]);
    setFollowUpMessages([]);
    setExtensionDialog(undefined);
  };

  const archiveChat = async (conversationId: string) => {
    setConversationMenu(undefined);
    try {
      await window.piDesktop.archiveConversation(conversationId);
      const conversation = conversations.find((item) => item.id === conversationId);
      setConversations((current) => current.filter((item) => item.id !== conversationId));
      if (conversation) setArchivedConversations((current) => [{ ...conversation, archived: true, status: "idle" }, ...current]);
      clearConversationView(conversationId);
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const restoreChat = async (conversationId: string) => {
    try {
      await window.piDesktop.restoreConversation(conversationId);
      const conversation = archivedConversations.find((item) => item.id === conversationId);
      setArchivedConversations((current) => current.filter((item) => item.id !== conversationId));
      if (conversation) setConversations((current) => [{ ...conversation, archived: false }, ...current]);
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const deleteChat = async (conversationId: string) => {
    setConversationMenu(undefined);
    try {
      const deleted = await window.piDesktop.deleteConversation(conversationId);
      if (!deleted) return;
      setConversations((current) => current.filter((item) => item.id !== conversationId));
      setArchivedConversations((current) => current.filter((item) => item.id !== conversationId));
      clearConversationView(conversationId);
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const saveConversationTitle = async (title: string) => {
    const conversation = renameConversation;
    if (!conversation) return;
    setRenameConversation(undefined);
    try {
      await window.piDesktop.renameConversation(conversation.id, title);
      setConversations((current) => current.map((item) => item.id === conversation.id ? { ...item, title } : item));
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const saveProjectTitle = async (name: string) => {
    const project = renameProject;
    if (!project) return;
    setRenameProject(undefined);
    try {
      const updated = await window.piDesktop.renameProject(project.id, name);
      setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const removeProject = async (projectId: string) => {
    setProjectMenu(undefined);
    try {
      const removed = await window.piDesktop.removeProject(projectId);
      if (!removed) return;
      setProjects((current) => current.filter((item) => item.id !== projectId));
      setConversations((current) => current.filter((item) => item.projectId !== projectId));
      if (activeProjectId === projectId) {
        setActiveProjectId(undefined);
        setActiveConversationId(undefined);
        setSnapshot(undefined);
        setMessages([]);
      }
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const submit = async (steerNow = false) => {
    const text = input.trim() || (attachments.length ? "Посмотри вложения." : "");
    if (!text || !activeConversationId) return;
    const submittedAttachments = attachments;
    setInput("");
    setAttachments([]);
    const optimistic = {
      id: `local-${crypto.randomUUID()}`,
      role: "user",
      content: text,
      attachments: submittedAttachments.map((item) => item.name),
      optimistic: true,
    };
    if (!working) setMessages((current) => [...current, optimistic]);
    try {
      await window.piDesktop.sendPrompt(
        activeConversationId,
        text,
        submittedAttachments,
        working ? (steerNow ? "steer" : "followUp") : undefined,
      );
    } catch (error) {
      if (!working) setMessages((current) => current.filter((item) => item.id !== optimistic.id));
      setInput(text);
      setAttachments(submittedAttachments);
      addNotice(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const restoreQueuedMessages = async () => {
    if (!activeConversationId) return;
    try {
      const queued = await window.piDesktop.clearQueue(activeConversationId);
      const restored = [...queued.steering, ...queued.followUp].join("\n\n");
      if (restored) setInput((current) => current ? `${restored}\n\n${current}` : restored);
      setSteeringMessages([]);
      setFollowUpMessages([]);
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const addAttachments = async () => {
    try {
      const selected = await window.piDesktop.chooseAttachments();
      if (selected.length) {
        setAttachments((current) => [
          ...current,
          ...selected.filter((item) => !current.some((existing) => existing.path === item.path)),
        ]);
      }
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const changeModel = async (model: ModelInfo) => {
    if (!activeConversationId) return;
    setModelMenuOpen(false);
    try {
      const state = await window.piDesktop.setModel(activeConversationId, model.provider, model.id);
      setSnapshot((current) => current ? { ...current, state } : current);
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const changeThinking = async (level: ThinkingLevel) => {
    if (!activeConversationId) return;
    setThinkingMenuOpen(false);
    try {
      const state = await window.piDesktop.setThinkingLevel(activeConversationId, level);
      setSnapshot((current) => current ? { ...current, state } : current);
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const activeProject = projects.find((item) => item.id === activeProjectId);
  const activeConversation = conversations.find((item) => item.id === activeConversationId) ?? snapshot?.conversation;
  const grouped = useMemo(() => projects.map((project) => ({
    project,
    chats: conversations
      .filter((item) => item.projectId === project.id && (!searchMatches || searchMatches.has(item.id)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  })), [projects, conversations, searchMatches]);
  const standaloneChats = useMemo(() => conversations
    .filter((item) => !item.projectId && (!searchMatches || searchMatches.has(item.id)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [conversations, searchMatches]);
  const openProject = async (projectId: string) => {
    setActiveProjectId(projectId);
    try {
      const chats = await window.piDesktop.refreshProjectSessions(projectId);
      setConversations((current) => [
        ...chats,
        ...current.filter((item) => item.projectId !== projectId),
      ]);
      if (chats.length) await openConversation(chats[0].id);
      else await newChat(projectId);
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    }
  };
  const renderedMessages = streamingMessage ? [...messages, streamingMessage] : messages;
  const slashQuery = input.startsWith("/") && !input.includes(" ") ? input.slice(1).toLocaleLowerCase() : undefined;
  const slashCommands = slashQuery === undefined ? [] : (snapshot?.commands ?? [])
    .filter((command) => command.name.toLocaleLowerCase().includes(slashQuery))
    .slice(0, 10);
  let lastUserMessageIndex = -1;
  renderedMessages.forEach((message, index) => {
    if (message.role === "user") lastUserMessageIndex = index;
  });

  return (
    <div className="app-shell">
      <div className="titlebar">
        <div className="titlebar-drag">
          {!settingsOpen && <button className="title-icon" title={sidebarOpen ? "Скрыть боковую панель" : "Показать боковую панель"} onClick={() => setSidebarOpen((value) => !value)}><PanelLeft size={15} /></button>}
        </div>
      </div>

      <div className="workspace">
        {settingsOpen ? (
          <SettingsPage
            section={settingsSection}
            onSectionChange={setSettingsSection}
            onBack={() => setSettingsOpen(false)}
            dataDir={bootstrap?.dataDir}
            sessionsDir={bootstrap?.sessionsDir}
            models={snapshot?.models ?? []}
            currentModel={snapshot?.state.model}
            thinkingLevels={snapshot?.thinkingLevels ?? []}
            extensionState={snapshot?.extensionState}
            archivedConversations={archivedConversations}
            projects={projects}
            onRestoreConversation={(conversationId) => void restoreChat(conversationId)}
            onDeleteConversation={(conversationId) => void deleteChat(conversationId)}
          />
        ) : (
        <>
        {sidebarOpen && (
          <aside className="sidebar">
            <div className="sidebar-brand">
              <div className="brand-label">Pi Desktop</div>
            </div>
            <div className="search-box"><Search size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Поиск по чатам" /></div>
            <div className="project-list">
              <div className="sidebar-section-title"><span>Проекты</span><button title="Создать проект" onClick={() => setProjectDialogOpen(true)}><Plus size={15} /></button></div>
              {grouped.map(({ project, chats }) => (
                <section className="project-section" key={project.id} onContextMenu={(event) => showProjectMenu(event, project.id)}>
                  <div className="project-row-wrap">
                    <button className={`project-row ${activeProjectId === project.id ? "active" : ""}`} onClick={() => void openProject(project.id)}>
                      <Folder size={16} /><span>{project.name}</span>
                    </button>
                    <button className="project-new-chat" title={`Новый чат в проекте «${project.name}»`} onClick={() => void newChat(project.id)}><Plus size={14} /></button>
                    <button className="project-more" title="Действия с проектом" onClick={(event) => showProjectMenu(event, project.id)}><MoreHorizontal size={14} /></button>
                  </div>
                  <div className="chat-list">
                    {chats.map((chat) => (
                      <div className="chat-entry" key={chat.id} data-conversation-id={chat.id} onContextMenu={(event) => showConversationMenu(event, chat.id)}>
                        <button className={`chat-row ${chat.id === activeConversationId ? "selected" : ""}`} onClick={() => void openConversation(chat.id)}>
                          <span className={`status-dot ${chat.status}`} />
                          <span>{chat.title}</span>
                        </button>
                        <button className="chat-more" title="Действия с чатом" onClick={(event) => showConversationMenu(event, chat.id)}><MoreHorizontal size={15} /></button>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
              <button className="new-chat-button standalone-new-chat" onClick={() => void newChat()}>
                <MessageSquarePlus size={17} /> Новый чат
              </button>
              <div className="sidebar-section-title chats-title"><span>Чаты</span></div>
              <div className="standalone-chat-list">
                {standaloneChats.map((chat) => (
                  <div className="chat-entry" key={chat.id} data-conversation-id={chat.id} onContextMenu={(event) => showConversationMenu(event, chat.id)}>
                    <button className={`chat-row ${chat.id === activeConversationId ? "selected" : ""}`} onClick={() => void openConversation(chat.id)}>
                      <span className={`status-dot ${chat.status}`} />
                      <span>{chat.title}</span>
                    </button>
                    <button className="chat-more" title="Действия с чатом" onClick={(event) => showConversationMenu(event, chat.id)}><MoreHorizontal size={15} /></button>
                  </div>
                ))}
                {!standaloneChats.length && <div className="sidebar-empty">Самостоятельных чатов пока нет</div>}
              </div>
            </div>
            <button className="sidebar-footer" onClick={() => setSettingsOpen(true)}>
              <Settings size={16} /><span>Настройки</span>
            </button>
          </aside>
        )}

        <main className="main-panel">
          <header className="chat-header">
            <button className="icon-button" onClick={() => setSidebarOpen((value) => !value)}><Menu size={18} /></button>
            {activeProject ? <FolderOpen size={17} /> : <Bot size={17} />}
            <strong>{activeConversation?.title ?? activeProject?.name ?? "Pi Desktop"}</strong>
            <div className="header-spacer" />
            {activeProject && <button className="path-button" title={`Показать в проводнике: ${activeProject.path}`} onClick={() => void window.piDesktop.showItemInFolder(activeProject.path)}>{activeProject.name}</button>}
          </header>

          <div className="conversation-scroll">
            {!activeConversationId ? (
              <div className="welcome">
                <div className="welcome-logo"><Bot size={34} /></div>
                <h1>С чего начнём?</h1>
                <p>Начните самостоятельный чат или создайте проект с одной или несколькими рабочими папками.</p>
                <div className="welcome-actions">
                  <button className="primary large" onClick={() => void newChat()}><MessageSquarePlus size={18} /> Новый чат</button>
                  <button className="secondary large" onClick={() => setProjectDialogOpen(true)}><FolderOpen size={18} /> Создать проект</button>
                </div>
              </div>
            ) : (
              <div className="thread">
                {headerLines.length > 0 && <div className="extension-frame header-frame">{headerLines.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}</div>}
                {renderedMessages.map((message, index) => {
                  if (message.role === "toolResult" || message.role === "tool") {
                    return <PersistedToolResult key={messageKey(message, index)} message={message} />;
                  }
                  return (
                    <Fragment key={messageKey(message, index)}>
                      <article className={`message ${message.role ?? "assistant"}`}>
                        {message.role === "user" ? (
                          <div className="user-bubble"><MessageContent message={message} thinkingLabel={hiddenThinkingLabel} /></div>
                        ) : (
                          <div className="assistant-message"><MessageContent message={message} thinkingLabel={hiddenThinkingLabel} /></div>
                        )}
                      </article>
                      {working && workingVisible && index === lastUserMessageIndex && (
                        <div className="run-timer working"><WorkingIndicator indicator={workingIndicator} />{workingMessage ? <><span className="working-message">{workingMessage}</span><span className="working-elapsed">· {formatElapsed(elapsed)}</span></> : <>Работает уже {formatElapsed(elapsed)}</>}</div>
                      )}
                    </Fragment>
                  );
                })}
                {Object.values(tools).map((tool) => <ToolCard key={tool.id} tool={tool} />)}
                {snapshot?.entries.filter((entry) => entry.renderedLines?.length).map((entry, index) => (
                  <div className="extension-entry" key={entry.id ?? `${entry.type}-${index}`}>{entry.renderedLines!.map((line, lineIndex) => <div key={`${lineIndex}-${line}`}>{line}</div>)}</div>
                ))}
                {working && workingVisible && lastUserMessageIndex < 0 && (
                  <div className="run-timer working"><WorkingIndicator indicator={workingIndicator} />{workingMessage ? <><span className="working-message">{workingMessage}</span><span className="working-elapsed">· {formatElapsed(elapsed)}</span></> : <>Работает уже {formatElapsed(elapsed)}</>}</div>
                )}
                {!working && lastDuration !== undefined && (
                  <div className="run-complete">
                    <span><Clock3 size={13} /> Запрос занял {formatElapsed(lastDuration)}</span>
                    {runDiff && (runDiff.files.length > 0 || runDiff.incomplete) && (
                      <button className="diff-summary-chip" onClick={() => setDiffOpen(true)}>
                        Изменено {runDiff.files.length} {pluralFiles(runDiff.files.length)} <span className="diff-add">+{runDiff.additions}</span> <span className="diff-remove">−{runDiff.deletions}</span>
                      </button>
                    )}
                  </div>
                )}
                {footerLines.length > 0 && <div className="extension-frame footer-frame">{footerLines.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}</div>}
                <div ref={endRef} />
              </div>
            )}
          </div>

          {activeConversationId && (
            <div className="composer-wrap">
              {slashCommands.length > 0 && <div className="slash-menu">
                {slashCommands.map((command) => <button key={`${command.source}-${command.name}`} onClick={() => setInput(`/${command.name} `)}>
                  <span><strong>/{command.name}</strong><small>{command.description ?? command.source}</small></span>
                  <em>{command.source}</em>
                </button>)}
              </div>}
              {(steeringMessages.length > 0 || followUpMessages.length > 0) && <div className="queued-messages">
                <div className="queued-head"><span>В очереди: {steeringMessages.length + followUpMessages.length}</span><button onClick={() => void restoreQueuedMessages()}>Вернуть в редактор</button></div>
                {steeringMessages.map((message, index) => <div className="queued-message steer" key={`steer-${index}`}><Zap size={13} /><span>{message}</span><small>в текущую работу</small></div>)}
                {followUpMessages.map((message, index) => <div className="queued-message" key={`follow-${index}`}><Clock3 size={13} /><span>{message}</span><small>следом</small></div>)}
              </div>}
              {widgets.filter((widget) => widget.placement === "aboveEditor").map((widget) => <div className="extension-widget" key={widget.key}>{widget.lines.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}</div>)}
              <div className="composer">
                {attachments.length > 0 && (
                  <div className="attachment-list">
                    {attachments.map((attachment) => (
                      <div className="attachment-chip" key={attachment.id} title={attachment.path}>
                        <Paperclip size={13} />
                        <span>{attachment.name}</span>
                        <button onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}><X size={13} /></button>
                      </div>
                    ))}
                  </div>
                )}
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void submit(event.ctrlKey || event.metaKey);
                    }
                  }}
                  placeholder={working ? "Сообщение будет отправлено после завершения…" : "Спросите что-нибудь или опишите задачу"}
                  rows={2}
                />
                <div className="composer-toolbar">
                  <button className="icon-button" title="Добавить вложение" onClick={() => void addAttachments()}><Paperclip size={18} /></button>
                  <span className="access-chip"><Check size={13} /> Полный доступ</span>
                  <div className="composer-spacer" />
                  <div className="dropdown-wrap">
                    <button className="selector-button" onClick={() => setModelMenuOpen((value) => !value)}>
                      {snapshot?.state.model?.name ?? snapshot?.state.model?.id ?? "Модель"}<ChevronDown size={13} />
                    </button>
                    {modelMenuOpen && <div className="dropdown-menu model-menu">
                      {snapshot?.models.map((model) => <button key={`${model.provider}/${model.id}`} className="dropdown-item" onClick={() => void changeModel(model)}>
                        <span><strong>{model.name ?? model.id}</strong><small>{model.provider}</small></span>
                        {snapshot.state.model?.provider === model.provider && snapshot.state.model?.id === model.id && <Check size={15} />}
                      </button>)}
                    </div>}
                  </div>
                  <div className="dropdown-wrap">
                    <button className="selector-button" onClick={() => setThinkingMenuOpen((value) => !value)}>
                      {THINKING_LABELS[snapshot?.state.thinkingLevel ?? "off"]}<ChevronDown size={13} />
                    </button>
                    {thinkingMenuOpen && <div className="dropdown-menu thinking-menu">
                      {snapshot?.thinkingLevels.map((level) => <button key={level} className="dropdown-item" onClick={() => void changeThinking(level)}>
                        <span>{THINKING_LABELS[level]}</span>{snapshot.state.thinkingLevel === level && <Check size={15} />}
                      </button>)}
                    </div>}
                  </div>
                  {working ? (
                    <>
                      <button className="send-button steer" title="Отправить сейчас" disabled={!input.trim() && !attachments.length} onClick={() => void submit(true)}><Zap size={17} /></button>
                      <button className="send-button stop" title="Остановить" onClick={() => void window.piDesktop.abort(activeConversationId)}><CircleStop size={18} /></button>
                    </>
                  ) : (
                    <button className="send-button" disabled={!input.trim() && !attachments.length} onClick={() => void submit()}><Send size={17} /></button>
                  )}
                </div>
              </div>
              {widgets.filter((widget) => widget.placement === "belowEditor").map((widget) => <div className="extension-widget below" key={widget.key}>{widget.lines.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}</div>)}
              <div className="status-line">
                {Object.entries(statuses).map(([key, status]) => <span className="status-item" key={key} title={status}>{status}</span>)}
                {snapshot?.state.contextUsage && <span className="status-item status-context"><Gauge size={14} /> Контекст: {snapshot.state.contextUsage.tokens === null ? "—" : formatTokens(snapshot.state.contextUsage.tokens)} / {formatTokens(snapshot.state.contextUsage.contextWindow)}{snapshot.state.contextUsage.percent === null ? "" : ` (${Math.round(snapshot.state.contextUsage.percent)}%)`}</span>}
                {snapshot?.state.isCompacting && <span className="status-item compacting"><span className="spinner" /> Сжатие контекста</span>}
              </div>
            </div>
          )}
          {loading && <div className="loading-overlay"><span className="spinner" /> Загрузка Pi…</div>}
        </main>
        {diffOpen && runDiff && <DiffPanel diff={runDiff} onClose={() => setDiffOpen(false)} />}
        </>
        )}
      </div>

      <div className="toast-stack">{notices.map((notice) => <div key={notice.id} className={`toast ${notice.type}`}>{notice.message}</div>)}</div>
      {extensionDialog && <ExtensionDialog item={extensionDialog} onClose={() => setExtensionDialog(undefined)} />}
      {projectDialogOpen && <ProjectDialog onClose={() => setProjectDialogOpen(false)} onCreated={(project) => void projectCreated(project)} onError={(message) => addNotice(message, "error")} />}
      {projectMenu && (() => {
        const project = projects.find((item) => item.id === projectMenu.projectId);
        if (!project) return null;
        return (
          <div className="context-menu-layer" onPointerDown={() => setProjectMenu(undefined)}>
            <div className="conversation-menu" style={{ left: projectMenu.x, top: projectMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
              <button onClick={() => { setRenameProject(project); setProjectMenu(undefined); }}><Pencil size={15} /> Переименовать</button>
              <button onClick={() => { void window.piDesktop.showItemInFolder(project.path); setProjectMenu(undefined); }}><FolderOpen size={15} /> Показать папку</button>
              <button onClick={() => { void newChat(project.id); setProjectMenu(undefined); }}><MessageSquarePlus size={15} /> Новый чат</button>
              <div className="conversation-menu-separator" />
              <button className="danger" onClick={() => void removeProject(project.id)}><Trash2 size={15} /> Убрать проект</button>
            </div>
          </div>
        );
      })()}
      {conversationMenu && (() => {
        const conversation = conversations.find((item) => item.id === conversationMenu.conversationId);
        if (!conversation) return null;
        return (
          <div className="context-menu-layer" onPointerDown={() => setConversationMenu(undefined)}>
            <div className="conversation-menu" style={{ left: conversationMenu.x, top: conversationMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
              <button onClick={() => { setRenameConversation(conversation); setConversationMenu(undefined); }}><Pencil size={15} /> Переименовать</button>
              <button onClick={() => void archiveChat(conversation.id)}><Archive size={15} /> Архивировать</button>
              <div className="conversation-menu-separator" />
              <button className="danger" onClick={() => void deleteChat(conversation.id)}><Trash2 size={15} /> Удалить</button>
            </div>
          </div>
        );
      })()}
      {renameConversation && <RenameConversationDialog title={renameConversation.title} onClose={() => setRenameConversation(undefined)} onSave={(title) => void saveConversationTitle(title)} />}
      {renameProject && <RenameConversationDialog heading="Переименовать проект" title={renameProject.name} onClose={() => setRenameProject(undefined)} onSave={(title) => void saveProjectTitle(title)} />}
    </div>
  );
}

function formatElapsed(milliseconds: number): string {
  const total = Math.floor(milliseconds / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}

function sanitizeStatusText(value?: string): string {
  if (!value) return "";
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function pluralFiles(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return "файлов";
  if (last === 1) return "файл";
  if (last >= 2 && last <= 4) return "файла";
  return "файлов";
}

function extensionName(extensionPath: string): string {
  const parts = extensionPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const extensionIndex = parts.lastIndexOf("extensions");
  if (extensionIndex >= 0 && parts[extensionIndex + 1]) return parts[extensionIndex + 1];
  return parts.at(-2) ?? parts.at(-1) ?? extensionPath;
}
