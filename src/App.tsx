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
  Keyboard,
  Menu,
  MessageSquarePlus,
  MoreHorizontal,
  PanelLeft,
  Paperclip,
  Plus,
  Search,
  Send,
  Settings,
  RefreshCw,
  SquareTerminal,
  Pencil,
  Trash2,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import type {
  Attachment,
  BootstrapPayload,
  ConfiguredModelInfo,
  ConfiguredModelServer,
  ConfiguredModelUpdate,
  CompactionRecord,
  ConversationRecord,
  ConversationSnapshot,
  ExtensionState,
  ExtensionUiRequest,
  ExtensionWidgetState,
  DiffHunk,
  ModelInfo,
  ModuleSettings,
  ProjectRecord,
  QueuedPrompt,
  RunDiff,
  ThinkingLevel,
  UpdateComponentId,
  UpdateStatus,
} from "../shared/types";

type JsonObject = Record<string, any>;

interface ToolActivity {
  id: string;
  name: string;
  args?: unknown;
  partialArguments?: string;
  result?: unknown;
  running: boolean;
  preparing?: boolean;
  error?: boolean;
  startedAt: number;
}

interface Notice {
  id: string;
  message: string;
  type: "info" | "warning" | "error";
}

type SettingsSection = "general" | "models" | "modules" | "customization" | "configuration" | "shortcuts" | "archive" | "about";

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

type TranscriptTimelineItem =
  | { kind: "message"; message: JsonObject; sourceIndex: number; timestamp: number; order: number }
  | { kind: "extension"; entry: ConversationSnapshot["entries"][number]; sourceIndex: number; timestamp: number; order: number }
  | { kind: "compaction"; entry: ConversationSnapshot["entries"][number]; record?: CompactionRecord; sourceIndex: number; timestamp: number; order: number };

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

function transcriptTimestamp(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
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

interface MarkdownTreeNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownTreeNode[];
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

interface VirtualFilmLayout {
  resetKey: string;
  keys: string[];
  heights: number[];
  offsets: number[];
  totalHeight: number;
}

function VirtualFilm<T>({
  items,
  itemKey,
  renderItem,
  resetKey,
  scrollRef,
}: {
  items: T[];
  itemKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  resetKey: string;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const filmRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<VirtualFilmLayout>({ resetKey: "", keys: [], heights: [], offsets: [], totalHeight: 0 });
  const [calibrating, setCalibrating] = useState(true);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [range, setRange] = useState({ start: 0, end: items.length });

  if (layoutRef.current.resetKey !== resetKey) {
    layoutRef.current = { resetKey, keys: [], heights: [], offsets: [], totalHeight: 0 };
  }

  useLayoutEffect(() => {
    layoutRef.current = { resetKey, keys: [], heights: [], offsets: [], totalHeight: 0 };
    setCalibrating(true);
    setRange({ start: 0, end: items.length });
  }, [resetKey]);

  useLayoutEffect(() => {
    if (!calibrating) return;
    const film = filmRef.current;
    if (!film) return;
    const rows = [...film.querySelectorAll<HTMLElement>("[data-virtual-film-row]")];
    const keys = items.map(itemKey);
    const heights = rows.map((row) => row.getBoundingClientRect().height);
    const offsets: number[] = [];
    let totalHeight = 0;
    heights.forEach((height) => {
      offsets.push(totalHeight);
      totalHeight += height;
    });
    layoutRef.current = { resetKey, keys, heights, offsets, totalHeight };
    setCalibrating(false);
    setLayoutRevision((value) => value + 1);
  }, [calibrating, items, itemKey, resetKey]);

  const layout = layoutRef.current;
  if (!calibrating && layout.resetKey === resetKey) {
    const previousCount = layout.keys.length;
    if (items.length > previousCount && (previousCount === 0 || itemKey(items[previousCount - 1], previousCount - 1) === layout.keys[previousCount - 1])) {
      for (let index = previousCount; index < items.length; index += 1) {
        layout.keys.push(itemKey(items[index], index));
        layout.offsets.push(layout.totalHeight);
        layout.heights.push(120);
        layout.totalHeight += 120;
      }
    } else if (items.length !== previousCount || (items.length > 0 && itemKey(items[items.length - 1], items.length - 1) !== layout.keys[items.length - 1])) {
      layout.keys = items.map(itemKey);
      layout.heights = items.map((_, index) => layout.heights[index] ?? 120);
      layout.offsets = [];
      layout.totalHeight = 0;
      layout.heights.forEach((height) => {
        layout.offsets.push(layout.totalHeight);
        layout.totalHeight += height;
      });
    }
  }

  const updateRange = useCallback(() => {
    if (calibrating) return;
    const scroll = scrollRef.current;
    const film = filmRef.current;
    if (!scroll || !film || items.length === 0) return;
    const overscan = Math.max(700, scroll.clientHeight);
    const viewportTop = Math.max(0, scroll.scrollTop - film.offsetTop - overscan);
    const viewportBottom = scroll.scrollTop - film.offsetTop + scroll.clientHeight + overscan;
    const current = layoutRef.current;
    let low = 0;
    let high = current.offsets.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (current.offsets[middle] + current.heights[middle] < viewportTop) low = middle + 1;
      else high = middle;
    }
    const start = low;
    low = start;
    high = current.offsets.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (current.offsets[middle] <= viewportBottom) low = middle + 1;
      else high = middle;
    }
    const end = Math.max(start, low);
    setRange((value) => value.start === start && value.end === end ? value : { start, end });
  }, [calibrating, items.length, scrollRef]);

  useLayoutEffect(() => {
    if (calibrating) return;
    updateRange();
    const scroll = scrollRef.current;
    if (!scroll) return;
    let frame = 0;
    let measuredWidth = scroll.clientWidth;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateRange);
    };
    scroll.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(() => {
      if (Math.abs(scroll.clientWidth - measuredWidth) > 1) {
        measuredWidth = scroll.clientWidth;
        setCalibrating(true);
        return;
      }
      schedule();
    });
    observer.observe(scroll);
    return () => {
      cancelAnimationFrame(frame);
      scroll.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  }, [calibrating, layoutRevision, scrollRef, updateRange]);

  useLayoutEffect(() => {
    if (calibrating) return;
    const film = filmRef.current;
    if (!film) return;
    const observer = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const row = entry.target as HTMLElement;
        const index = Number(row.dataset.virtualIndex);
        const nextHeight = entry.borderBoxSize?.[0]?.blockSize ?? row.getBoundingClientRect().height;
        const current = layoutRef.current;
        if (!Number.isInteger(index) || index < 0 || Math.abs((current.heights[index] ?? 0) - nextHeight) < 0.5) continue;
        const difference = nextHeight - current.heights[index];
        current.heights[index] = nextHeight;
        current.totalHeight += difference;
        for (let next = index + 1; next < current.offsets.length; next += 1) current.offsets[next] += difference;
        changed = true;
      }
      if (changed) setLayoutRevision((value) => value + 1);
    });
    film.querySelectorAll<HTMLElement>("[data-virtual-index]").forEach((row) => observer.observe(row));
    return () => observer.disconnect();
  }, [calibrating, range.start, range.end]);

  if (calibrating) {
    return (
      <div className="virtual-film-calibration" ref={filmRef}>
        {items.map((item, index) => <div data-virtual-film-row key={itemKey(item, index)}>{renderItem(item, index)}</div>)}
      </div>
    );
  }

  const visible: ReactNode[] = [];
  for (let index = range.start; index < Math.min(range.end, items.length); index += 1) {
    visible.push(
      <div
        className="virtual-film-frame"
        data-virtual-index={index}
        key={itemKey(items[index], index)}
        style={{ transform: `translateY(${layout.offsets[index] ?? 0}px)` }}
      >
        {renderItem(items[index], index)}
      </div>,
    );
  }
  return <div className="virtual-film" ref={filmRef} style={{ height: `${layout.totalHeight}px` }}>{visible}</div>;
}

function createRevealTailPlugin(revealFrom: number): Plugin {
  return () => (tree) => {
    let freshWordIndex = 0;
    const visit = (parent: MarkdownTreeNode) => {
      if (!parent.children) return;
      const nextChildren: MarkdownTreeNode[] = [];
      for (const child of parent.children) {
        const end = child.position?.end?.offset;
        if (child.type === "text" && child.value && typeof end === "number" && end > revealFrom) {
          const freshLength = Math.min(child.value.length, end - revealFrom);
          const splitAt = child.value.length - freshLength;
          if (splitAt > 0) nextChildren.push({ ...child, value: child.value.slice(0, splitAt) });
          const freshText = child.value.slice(splitAt);
          for (const segment of freshText.match(/\s+|[^\s]+/g) ?? []) {
            if (!segment.trim()) {
              nextChildren.push({ type: "text", value: segment });
              continue;
            }
            const delayStep = Math.min(freshWordIndex, 6);
            freshWordIndex += 1;
            nextChildren.push({
              type: "element",
              tagName: "span",
              properties: { className: ["stream-reveal-fragment", `stream-reveal-delay-${delayStep}`] },
              children: [{ type: "text", value: segment }],
            });
          }
          continue;
        }
        visit(child);
        nextChildren.push(child);
      }
      parent.children = nextChildren;
    };
    visit(tree as MarkdownTreeNode);
  };
}

function StreamingMarkdown({ text }: { text: string }) {
  const previousTextRef = useRef("");
  const revealFrom = text.startsWith(previousTextRef.current) ? previousTextRef.current.length : 0;
  const revealTailPlugin = useMemo(() => createRevealTailPlugin(revealFrom), [revealFrom]);

  useEffect(() => {
    previousTextRef.current = text;
  }, [text]);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[revealTailPlugin]}
      components={{
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
        code: ({ children, className }) => <code className={className}>{children}</code>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function MessageContent({
  message,
  assistant = false,
  streaming = false,
}: {
  message: JsonObject;
  assistant?: boolean;
  streaming?: boolean;
}) {
  const content = message.content;
  if (typeof content === "string") {
    return (
      <>
        {assistant
          ? <div className="assistant-final">{streaming ? <StreamingMarkdown text={content} /> : <Markdown text={content} />}</div>
          : <Markdown text={content} />}
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
          const rendered = <ContentParts content={[part]} />;
          return assistant && part.type === "text"
            ? <div className="assistant-final" key={index}>{streaming ? <StreamingMarkdown text={String(part.text ?? "")} /> : rendered}</div>
            : <Fragment key={index}>{rendered}</Fragment>;
        }
        if (part.type === "thinking") {
          if (index > 0 && content[index - 1]?.type === "thinking") return null;
          let thinkingEnd = index;
          while (thinkingEnd < content.length && content[thinkingEnd]?.type === "thinking") thinkingEnd += 1;
          const text = content
            .slice(index, thinkingEnd)
            .map((candidate: JsonObject) => String(candidate.thinking ?? candidate.text ?? "").trim())
            .filter(Boolean)
            .join("\n\n");
          if (!text) return null;
          return (
            <div className={`thinking-block ${streaming ? "streaming" : ""}`} key={index}>
              {streaming ? <StreamingMarkdown text={text} /> : <Markdown text={text} />}
            </div>
          );
        }
        return null;
      })}
    </>
  );
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

function parsedToolArguments(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return { input: value };
  }
}

function toolCallParts(message: JsonObject): JsonObject[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter((part: JsonObject) => part?.type === "toolCall" || part?.type === "tool_call");
}

function toolCallIdentifier(call: JsonObject, fallback: string): string {
  return String(call.id ?? call.toolCallId ?? call.tool_call_id ?? fallback);
}

function toolResultIdentifier(message: JsonObject): string | undefined {
  const id = message.toolCallId ?? message.tool_call_id ?? message.id;
  return id === undefined ? undefined : String(id);
}

function messageWithoutToolCalls(message: JsonObject): JsonObject | undefined {
  if (!Array.isArray(message.content)) return message;
  const content = message.content.filter((part: JsonObject) => part?.type !== "toolCall" && part?.type !== "tool_call");
  return content.length ? { ...message, content } : undefined;
}

function resultMessagePayload(message: JsonObject): JsonObject {
  return {
    content: Array.isArray(message.content)
      ? message.content
      : typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : [],
    details: message.details,
    isError: Boolean(message.isError),
  };
}

function toolOutputText(result: unknown): string {
  return textFromResult(result).replace(/\r\n/g, "\n").trimEnd();
}

function partialJsonStringValues(source: string | undefined, field: string): string[] {
  if (!source) return [];
  const values: string[] = [];
  const marker = new RegExp(`"${field}"\\s*:\\s*"`, "g");
  let match: RegExpExecArray | null;
  while ((match = marker.exec(source))) {
    let value = "";
    let index = match.index + match[0].length;
    while (index < source.length) {
      const character = source[index++];
      if (character === '"') break;
      if (character !== "\\") {
        value += character;
        continue;
      }
      if (index >= source.length) break;
      const escaped = source[index++];
      if (escaped === "n") value += "\n";
      else if (escaped === "r") value += "\r";
      else if (escaped === "t") value += "\t";
      else if (escaped === "b") value += "\b";
      else if (escaped === "f") value += "\f";
      else if (escaped === "u") {
        const hex = source.slice(index, index + 4);
        if (!/^[0-9a-f]{4}$/i.test(hex)) break;
        value += String.fromCharCode(Number.parseInt(hex, 16));
        index += 4;
      } else value += escaped;
    }
    values.push(value);
    marker.lastIndex = Math.max(marker.lastIndex, index);
  }
  return values;
}

function toolCodeFragments(name: string, args: JsonObject, partialArguments?: string): string[] {
  const normalized = name.toLocaleLowerCase();
  if (normalized === "edit") {
    const complete = Array.isArray(args.edits)
      ? args.edits.map((edit: JsonObject) => edit?.newText).filter((value: unknown): value is string => typeof value === "string")
      : typeof args.newText === "string" ? [args.newText] : [];
    return complete.length > 0 ? complete : partialJsonStringValues(partialArguments, "newText");
  }
  if (normalized === "write") {
    if (typeof args.content === "string") return [args.content];
    return partialJsonStringValues(partialArguments, "content");
  }
  return [];
}

function compactLine(value: unknown, limit = 110): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function toolPresentation(name: string, args: JsonObject): {
  icon: "terminal" | "file" | "search" | "folder" | "mcp" | "tool";
  label: string;
  summary?: string;
  command?: string;
  showRawArgs?: boolean;
} {
  const normalized = name.toLocaleLowerCase();
  const path = args.path ?? args.file ?? args.filePath;
  if (normalized === "bash" || normalized === "shell" || normalized === "exec") {
    const command = String(args.command ?? args.cmd ?? args.input ?? "");
    return { icon: "terminal", label: "Команда", summary: compactLine(command), command };
  }
  if (normalized === "read") {
    const offset = Number(args.offset ?? 0);
    const limit = Number(args.limit ?? 0);
    const range = offset > 0 ? `:${offset}${limit > 0 ? `–${offset + limit - 1}` : ""}` : "";
    return { icon: "file", label: "Чтение", summary: `${String(path ?? "файл")}${range}` };
  }
  if (normalized === "edit") return { icon: "file", label: "Изменение", summary: String(path ?? "файл") };
  if (normalized === "write") return { icon: "file", label: "Запись", summary: String(path ?? "файл") };
  if (normalized === "grep") return { icon: "search", label: "Поиск", summary: `${compactLine(args.pattern ?? "")} · ${String(path ?? ".")}` };
  if (normalized === "find") return { icon: "search", label: "Поиск файлов", summary: `${compactLine(args.pattern ?? "")} · ${String(path ?? ".")}` };
  if (normalized === "ls") return { icon: "folder", label: "Список файлов", summary: String(path ?? ".") };
  if (normalized.startsWith("mcp__") || normalized.startsWith("mcp_")) {
    const parts = name.split("__");
    return { icon: "mcp", label: parts.at(-1)?.replace(/[-_]/g, " ") || name, summary: parts.length > 2 ? parts[1] : "MCP", showRawArgs: true };
  }
  return { icon: "tool", label: name, showRawArgs: true };
}

function ToolIcon({ kind }: { kind: ReturnType<typeof toolPresentation>["icon"] }) {
  if (kind === "terminal") return <SquareTerminal size={15} />;
  if (kind === "file") return <FileText size={15} />;
  if (kind === "search") return <Search size={15} />;
  if (kind === "folder") return <Folder size={15} />;
  if (kind === "mcp") return <Boxes size={15} />;
  return <Wrench size={15} />;
}

function ToolDiffPreview({ diff, expanded }: { diff: string; expanded: boolean }) {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const visible = expanded ? lines : lines.slice(0, 10);
  return (
    <pre className="tool-diff-output">
      {visible.map((line, index) => <span className={line.startsWith("+") && !line.startsWith("+++") ? "added" : line.startsWith("-") && !line.startsWith("---") ? "removed" : ""} key={`${index}-${line}`}>{line || " "}</span>)}
      {!expanded && lines.length > visible.length && <em>… ещё {lines.length - visible.length} строк</em>}
    </pre>
  );
}

function ToolTextOutput({ text, expanded }: { text: string; expanded: boolean }) {
  const lines = text.split("\n");
  const visible = expanded ? lines : lines.slice(0, 8);
  return (
    <pre className="tool-text-output">
      {visible.join("\n")}
      {!expanded && lines.length > visible.length ? `\n… ещё ${lines.length - visible.length} строк` : ""}
    </pre>
  );
}

function ToolResultContent({ result, expanded }: { result: unknown; expanded: boolean }) {
  const object = result && typeof result === "object" ? result as JsonObject : undefined;
  const diff = typeof object?.details?.diff === "string" ? object.details.diff : undefined;
  if (diff) return <ToolDiffPreview diff={diff} expanded={expanded} />;
  const text = toolOutputText(result);
  const media = Array.isArray(object?.content)
    ? object.content.filter((part: JsonObject) => part?.type !== "text") as JsonObject[]
    : [];
  return <>{text && <ToolTextOutput text={text} expanded={expanded} />}{media.length > 0 && <ContentParts content={media} />}</>;
}

function ToolCard({ tool }: { tool: ToolActivity }) {
  const args = parsedToolArguments(tool.args);
  const presentation = toolPresentation(tool.name, args);
  const [expanded, setExpanded] = useState(false);
  const output = tool.result === undefined ? "" : toolOutputText(tool.result);
  const codeFragments = toolCodeFragments(tool.name, args, tool.partialArguments);
  const hasDetails = Boolean(codeFragments.length || presentation.command || presentation.showRawArgs && Object.keys(args).length || output || (tool.result as JsonObject | undefined)?.details?.diff);
  return (
    <div className={`tool-card ${tool.preparing || tool.running ? "running" : "complete"} ${tool.error ? "error" : ""}`}>
      <button className="tool-card-head" disabled={!hasDetails} onClick={() => setExpanded((value) => !value)}>
        {hasDetails ? expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} /> : <span className="tool-chevron-space" />}
        <ToolIcon kind={presentation.icon} />
        <span className="tool-heading"><strong>{presentation.label}</strong>{presentation.summary && <small>{presentation.summary}</small>}</span>
        <span className="tool-state">{tool.preparing ? "Формируется…" : tool.running ? "Выполняется…" : tool.error ? "Ошибка" : "Готово"}</span>
      </button>
      {expanded && hasDetails && (
        <div className="tool-card-body">
          {tool.result === undefined && codeFragments.length > 0 && (
            <div className="tool-code-preview">
              {codeFragments.map((fragment, index) => (
                <div className="tool-code-fragment" key={`${index}-${fragment.length}`}>
                  {codeFragments.length > 1 && <small>Фрагмент {index + 1}</small>}
                  <pre>{fragment || " "}</pre>
                </div>
              ))}
            </div>
          )}
          {presentation.command && <pre className="tool-command">{presentation.command}</pre>}
          {presentation.showRawArgs && Object.keys(args).length > 0 && <details className="tool-arguments"><summary>Параметры</summary><pre>{JSON.stringify(args, null, 2)}</pre></details>}
          {tool.result !== undefined && <ToolResultContent result={tool.result} expanded />}
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

function CommandPalette({
  commands,
  busy,
  onClose,
  onCompact,
  onReload,
  onInsert,
}: {
  commands: ConversationSnapshot["commands"];
  busy: boolean;
  onClose: () => void;
  onCompact: () => void;
  onReload: () => void;
  onInsert: (command: string) => void;
}) {
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLocaleLowerCase();
  const textCommands = commands.filter((command) =>
    !["compact", "reload"].includes(command.name)
    && (!normalized || command.name.toLocaleLowerCase().includes(normalized) || command.description?.toLocaleLowerCase().includes(normalized))
  );
  return (
    <div className="modal-backdrop">
      <div className="modal-card command-palette">
        <div className="modal-head"><strong>Команды Pi</strong><button className="icon-button" onClick={onClose}><X size={17} /></button></div>
        <div className="command-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Найти команду…" autoFocus /></div>
        <div className="command-section-title">Действия приложения</div>
        <div className="command-list">
          <button disabled={busy} onClick={onCompact}><span><strong>Сжать контекст</strong><small>Штатная команда Pi `/compact`; можно добавить инструкции для сводки.</small></span><code>/compact</code></button>
          <button disabled={busy} onClick={onReload}><span><strong>Перезагрузить ресурсы Pi</strong><small>Расширения, навыки, промпты, настройки и файлы контекста.</small></span><code>/reload</code></button>
        </div>
        <div className="command-section-title">Команды расширений, шаблоны и навыки</div>
        <div className="command-list command-dynamic-list">
          {textCommands.map((command) => <button key={`${command.source}-${command.name}`} onClick={() => onInsert(command.name)}><span><strong>/{command.name}</strong><small>{command.description || "Описание не предоставлено"}</small></span><em>{command.source === "extension" ? "Модуль" : command.source === "skill" ? "Навык" : "Шаблон"}</em></button>)}
          {!textCommands.length && <div className="command-empty">Подходящих команд нет.</div>}
        </div>
        <div className="command-palette-note">Выбор команды расширения помещает её в поле ввода — аргументы можно дописать перед отправкой.</div>
      </div>
    </div>
  );
}

function CompactDialog({ onClose, onCompact }: { onClose: () => void; onCompact: (instructions?: string) => void }) {
  const [instructions, setInstructions] = useState("");
  return (
    <div className="modal-backdrop">
      <div className="modal-card compact-dialog">
        <div className="modal-head"><strong>Сжать контекст</strong><button className="icon-button" onClick={onClose}><X size={17} /></button></div>
        <p>Pi создаст сводку предыдущего контекста и сохранит последние сообщения без изменений.</p>
        <label><span>Дополнительные инструкции для сводки</span><textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Необязательно" autoFocus /></label>
        <div className="modal-actions"><button onClick={onClose}>Отмена</button><button className="primary" onClick={() => onCompact(instructions.trim() || undefined)}>Сжать</button></div>
      </div>
    </div>
  );
}

function ModelSettingsDialog({
  providerId,
  model,
  onClose,
  onSave,
}: {
  providerId: string;
  model: ConfiguredModelInfo;
  onClose: () => void;
  onSave: (input: ConfiguredModelUpdate) => Promise<void>;
}) {
  const [id, setId] = useState(model.id);
  const [name, setName] = useState(model.name ?? "");
  const [contextWindow, setContextWindow] = useState(model.contextWindow?.toString() ?? "");
  const [maxTokens, setMaxTokens] = useState(model.maxTokens?.toString() ?? "");
  const [reasoning, setReasoning] = useState(model.reasoning);
  const [vision, setVision] = useState(model.input.includes("image"));
  const [levels, setLevels] = useState<ThinkingLevel[]>(model.thinkingLevels);
  const [samplingParams, setSamplingParams] = useState(model.samplingParams ? JSON.stringify(model.samplingParams, null, 2) : "{}");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const toggleLevel = (level: ThinkingLevel) => setLevels((current) => current.includes(level) ? current.filter((item) => item !== level) : [...current, level]);
  const save = async () => {
    setError("");
    let parsedSampling: Record<string, number | boolean | string> | undefined;
    try {
      const parsed = samplingParams.trim() ? JSON.parse(samplingParams) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Параметры семплирования должны быть объектом JSON");
      const invalid = Object.entries(parsed).find(([, value]) => !["number", "boolean", "string"].includes(typeof value));
      if (invalid) throw new Error(`Параметр «${invalid[0]}» должен быть числом, строкой или логическим значением`);
      parsedSampling = parsed as Record<string, number | boolean | string>;
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : String(parseError));
      return;
    }
    const parseOptionalInteger = (value: string, label: string): number | undefined => {
      if (!value.trim()) return undefined;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} должен быть положительным целым числом`);
      return parsed;
    };
    try {
      setSaving(true);
      await onSave({
        providerId,
        originalModelId: model.id,
        id: id.trim(),
        name: name.trim() || undefined,
        contextWindow: parseOptionalInteger(contextWindow, "Контекст"),
        maxTokens: parseOptionalInteger(maxTokens, "Лимит ответа"),
        reasoning,
        input: vision ? ["text", "image"] : ["text"],
        thinkingLevels: reasoning ? levels : ["off"],
        samplingParams: parsedSampling,
      });
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <div className="modal-card model-settings-dialog">
        <div className="modal-head"><strong>Настройки модели</strong><button className="icon-button" onClick={onClose}><X size={17} /></button></div>
        <div className="model-settings-scroll">
          <div className="model-field-grid">
            <label><span>ID модели</span><input value={id} onChange={(event) => setId(event.target.value)} /></label>
            <label><span>Название в интерфейсе</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Необязательно" /></label>
            <label><span>Размер контекста</span><input value={contextWindow} onChange={(event) => setContextWindow(event.target.value)} inputMode="numeric" placeholder="Автоматически" /></label>
            <label><span>Максимум токенов ответа</span><input value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} inputMode="numeric" placeholder="Автоматически" /></label>
          </div>
          <div className="model-toggle-row">
            <label><input type="checkbox" checked={reasoning} onChange={(event) => setReasoning(event.target.checked)} /> Модель поддерживает рассуждения</label>
            <label><input type="checkbox" checked={vision} onChange={(event) => setVision(event.target.checked)} /> Модель принимает изображения</label>
          </div>
          <div className={`thinking-level-editor ${reasoning ? "" : "disabled"}`}>
            <strong>Доступные уровни рассуждений</strong>
            <div>{(Object.keys(THINKING_LABELS) as ThinkingLevel[]).map((level) => <label key={level}><input type="checkbox" disabled={!reasoning} checked={levels.includes(level)} onChange={() => toggleLevel(level)} />{THINKING_LABELS[level]}</label>)}</div>
          </div>
          <label className="sampling-editor"><span>Параметры семплирования, JSON</span><textarea value={samplingParams} onChange={(event) => setSamplingParams(event.target.value)} spellCheck={false} /></label>
          {error && <div className="model-settings-error">{error}</div>}
        </div>
        <div className="modal-actions"><button onClick={onClose}>Отмена</button><button className="primary" disabled={saving || !id.trim()} onClick={() => void save()}>{saving ? "Сохранение…" : "Сохранить"}</button></div>
      </div>
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
  const [globalPrompt, setGlobalPrompt] = useState("");
  const [savedGlobalPrompt, setSavedGlobalPrompt] = useState("");
  const [globalPromptLoaded, setGlobalPromptLoaded] = useState(false);
  const [globalPromptLoading, setGlobalPromptLoading] = useState(false);
  const [globalPromptSaving, setGlobalPromptSaving] = useState(false);
  const [globalPromptStatus, setGlobalPromptStatus] = useState("");
  const [modelServers, setModelServers] = useState<ConfiguredModelServer[]>([]);
  const [modelServersLoaded, setModelServersLoaded] = useState(false);
  const [modelServersLoading, setModelServersLoading] = useState(false);
  const [serverAddress, setServerAddress] = useState("");
  const [serverPort, setServerPort] = useState("1234");
  const [serverApiKey, setServerApiKey] = useState("");
  const [serverDiscovering, setServerDiscovering] = useState(false);
  const [serverDiscoveryStatus, setServerDiscoveryStatus] = useState("");
  const [serverDiscoveryError, setServerDiscoveryError] = useState(false);
  const [editingServerId, setEditingServerId] = useState<string>();
  const [editingModel, setEditingModel] = useState<{ providerId: string; model: ConfiguredModelInfo }>();
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>();
  const [updatesLoading, setUpdatesLoading] = useState(false);
  const [updatingComponent, setUpdatingComponent] = useState<string>();
  const [updateMessage, setUpdateMessage] = useState("");
  const [updateError, setUpdateError] = useState(false);
  const [moduleSettings, setModuleSettings] = useState<ModuleSettings>();
  const [moduleSettingsLoading, setModuleSettingsLoading] = useState(false);
  const [moduleSettingsMessage, setModuleSettingsMessage] = useState("");
  const sections: Array<{ id: SettingsSection; label: string; icon: typeof Settings }> = [
    { id: "general", label: "Общее", icon: Settings },
    { id: "models", label: "Модели", icon: Cpu },
    { id: "modules", label: "Модули", icon: Boxes },
    { id: "customization", label: "Кастомизация", icon: Pencil },
    { id: "configuration", label: "Конфигурация Pi", icon: FileText },
    { id: "shortcuts", label: "Сочетания клавиш", icon: Keyboard },
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

  useEffect(() => {
    if (section !== "customization" || globalPromptLoaded) return;
    let cancelled = false;
    setGlobalPromptLoading(true);
    setGlobalPromptStatus("");
    void window.piDesktop.getGlobalPrompt().then((prompt) => {
      if (cancelled) return;
      setGlobalPrompt(prompt);
      setSavedGlobalPrompt(prompt);
      setGlobalPromptLoaded(true);
    }).catch((error) => {
      if (!cancelled) setGlobalPromptStatus(error instanceof Error ? error.message : String(error));
    }).finally(() => {
      if (!cancelled) setGlobalPromptLoading(false);
    });
    return () => { cancelled = true; };
  }, [section, globalPromptLoaded]);

  const loadUpdateStatus = useCallback(async (force = false) => {
    setUpdatesLoading(true);
    setUpdateError(false);
    if (force) setUpdateMessage("");
    try {
      setUpdateStatus(await window.piDesktop.getUpdateStatus(force));
    } catch (error) {
      setUpdateError(true);
      setUpdateMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdatesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (section !== "modules" || updateStatus || updatesLoading) return;
    void loadUpdateStatus();
  }, [section, updateStatus, updatesLoading, loadUpdateStatus]);

  useEffect(() => {
    if (section !== "modules" || moduleSettings || moduleSettingsLoading) return;
    setModuleSettingsLoading(true);
    void window.piDesktop.getModuleSettings()
      .then(setModuleSettings)
      .catch((error) => setModuleSettingsMessage(error instanceof Error ? error.message : String(error)))
      .finally(() => setModuleSettingsLoading(false));
  }, [section, moduleSettings, moduleSettingsLoading]);

  const toggleBuiltinModule = async (id: ModuleSettings["builtins"][number]["id"], enabled: boolean) => {
    setModuleSettingsMessage("");
    try {
      setModuleSettings(await window.piDesktop.setBuiltinModuleEnabled(id, enabled));
      setModuleSettingsMessage("Настройка сохранена. Открытые процессы Pi перезапущены; следующий запрос использует новый набор модулей.");
    } catch (error) {
      setModuleSettingsMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const addUserExtension = async (kind: "file" | "directory") => {
    setModuleSettingsMessage("");
    try {
      const next = await window.piDesktop.addUserExtension(kind);
      if (next) {
        setModuleSettings(next);
        setModuleSettingsMessage("Пользовательское расширение добавлено. Оно загрузится при следующем запросе.");
      }
    } catch (error) {
      setModuleSettingsMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const removeUserExtension = async (name: string) => {
    setModuleSettingsMessage("");
    try {
      const next = await window.piDesktop.removeUserExtension(name);
      if (next) {
        setModuleSettings(next);
        setModuleSettingsMessage("Пользовательское расширение удалено. Встроенные модули не затронуты.");
      }
    } catch (error) {
      setModuleSettingsMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const installUpdate = async (id?: UpdateComponentId) => {
    setUpdatingComponent(id ?? "all");
    setUpdateMessage("");
    setUpdateError(false);
    try {
      const result = id
        ? await window.piDesktop.updateComponent(id)
        : await window.piDesktop.updateAllComponents();
      setUpdateStatus(result.status);
      if (result.errors.length) {
        setUpdateError(true);
        setUpdateMessage(result.errors.join(" · "));
      } else if (result.updated.length) {
        setUpdateMessage(`Обновлено: ${result.updated.join(", ")}. Новые процессы Pi используют новые версии.`);
      }
    } catch (error) {
      setUpdateError(true);
      setUpdateMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdatingComponent(undefined);
    }
  };

  const saveGlobalPrompt = async () => {
    setGlobalPromptSaving(true);
    setGlobalPromptStatus("");
    try {
      const saved = await window.piDesktop.saveGlobalPrompt(globalPrompt);
      setGlobalPrompt(saved);
      setSavedGlobalPrompt(saved);
      setGlobalPromptStatus("Сохранено. Новые процессы Pi подхватят изменения автоматически.");
    } catch (error) {
      setGlobalPromptStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setGlobalPromptSaving(false);
    }
  };

  useEffect(() => {
    if (section !== "models" || modelServersLoaded) return;
    let cancelled = false;
    setModelServersLoading(true);
    void window.piDesktop.getModelServers().then((servers) => {
      if (cancelled) return;
      setModelServers(servers);
      setModelServersLoaded(true);
      if (!serverAddress && servers[0]?.baseUrl) {
        try {
          const url = new URL(servers[0].baseUrl);
          const basePath = url.pathname.replace(/\/v1\/?$/i, "");
          setServerAddress(`${url.protocol}//${url.hostname}${basePath}`);
          setServerPort(url.port || (url.protocol === "https:" ? "443" : "80"));
        } catch {
          // Keep the fields empty when a legacy URL cannot be parsed.
        }
      }
    }).catch((error) => {
      if (!cancelled) {
        setServerDiscoveryError(true);
        setServerDiscoveryStatus(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      if (!cancelled) setModelServersLoading(false);
    });
    return () => { cancelled = true; };
  }, [section, modelServersLoaded]);

  const discoverModelServer = async () => {
    setServerDiscovering(true);
    setServerDiscoveryStatus("");
    setServerDiscoveryError(false);
    try {
      const result = await window.piDesktop.discoverModelServer({
        address: serverAddress,
        port: serverPort,
        ...(serverApiKey.trim() ? { apiKey: serverApiKey.trim() } : {}),
        ...(editingServerId ? { providerId: editingServerId } : {}),
      });
      setModelServers((current) => [result.server, ...current.filter((server) => server.id !== result.server.id)]);
      const changes = [
        result.addedModels ? `добавлено моделей: ${result.addedModels}` : "",
        result.updatedModels ? `обновлено: ${result.updatedModels}` : "",
      ].filter(Boolean).join(", ");
      setServerDiscoveryStatus(`${result.serverKind}${result.buildInfo ? ` ${result.buildInfo}` : ""}: ${changes || "конфигурация актуальна"}.`);
      setEditingServerId(undefined);
      setServerApiKey("");
    } catch (error) {
      setServerDiscoveryError(true);
      setServerDiscoveryStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setServerDiscovering(false);
    }
  };

  const editModelServer = (server: ConfiguredModelServer) => {
    try {
      const url = new URL(server.baseUrl);
      const basePath = url.pathname.replace(/\/v1\/?$/i, "");
      setServerAddress(`${url.protocol}//${url.hostname}${basePath}`);
      setServerPort(url.port || (url.protocol === "https:" ? "443" : "80"));
      setServerApiKey("");
      setEditingServerId(server.id);
      setServerDiscoveryError(false);
      setServerDiscoveryStatus(`Редактируется сервер «${server.id}». Укажите новый адрес и выполните автонастройку.`);
      requestAnimationFrame(() => document.querySelector(".server-discovery-card")?.scrollIntoView({ behavior: "smooth", block: "center" }));
    } catch (error) {
      setServerDiscoveryError(true);
      setServerDiscoveryStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const cancelServerEdit = () => {
    setEditingServerId(undefined);
    setServerApiKey("");
    setServerDiscoveryStatus("");
    setServerDiscoveryError(false);
  };

  const deleteModelServer = async (providerId: string) => {
    try {
      const deleted = await window.piDesktop.deleteModelServer(providerId);
      if (!deleted) return;
      setModelServers((current) => current.filter((server) => server.id !== providerId));
      if (editingServerId === providerId) cancelServerEdit();
    } catch (error) {
      setServerDiscoveryError(true);
      setServerDiscoveryStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const saveConfiguredModel = async (input: ConfiguredModelUpdate) => {
    const updated = await window.piDesktop.updateConfiguredModel(input);
    setModelServers((current) => current.map((server) => server.id === updated.id ? updated : server));
  };

  const deleteConfiguredModel = async (providerId: string, modelId: string) => {
    try {
      const updated = await window.piDesktop.deleteConfiguredModel(providerId, modelId);
      if (updated) setModelServers((current) => current.map((server) => server.id === updated.id ? updated : server));
    } catch (error) {
      setServerDiscoveryError(true);
      setServerDiscoveryStatus(error instanceof Error ? error.message : String(error));
    }
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
                <SettingRow title="Обновления Pi и модулей" description="Обновления запускаются вручную во вкладке «Модули» и хранятся в переносимой папке data." value="Только вручную" />
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
              <h2>Добавить сервер автоматически</h2>
              <div className="settings-card server-discovery-card">
                <div className="server-fields">
                  <label className="server-address-field"><span>Адрес сервера</span><input value={serverAddress} onChange={(event) => setServerAddress(event.target.value)} placeholder="192.168.31.194 или http://localhost" /></label>
                  <label className="server-port-field"><span>Порт</span><input value={serverPort} onChange={(event) => setServerPort(event.target.value)} inputMode="numeric" placeholder="1234" /></label>
                  <label className="server-key-field"><span>API-ключ, если требуется</span><input type="password" value={serverApiKey} onChange={(event) => setServerApiKey(event.target.value)} placeholder="Необязательно" /></label>
                </div>
                <div className="server-discovery-footer">
                  <div>
                    <span>Проверяются только служебные endpoints `/v1/models`, `/props` и `/health`.</span>
                    <small>Повторное добавление того же адреса обновляет найденные модели, не удаляя остальные.</small>
                    {serverDiscoveryStatus && <strong className={serverDiscoveryError ? "error" : ""}>{serverDiscoveryStatus}</strong>}
                  </div>
                  <div className="server-discovery-actions">
                    {editingServerId && <button onClick={cancelServerEdit}>Отмена</button>}
                    <button className="primary" disabled={!serverAddress.trim() || !serverPort.trim() || serverDiscovering} onClick={() => void discoverModelServer()}>{serverDiscovering ? "Подключение…" : editingServerId ? "Обновить автоматически" : "Добавить автоматически"}</button>
                  </div>
                </div>
              </div>
              <h2>Настроенные серверы</h2>
              <div className="configured-servers">
                {modelServersLoading ? <div className="settings-card settings-empty">Загрузка конфигурации…</div> : modelServers.length ? modelServers.map((server) => (
                  <div className="settings-card configured-server" key={server.id}>
                    <div className="configured-server-head">
                      <div><strong>{server.id}</strong><span>{server.baseUrl}</span><small>{server.api} · {server.models.length} {pluralModels(server.models.length)}</small></div>
                      <div className="configured-server-actions"><button onClick={() => editModelServer(server)}><Pencil size={13} /> Изменить</button><button className="danger" onClick={() => void deleteModelServer(server.id)}><Trash2 size={13} /> Удалить</button></div>
                    </div>
                    <div className="configured-model-list">
                      {server.models.map((model) => (
                        <div className="configured-model" key={model.id}>
                          <div><strong>{model.name ?? model.id}</strong><span>{model.id}</span></div>
                          <p>
                            {model.contextWindow ? `Контекст ${model.contextWindow.toLocaleString("ru-RU")}` : "Контекст не указан"}
                            {model.maxTokens ? ` · ответ до ${model.maxTokens.toLocaleString("ru-RU")}` : ""}
                            {model.reasoning ? ` · рассуждения: ${model.thinkingLevels.map((level) => THINKING_LABELS[level]).join(", ")}` : " · без рассуждений"}
                            {model.input.length > 1 ? ` · вход: ${model.input.join(", ")}` : ""}
                          </p>
                          {model.samplingParams && <small>{Object.entries(model.samplingParams).map(([key, value]) => `${key}=${value}`).join(" · ")}</small>}
                          <div className="configured-model-actions"><button onClick={() => setEditingModel({ providerId: server.id, model })}><Pencil size={12} /> Изменить</button><button className="danger" onClick={() => void deleteConfiguredModel(server.id, model.id)}><Trash2 size={12} /> Удалить</button></div>
                        </div>
                      ))}
                    </div>
                  </div>
                )) : <div className="settings-card settings-empty">Настроенных локальных серверов пока нет.</div>}
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
              <p className="settings-lead">Встроенные функции хранятся внутри Pi Desktop. Пользовательская папка содержит только дополнения, которые добавил пользователь.</p>
              <h2>Встроенные модули</h2>
              <div className="settings-card builtin-module-list">
                {moduleSettings?.builtins.length ? moduleSettings.builtins.map((module) => {
                  const dependency = module.dependsOn && moduleSettings.builtins.find((item) => item.id === module.dependsOn);
                  const dependencyDisabled = Boolean(dependency && !dependency.enabled);
                  return <label className={`builtin-module-row${dependencyDisabled ? " dependency-disabled" : ""}`} key={module.id}>
                    <span><strong>{module.name}</strong><small>{module.description}{dependency ? ` · зависит от ${dependency.name}` : ""}</small></span>
                    <input type="checkbox" checked={module.enabled} disabled={dependencyDisabled} onChange={(event) => void toggleBuiltinModule(module.id, event.target.checked)} />
                  </label>;
                }) : <div className="settings-empty">{moduleSettingsLoading ? "Загрузка модулей…" : "Не удалось получить список модулей."}</div>}
              </div>
              <h2>Пользовательские дополнения</h2>
              <div className="module-update-toolbar user-extension-toolbar">
                <div><strong>Папка расширений Pi</strong><span>{moduleSettings?.userExtensionsDir ?? "Загрузка…"}</span></div>
                {moduleSettings && <button onClick={() => void window.piDesktop.showItemInFolder(moduleSettings.userExtensionsDir)}><FolderOpen size={13} /> Открыть</button>}
                <button onClick={() => void addUserExtension("file")}><Plus size={13} /> Добавить файл</button>
                <button onClick={() => void addUserExtension("directory")}><Plus size={13} /> Добавить папку</button>
              </div>
              <div className="settings-card user-extension-list">
                {moduleSettings?.userExtensions.length ? moduleSettings.userExtensions.map((extension) => (
                  <div className="user-extension-row" key={extension.name}>
                    <span><strong>{extension.name}</strong><small>{extension.path}</small></span>
                    <button className="danger" onClick={() => void removeUserExtension(extension.name)}><Trash2 size={13} /> Удалить</button>
                  </div>
                )) : <div className="settings-empty">Пользовательских дополнений пока нет. Встроенные модули находятся отдельно.</div>}
              </div>
              {moduleSettingsMessage && <div className="module-update-notice success">{moduleSettingsMessage}</div>}
              <h2>Обновления встроенных компонентов</h2>
              <div className="module-update-toolbar">
                <div>
                  <strong>Pi и установленные дополнения</strong>
                  <span>{updateStatus?.checkedAt ? `Проверено ${new Date(updateStatus.checkedAt).toLocaleString("ru-RU")}` : "Обновления ещё не проверялись"}</span>
                </div>
                <button disabled={updatesLoading || Boolean(updatingComponent)} onClick={() => void loadUpdateStatus(true)}><RefreshCw size={13} className={updatesLoading ? "spinning" : ""} />{updatesLoading ? "Проверка…" : "Проверить"}</button>
                <button className="primary" disabled={updatesLoading || Boolean(updatingComponent) || !updateStatus?.components.some((item) => item.updateable && item.updateAvailable)} onClick={() => void installUpdate()}>{updatingComponent === "all" ? "Обновление…" : "Обновить всё"}</button>
              </div>
              <div className="settings-card module-update-list">
                {updateStatus?.components.length ? updateStatus.components.map((component) => (
                  <div className="module-update-row" key={component.id}>
                    <div>
                      <strong>{component.name}</strong>
                      <p>{component.description}</p>
                      {component.error && <small className="error">Не удалось проверить: {component.error}</small>}
                    </div>
                    <div className="module-update-control">
                      <span>{component.source === "local" ? "Локальный" : component.latestVersion && component.currentVersion !== component.latestVersion ? `${component.currentVersion ?? "?"} → ${component.latestVersion}` : component.currentVersion ?? "Версия неизвестна"}</span>
                      {component.updateAvailable && component.updateable
                        ? <button disabled={Boolean(updatingComponent)} onClick={() => void installUpdate(component.id as UpdateComponentId)}>{updatingComponent === component.id ? "Обновление…" : "Обновить"}</button>
                        : <em>{component.source === "local" ? "Защищён" : component.error ? "Нет данных" : "Актуально"}</em>}
                    </div>
                  </div>
                )) : <div className="settings-empty">{updatesLoading ? "Проверка npm…" : "Нет данных об обновлениях."}</div>}
              </div>
              {!updateStatus?.npmAvailable && updateStatus && <div className="module-update-notice error">npm не найден. Проверка версий работает, но установка обновлений требует Node.js/npm в PATH.</div>}
              {updateMessage && <div className={`module-update-notice ${updateError ? "error" : "success"}`}>{updateMessage}</div>}
              <h2>Состояние расширений текущего чата</h2>
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
          {section === "customization" && (
            <>
              <h1>Кастомизация</h1>
              <p className="settings-lead">Глобальные пользовательские инструкции, которые Pi добавляет к своему стандартному системному промпту во всех проектах.</p>
              <h2>Глобальный пользовательский промпт</h2>
              <div className="settings-card prompt-editor-card">
                <textarea
                  value={globalPrompt}
                  onChange={(event) => {
                    setGlobalPrompt(event.target.value);
                    setGlobalPromptStatus("");
                  }}
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase() === "s") {
                      event.preventDefault();
                      if (!globalPromptSaving) void saveGlobalPrompt();
                    }
                  }}
                  disabled={globalPromptLoading}
                  placeholder={globalPromptLoading ? "Загрузка…" : "Введите общие правила поведения для Pi…"}
                  spellCheck
                />
                <div className="prompt-editor-footer">
                  <div>
                    <span>data\agent\APPEND_SYSTEM.md · UTF-8</span>
                    <small>Активные процессы не перезагружаются, чтобы не сбрасывать кэш.</small>
                    {globalPromptStatus && <strong>{globalPromptStatus}</strong>}
                  </div>
                  <button className="primary" disabled={globalPromptLoading || globalPromptSaving || globalPrompt === savedGlobalPrompt} onClick={() => void saveGlobalPrompt()}>
                    {globalPromptSaving ? "Сохранение…" : "Сохранить"}
                  </button>
                </div>
              </div>
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
          {section === "shortcuts" && (
            <>
              <h1>Сочетания клавиш</h1>
              <div className="settings-card">
                <SettingRow title="Новый самостоятельный чат" description="Создать чат без привязки к проекту." value="Ctrl+N" />
                <SettingRow title="Настройки" description="Открыть настройки Pi Desktop." value="Ctrl+," />
                <SettingRow title="Команды Pi" description="Открыть палитру встроенных действий и команд расширений." value="Ctrl+Shift+P" />
                <SettingRow title="Боковая панель" description="Показать или скрыть проекты и чаты." value="Ctrl+B" />
                <SettingRow title="Отправить сообщение" description="Обычная отправка; во время работы сообщение встанет в очередь." value="Enter" />
                <SettingRow title="Отправить в текущую работу" description="Во время работы немедленно передать корректировку модели." value="Ctrl+Enter" />
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
      {editingModel && <ModelSettingsDialog providerId={editingModel.providerId} model={editingModel.model} onClose={() => setEditingModel(undefined)} onSave={saveConfiguredModel} />}
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
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const [queuedActionId, setQueuedActionId] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [compactDialogOpen, setCompactDialogOpen] = useState(false);
  const [conversationMenu, setConversationMenu] = useState<ConversationMenuState>();
  const [projectMenu, setProjectMenu] = useState<ProjectMenuState>();
  const [renameConversation, setRenameConversation] = useState<ConversationRecord>();
  const [renameProject, setRenameProject] = useState<ProjectRecord>();
  const conversationScrollRef = useRef<HTMLDivElement>(null);
  const conversationThreadRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const userScrollInteractionRef = useRef(false);
  const activeIdRef = useRef<string | undefined>(undefined);
  const conversationsRef = useRef<ConversationRecord[]>([]);
  const startedAtRef = useRef<number | undefined>(undefined);
  const editorSyncRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchSequenceRef = useRef(0);
  const navigationSequenceRef = useRef(0);
  const queuedActionRef = useRef<string | undefined>(undefined);

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

  const scrollConversationToBottom = useCallback(() => {
    const element = conversationScrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, []);

  useEffect(() => {
    if (!autoScrollRef.current) return;
    const frame = requestAnimationFrame(scrollConversationToBottom);
    return () => cancelAnimationFrame(frame);
  }, [messages, streamingMessage, tools, working, workingMessage, scrollConversationToBottom]);

  useEffect(() => {
    const thread = conversationThreadRef.current;
    if (!thread) return;
    const observer = new ResizeObserver(() => {
      if (autoScrollRef.current) scrollConversationToBottom();
    });
    observer.observe(thread);
    return () => observer.disconnect();
  }, [activeConversationId, scrollConversationToBottom]);

  useEffect(() => {
    autoScrollRef.current = true;
    const frame = requestAnimationFrame(scrollConversationToBottom);
    return () => cancelAnimationFrame(frame);
  }, [activeConversationId, scrollConversationToBottom]);

  const handleConversationScroll = useCallback(() => {
    const element = conversationScrollRef.current;
    if (!element) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceFromBottom <= 24) autoScrollRef.current = true;
    else if (userScrollInteractionRef.current) autoScrollRef.current = false;
  }, []);

  const handleConversationWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) autoScrollRef.current = false;
  }, []);

  const handleConversationPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    const rect = element.getBoundingClientRect();
    const scrollbarArea = Math.max(16, element.offsetWidth - element.clientWidth + 4);
    if (event.pointerType === "touch" || event.clientX >= rect.right - scrollbarArea) {
      userScrollInteractionRef.current = true;
    }
  }, []);

  const handleConversationPointerEnd = useCallback(() => {
    userScrollInteractionRef.current = false;
  }, []);

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
          next[optimisticIndex] = {
            ...next[optimisticIndex],
            ...event.message,
            attachments: next[optimisticIndex].attachments ?? event.message.attachments,
            optimistic: false,
          };
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
        if (delta.type === "toolcall_start") next.content[index] = {
          type: "toolCall",
          id: delta.toolCall?.id,
          name: delta.toolCall?.name ?? "Инструмент",
          arguments: delta.toolCall?.arguments ?? {},
          partialArguments: "",
        };
        if (delta.type === "text_delta") next.content[index].text = `${next.content[index].text ?? ""}${delta.delta ?? ""}`;
        if (delta.type === "thinking_delta") next.content[index].thinking = `${next.content[index].thinking ?? ""}${delta.delta ?? ""}`;
        if (delta.type === "toolcall_delta") {
          next.content[index].partialArguments = `${next.content[index].partialArguments ?? ""}${delta.delta ?? ""}`;
          if (delta.toolCall?.id) next.content[index].id = delta.toolCall.id;
          if (delta.toolCall?.name) next.content[index].name = delta.toolCall.name;
          if (delta.toolCall?.arguments && typeof delta.toolCall.arguments === "object") {
            next.content[index].arguments = delta.toolCall.arguments;
          }
        }
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
      if (event.state) {
        setSnapshot((current) => current ? { ...current, state: event.state } : current);
      }
    } else if (event.type === "desktop_state" && event.state) {
      setSnapshot((current) => current ? {
        ...current,
        state: event.state,
        commands: Array.isArray(event.commands) ? event.commands : current.commands,
      } : current);
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
    } else if (event.type === "compaction_start") {
      const alreadyWorking = startedAtRef.current !== undefined;
      const now = startedAtRef.current ?? Date.now();
      setWorking(true);
      setStartedAt(now);
      startedAtRef.current = now;
      if (!alreadyWorking) {
        setElapsed(0);
        setLastDuration(undefined);
      }
      autoScrollRef.current = true;
      setSnapshot((current) => current ? { ...current, state: { ...current.state, isCompacting: true } } : current);
      setWorkingMessage("Сжатие контекста…");
    } else if (event.type === "compaction_end") {
      setSnapshot((current) => current ? {
        ...current,
        state: event.state ?? { ...current.state, isCompacting: false },
        entries: Array.isArray(event.entries) ? event.entries : current.entries,
        compactions: Array.isArray(event.compactions) ? event.compactions : current.compactions,
      } : current);
      setWorking(Boolean(event.state?.isStreaming));
      setWorkingMessage("");
      if (event.errorMessage) addNotice(`Сжатие контекста: ${String(event.errorMessage)}`, "warning");
    } else if (event.type === "auto_retry_start") {
      setWorking(true);
      setWorkingMessage(`Повтор запроса ${Number(event.attempt ?? 0)}/${Number(event.maxAttempts ?? 0)}…`);
    } else if (event.type === "auto_retry_end") {
      setWorkingMessage("");
      if (event.success === false && event.finalError) addNotice(String(event.finalError), "error");
    } else if (event.type === "summarization_retry_scheduled") {
      setWorkingMessage(`Повтор сжатия ${Number(event.attempt ?? 0)}/${Number(event.maxAttempts ?? 0)}…`);
    } else if (event.type === "summarization_retry_finished") {
      setWorkingMessage("");
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
    } else if (event.type === "desktop_queue_update") {
      setQueuedPrompts(Array.isArray(event.queued) ? event.queued as QueuedPrompt[] : []);
    } else if (event.type === "desktop_queue_error") {
      addNotice(`Не удалось автоматически отправить сообщение из очереди: ${String(event.error ?? "неизвестная ошибка")}`, "error");
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
    setQueuedPrompts([]);
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
      setQueuedPrompts(next.queuedPrompts ?? []);
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
      setConversations((current) => {
        const found = current.some((item) => item.id === next.conversation.id);
        return found
          ? current.map((item) => item.id === next.conversation.id ? next.conversation : item)
          : [next.conversation, ...current];
      });
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
      setQueuedPrompts([]);
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
    setQueuedPrompts([]);
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

  const submit = async () => {
    const text = input.trim() || (attachments.length ? "Посмотри вложения." : "");
    if (!text || !activeConversationId) return;
    if (!working && (text === "/compact" || text.startsWith("/compact "))) {
      setInput("");
      await executeCompact(text.startsWith("/compact ") ? text.slice(9).trim() : undefined);
      return;
    }
    if (!working && text === "/reload") {
      setInput("");
      await executeReload();
      return;
    }
    const conversationId = activeConversationId;
    const submittedAttachments = attachments;
    autoScrollRef.current = true;
    setInput("");
    setAttachments([]);
    if (working) {
      try {
        const queued = await window.piDesktop.queuePrompt(conversationId, text, submittedAttachments);
        if (activeIdRef.current === conversationId) setQueuedPrompts(queued);
      } catch (error) {
        if (activeIdRef.current === conversationId) {
          setInput(text);
          setAttachments(submittedAttachments);
        }
        addNotice(error instanceof Error ? error.message : String(error), "error");
      }
      return;
    }
    const optimistic = {
      id: `local-${crypto.randomUUID()}`,
      role: "user",
      content: text,
      timestamp: Date.now(),
      attachments: submittedAttachments.map((item) => item.name),
      optimistic: true,
    };
    setMessages((current) => [...current, optimistic]);
    try {
      await window.piDesktop.sendPrompt(conversationId, text, submittedAttachments);
    } catch (error) {
      if (activeIdRef.current === conversationId) {
        setMessages((current) => current.filter((item) => item.id !== optimistic.id));
        setInput(text);
        setAttachments(submittedAttachments);
      }
      addNotice(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const sendQueuedPrompt = async (prompt: QueuedPrompt) => {
    if (!activeConversationId) return;
    if (queuedActionRef.current) return;
    const conversationId = activeConversationId;
    queuedActionRef.current = prompt.id;
    setQueuedActionId(prompt.id);
    try {
      const queued = await window.piDesktop.sendQueuedPrompt(conversationId, prompt.id);
      if (activeIdRef.current === conversationId) setQueuedPrompts(queued);
      autoScrollRef.current = true;
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      queuedActionRef.current = undefined;
      setQueuedActionId(undefined);
    }
  };

  const editQueuedPrompt = async (prompt: QueuedPrompt) => {
    if (!activeConversationId) return;
    if (queuedActionRef.current) return;
    const conversationId = activeConversationId;
    queuedActionRef.current = prompt.id;
    setQueuedActionId(prompt.id);
    try {
      const queued = await window.piDesktop.removeQueuedPrompt(conversationId, prompt.id);
      if (activeIdRef.current === conversationId) {
        setQueuedPrompts(queued);
        setInput((current) => current ? `${prompt.message}\n\n${current}` : prompt.message);
        setAttachments((current) => [
          ...prompt.attachments,
          ...current.filter((item) => !prompt.attachments.some((queuedAttachment) => queuedAttachment.id === item.id || queuedAttachment.path === item.path)),
        ]);
      }
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      queuedActionRef.current = undefined;
      setQueuedActionId(undefined);
    }
  };

  const deleteQueuedPrompt = async (promptId: string) => {
    if (!activeConversationId) return;
    if (queuedActionRef.current) return;
    const conversationId = activeConversationId;
    queuedActionRef.current = promptId;
    setQueuedActionId(promptId);
    try {
      const queued = await window.piDesktop.removeQueuedPrompt(conversationId, promptId);
      if (activeIdRef.current === conversationId) setQueuedPrompts(queued);
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      queuedActionRef.current = undefined;
      setQueuedActionId(undefined);
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
      setSnapshot((current) => current ? {
        ...current,
        state,
        thinkingLevels: model.thinkingLevels ?? current.thinkingLevels,
      } : current);
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

  const applyRuntimeSnapshot = (next: ConversationSnapshot) => {
    setSnapshot(next);
    setMessages(next.messages as JsonObject[]);
    setStreamingMessage(null);
    setSteeringMessages(next.state.steeringMessages ?? []);
    setFollowUpMessages(next.state.followUpMessages ?? []);
    setQueuedPrompts(next.queuedPrompts ?? []);
    setStatuses(next.extensionUi.statuses);
    setWorkingMessage(next.extensionUi.workingMessage ?? "");
    setWorkingVisible(next.extensionUi.workingVisible);
    setWorkingIndicator(next.extensionUi.workingIndicator);
    setHiddenThinkingLabel(next.extensionUi.hiddenThinkingLabel ?? "");
    setWidgets(next.extensionUi.widgets);
    setHeaderLines(next.extensionUi.headerLines);
    setFooterLines(next.extensionUi.footerLines);
  };

  const executeCompact = async (instructions?: string) => {
    if (!activeConversationId || working) return;
    const started = Date.now();
    setCommandPaletteOpen(false);
    setCompactDialogOpen(false);
    setWorking(true);
    setWorkingMessage("Сжатие контекста…");
    setStartedAt(started);
    startedAtRef.current = started;
    setElapsed(0);
    autoScrollRef.current = true;
    try {
      const next = await window.piDesktop.compactConversation(activeConversationId, instructions);
      applyRuntimeSnapshot(next);
      addNotice("Контекст сжат штатным механизмом Pi.", "info");
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      const duration = Date.now() - started;
      setWorking(false);
      setWorkingMessage("");
      setElapsed(duration);
      setLastDuration(duration);
      setStartedAt(undefined);
      startedAtRef.current = undefined;
    }
  };

  const executeReload = async () => {
    if (!activeConversationId || working) return;
    if (!window.confirm("Перезагрузить расширения, навыки, промпты и настройки Pi? Текущий процесс перечитает конфигурацию, поэтому KV-кэш может быть пересчитан.")) return;
    setCommandPaletteOpen(false);
    setWorking(true);
    setWorkingMessage("Перезагрузка ресурсов Pi…");
    try {
      const next = await window.piDesktop.reloadRuntime(activeConversationId);
      applyRuntimeSnapshot(next);
      addNotice("Ресурсы Pi перезагружены.", "info");
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setWorking(false);
      setWorkingMessage("");
    }
  };

  const insertCommand = (command: string) => {
    setCommandPaletteOpen(false);
    setInput(`/${command} `);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        if (event.key === "Escape") {
          setModelMenuOpen(false);
          setThinkingMenuOpen(false);
          setConversationMenu(undefined);
          setProjectMenu(undefined);
          setCommandPaletteOpen(false);
          setCompactDialogOpen(false);
          if (diffOpen) setDiffOpen(false);
        }
        return;
      }
      if (event.key.toLocaleLowerCase() === "n") {
        event.preventDefault();
        void newChat();
      } else if (event.shiftKey && event.key.toLocaleLowerCase() === "p") {
        event.preventDefault();
        if (activeConversationId) setCommandPaletteOpen(true);
      } else if (event.key === ",") {
        event.preventDefault();
        setSettingsOpen(true);
      } else if (event.key.toLocaleLowerCase() === "b") {
        event.preventDefault();
        setSidebarOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [diffOpen, extensionDialog, activeConversationId]);

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
  const historicalTranscriptItems = useMemo(() => {
    const visibleExtensionEntries = (snapshot?.entries ?? []).filter((entry) => entry.renderedLines?.length);
    const compactionEntries = (snapshot?.entries ?? []).filter((entry) => entry.type === "compaction");
    return [
      ...messages.map((message, sourceIndex): TranscriptTimelineItem => ({
        kind: "message",
        message,
        sourceIndex,
        timestamp: transcriptTimestamp(message.timestamp, Number.MAX_SAFE_INTEGER - 100_000 + sourceIndex),
        order: sourceIndex * 2,
      })),
      ...visibleExtensionEntries.map((entry, sourceIndex): TranscriptTimelineItem => ({
        kind: "extension",
        entry,
        sourceIndex,
        timestamp: transcriptTimestamp(entry.timestamp, Number.MAX_SAFE_INTEGER - 50_000 + sourceIndex),
        order: sourceIndex * 2 + 1,
      })),
      ...compactionEntries.map((entry, sourceIndex): TranscriptTimelineItem => ({
        kind: "compaction",
        entry,
        record: snapshot?.compactions.find((record) => record.entryId === entry.id),
        sourceIndex,
        timestamp: transcriptTimestamp(entry.timestamp, Number.MAX_SAFE_INTEGER - 25_000 + sourceIndex),
        order: sourceIndex * 2 + 2,
      })),
    ].sort((left, right) => left.timestamp - right.timestamp || left.order - right.order);
  }, [messages, snapshot?.entries, snapshot?.compactions]);
  const transcriptItems: TranscriptTimelineItem[] = streamingMessage ? [
    ...historicalTranscriptItems,
    {
      kind: "message",
      message: streamingMessage,
      sourceIndex: messages.length,
      timestamp: Number.MAX_SAFE_INTEGER,
      order: Number.MAX_SAFE_INTEGER,
    },
  ] : historicalTranscriptItems;
  const slashQuery = input.startsWith("/") && !input.includes(" ") ? input.slice(1).toLocaleLowerCase() : undefined;
  const slashCommands = slashQuery === undefined ? [] : (snapshot?.commands ?? [])
    .filter((command) => command.name.toLocaleLowerCase().includes(slashQuery))
    .slice(0, 10);
  const historicalToolIndex = useMemo(() => {
    const results = new Map<string, JsonObject>();
    const calls = new Set<string>();
    messages.forEach((message, messageIndex) => {
      if (message.role === "toolResult" || message.role === "tool") {
        const id = toolResultIdentifier(message);
        if (id) results.set(id, message);
      }
      toolCallParts(message).forEach((call, callIndex) => {
        calls.add(toolCallIdentifier(call, `message-${messageIndex}-tool-${callIndex}`));
      });
    });
    return { results, calls };
  }, [messages]);
  const streamingToolIds = new Set<string>();
  if (streamingMessage) {
    toolCallParts(streamingMessage).forEach((call, callIndex) => {
      streamingToolIds.add(toolCallIdentifier(call, `message-${messages.length}-tool-${callIndex}`));
    });
  }
  const hasTranscriptTool = (id: string): boolean => historicalToolIndex.calls.has(id) || streamingToolIds.has(id);
  const buildToolActivity = (call: JsonObject, fallbackId: string): ToolActivity => {
    const id = toolCallIdentifier(call, fallbackId);
    const live = tools[id];
    const persisted = historicalToolIndex.results.get(id);
    return {
      id,
      name: String(call.name && call.name !== "Инструмент" ? call.name : live?.name ?? persisted?.toolName ?? "Инструмент"),
      args: call.arguments ?? call.args ?? live?.args,
      partialArguments: typeof call.partialArguments === "string" ? call.partialArguments : undefined,
      result: persisted ? resultMessagePayload(persisted) : live?.result,
      running: live?.running ?? false,
      preparing: !live && !persisted && working,
      error: persisted ? Boolean(persisted.isError) : live?.error,
      startedAt: live?.startedAt ?? 0,
    };
  };
  const orphanTools = Object.values(tools).filter((tool) => !hasTranscriptTool(tool.id));
  const runningTool = Object.values(tools).find((tool) => tool.running);
  const streamingParts = Array.isArray(streamingMessage?.content) ? streamingMessage.content as JsonObject[] : [];
  const hasStreamingAnswer = streamingParts.some((part) => part.type === "text" && String(part.text ?? "").trim());
  const hasStreamingThinking = streamingParts.some((part) => part.type === "thinking" && String(part.thinking ?? part.text ?? "").trim());
  const activityLabel = runningTool
    ? `Выполняется: ${toolPresentation(runningTool.name, parsedToolArguments(runningTool.args)).label}`
    : workingMessage
      ? workingMessage
      : hasStreamingAnswer
        ? "Модель формирует ответ…"
        : hasStreamingThinking
        ? hiddenThinkingLabel || "Модель размышляет…"
        : "Модель работает…";
  const transcriptItemKey = (item: TranscriptTimelineItem, index: number): string => {
    if (item.kind === "message") return messageKey(item.message, item.sourceIndex);
    return String(item.entry.id ?? `${item.kind}-${item.sourceIndex}-${index}`);
  };
  const renderTranscriptItem = (item: TranscriptTimelineItem): ReactNode => {
    if (item.kind === "compaction") {
      const tokensBefore = item.record?.tokensBefore ?? Number(item.entry.tokensBefore);
      const tokensAfter = item.record?.tokensAfter ?? Number(item.entry.estimatedTokensAfter);
      return (
        <div className="compaction-entry">
          <Check size={14} />
          <span>Контекст сжат: <strong>{formatCompactTokens(tokensBefore)}</strong> → <strong>{formatCompactTokens(tokensAfter)}</strong>{item.record?.durationMs !== undefined ? ` за ${formatElapsed(item.record.durationMs)}` : ""}</span>
        </div>
      );
    }
    if (item.kind === "extension") {
      return (
        <div className="extension-entry">
          {item.entry.renderedLines!.map((line, lineIndex) => {
            const cleanLine = stripTerminalCodes(line);
            return <div key={`${lineIndex}-${cleanLine}`}>{cleanLine}</div>;
          })}
        </div>
      );
    }
    const { message, sourceIndex: index } = item;
    if (message.role === "toolResult" || message.role === "tool") {
      const id = toolResultIdentifier(message);
      if (id && hasTranscriptTool(id)) return null;
      return <ToolCard tool={{
        id: id ?? messageKey(message, index),
        name: String(message.toolName ?? message.name ?? "Инструмент"),
        result: resultMessagePayload(message),
        running: false,
        error: Boolean(message.isError),
        startedAt: 0,
      }} />;
    }
    const visibleMessage = messageWithoutToolCalls(message);
    const calls = toolCallParts(message);
    const isStreamingMessage = message === streamingMessage;
    return (
      <>
        {visibleMessage && <article className={`message ${message.role ?? "assistant"}`}>
          {message.role === "user" ? (
            <div className="user-bubble"><MessageContent message={visibleMessage} /></div>
          ) : (
            <div className="assistant-message"><MessageContent message={visibleMessage} assistant streaming={isStreamingMessage} /></div>
          )}
        </article>}
        {calls.map((call, callIndex) => <ToolCard
          key={toolCallIdentifier(call, `${messageKey(message, index)}-${callIndex}`)}
          tool={buildToolActivity(call, `${messageKey(message, index)}-${callIndex}`)}
        />)}
      </>
    );
  };

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

          <div
            className="conversation-scroll"
            ref={conversationScrollRef}
            onScroll={handleConversationScroll}
            onWheel={handleConversationWheel}
            onPointerDown={handleConversationPointerDown}
            onPointerUp={handleConversationPointerEnd}
            onPointerCancel={handleConversationPointerEnd}
          >
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
              <div className="thread" ref={conversationThreadRef}>
                {headerLines.length > 0 && <div className="extension-frame header-frame">{headerLines.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}</div>}
                <VirtualFilm
                  items={transcriptItems}
                  itemKey={transcriptItemKey}
                  renderItem={renderTranscriptItem}
                  resetKey={activeConversationId}
                  scrollRef={conversationScrollRef}
                />
                {orphanTools.map((tool) => <ToolCard key={tool.id} tool={tool} />)}
                {footerLines.length > 0 && <div className="extension-frame footer-frame">{footerLines.map((line, index) => <div key={`${index}-${line}`}>{line}</div>)}</div>}
                {working && (
                  <div className="run-activity" role="status" aria-live="polite">
                    <div className="run-activity-phase">
                      <WorkingIndicator indicator={workingIndicator} />
                      <span className="working-message">{activityLabel}</span>
                    </div>
                    <div className="run-activity-total"><Clock3 size={13} /> Работаю… <strong>{formatElapsed(elapsed)}</strong></div>
                  </div>
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
              </div>
            )}
          </div>

          {activeConversationId && (
            <div className={`composer-wrap${modelMenuOpen || thinkingMenuOpen || slashCommands.length > 0 ? " dropdown-open" : ""}`}>
              {slashCommands.length > 0 && <div className="slash-menu">
                {slashCommands.map((command) => <button key={`${command.source}-${command.name}`} onClick={() => setInput(`/${command.name} `)}>
                  <span><strong>/{command.name}</strong><small>{command.description ?? command.source}</small></span>
                  <em>{command.source}</em>
                </button>)}
              </div>}
              {queuedPrompts.length > 0 && <div className="queued-messages desktop-queue">
                <div className="queued-head"><span>Ожидают отправки: {queuedPrompts.length}</span></div>
                {queuedPrompts.map((prompt) => <div className="queued-message" key={prompt.id}>
                  <Clock3 size={13} />
                  <span title={prompt.message}>{prompt.message}</span>
                  {prompt.attachments.length > 0 && <small>{prompt.attachments.length} влож.</small>}
                  <div className="queued-actions">
                    <button className="queued-send" title="Передать сообщение модели" disabled={Boolean(queuedActionId)} onClick={() => void sendQueuedPrompt(prompt)}><Zap size={13} /><span>Скорректировать</span></button>
                    <button title="Вернуть в поле ввода" disabled={Boolean(queuedActionId)} onClick={() => void editQueuedPrompt(prompt)}><Pencil size={13} /></button>
                    <button title="Удалить из очереди" disabled={Boolean(queuedActionId)} onClick={() => void deleteQueuedPrompt(prompt.id)}><Trash2 size={13} /></button>
                  </div>
                </div>)}
              </div>}
              {(steeringMessages.length > 0 || followUpMessages.length > 0) && <div className="queued-messages">
                <div className="queued-head"><span>Очередь Pi: {steeringMessages.length + followUpMessages.length}</span><button onClick={() => void restoreQueuedMessages()}>Вернуть в редактор</button></div>
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
                  onPaste={(event) => {
                    const imageFiles = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
                    if (!imageFiles.length) return;
                    event.preventDefault();
                    void Promise.all(imageFiles.map(pastedImageAttachment))
                      .then((items) => setAttachments((current) => [...current, ...items]))
                      .catch((error) => addNotice(error instanceof Error ? error.message : String(error), "error"));
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                  placeholder={working ? "Сообщение будет добавлено в очередь…" : "Спросите что-нибудь или опишите задачу"}
                  rows={2}
                />
                <div className="composer-toolbar">
                  <button className="icon-button" title="Добавить вложение" onClick={() => void addAttachments()}><Paperclip size={18} /></button>
                  <button className="icon-button" title="Команды Pi (Ctrl+Shift+P)" onClick={() => setCommandPaletteOpen(true)}><SquareTerminal size={17} /></button>
                  <span className="access-chip"><Check size={13} /> Полный доступ</span>
                  <div className="composer-spacer" />
                  <div className="dropdown-wrap model-dropdown-wrap">
                    <button className="selector-button model-selector-button" title={snapshot?.state.model?.name ?? snapshot?.state.model?.id ?? "Модель"} onClick={() => { setThinkingMenuOpen(false); setModelMenuOpen((value) => !value); }}>
                      <span className="selector-label">{snapshot?.state.model?.name ?? snapshot?.state.model?.id ?? "Модель"}</span><ChevronDown size={13} />
                    </button>
                    {modelMenuOpen && <div className="dropdown-menu model-menu">
                      {snapshot?.models.map((model) => <button key={`${model.provider}/${model.id}`} className="dropdown-item" onClick={() => void changeModel(model)}>
                        <span><strong>{model.name ?? model.id}</strong><small>{model.provider}</small></span>
                        {snapshot.state.model?.provider === model.provider && snapshot.state.model?.id === model.id && <Check size={15} />}
                      </button>)}
                    </div>}
                  </div>
                  <div className="dropdown-wrap thinking-dropdown-wrap">
                    <button className="selector-button thinking-selector-button" title="Уровень рассуждений" onClick={() => { setModelMenuOpen(false); setThinkingMenuOpen((value) => !value); }}>
                      <span className="selector-label">{THINKING_LABELS[snapshot?.state.thinkingLevel ?? "off"]}</span><ChevronDown size={13} />
                    </button>
                    {thinkingMenuOpen && <div className="dropdown-menu thinking-menu">
                      {snapshot?.thinkingLevels.map((level) => <button key={level} className="dropdown-item" onClick={() => void changeThinking(level)}>
                        <span>{THINKING_LABELS[level]}</span>{snapshot.state.thinkingLevel === level && <Check size={15} />}
                      </button>)}
                    </div>}
                  </div>
                  {working ? (
                    <>
                      <button className="send-button" title="Поставить в очередь" disabled={!input.trim() && !attachments.length} onClick={() => void submit()}><Send size={17} /></button>
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
          {loading && <div className="loading-overlay"><span className="spinner" /> Загрузка чата…</div>}
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
      {commandPaletteOpen && snapshot && <CommandPalette
        commands={snapshot.commands}
        busy={working}
        onClose={() => setCommandPaletteOpen(false)}
        onCompact={() => { setCommandPaletteOpen(false); setCompactDialogOpen(true); }}
        onReload={() => void executeReload()}
        onInsert={insertCommand}
      />}
      {compactDialogOpen && <CompactDialog onClose={() => setCompactDialogOpen(false)} onCompact={(instructions) => void executeCompact(instructions)} />}
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

function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "—";
  if (tokens < 1_000) return String(Math.round(tokens));
  return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
}

function sanitizeStatusText(value?: string): string {
  if (!value) return "";
  return stripTerminalCodes(value)
    .replace(/\s+/g, " ")
    .trim();
}

function stripTerminalCodes(value: unknown): string {
  return String(value ?? "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001B[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
    .replace(/\s+$/g, "");
}

function pluralFiles(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return "файлов";
  if (last === 1) return "файл";
  if (last >= 2 && last <= 4) return "файла";
  return "файлов";
}

function pluralModels(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return "моделей";
  if (last === 1) return "модель";
  if (last >= 2 && last <= 4) return "модели";
  return "моделей";
}

function extensionName(extensionPath: string): string {
  const parts = extensionPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const extensionIndex = parts.lastIndexOf("extensions");
  if (extensionIndex >= 0 && parts[extensionIndex + 1]) return parts[extensionIndex + 1];
  return parts.at(-2) ?? parts.at(-1) ?? extensionPath;
}

async function pastedImageAttachment(file: File): Promise<Attachment> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Не удалось подготовить изображение из буфера обмена");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const png = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Не удалось преобразовать изображение в PNG")), "image/png");
  });
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Не удалось прочитать изображение из буфера обмена"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(png);
  });
  const separator = dataUrl.indexOf(",");
  if (separator < 0) throw new Error("Некорректное изображение в буфере обмена");
  const sourceName = file.name?.replace(/\.[^.]+$/, "") || `clipboard-${Date.now()}`;
  const name = `${sourceName}.png`;
  return {
    id: crypto.randomUUID(),
    name,
    path: `clipboard:${name}`,
    mimeType: "image/png",
    data: dataUrl.slice(separator + 1),
  };
}
