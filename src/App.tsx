import { t, getLocale, getLanguage, conversationTitle, setLanguage, useLanguage } from "./i18n";
import { LanguageSettings } from "./LanguageSettings";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowLeft,
  Bot,
  BookOpen,
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
  Play,
  Search,
  Send,
  Settings,
  RefreshCw,
  RotateCcw,
  SquareTerminal,
  Target,
  ListChecks,
  Pencil,
  Trash2,
  Wrench,
  X,
  Zap,
} from "lucide-react";
import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode, RefObject } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Plugin } from "unified";
import { applyAssistantMessageDelta } from "../shared/live-message";
import { GoalPanel } from "./GoalPanel";
import { PlanPanel } from "./PlanPanel";
import { NotebookPanel } from "./NotebookPanel";
import { PlanningPanel } from "./PlanningPanel";
import { isPlanning } from "../shared/planning";
import { SkillsPanel } from "./SkillsPanel";
import { ShellTimeout } from "./ShellTimeout";
import { shellTiming } from "./shell-timeout";
import { historyHasLaterMessages } from "../shared/session-history";
import { applyMessagePatch } from "../shared/message-sync";
import { NotebookSettings } from "./NotebookSettings";
import { BrowserPanel } from "./BrowserPanel";
import { ComfySettingsPanel } from "./ComfySettings";
import { WebAccessSettingsPanel } from "./WebAccessSettings";
import { collectComfyMedia, collectAnswerMedia, answerCanPublishMedia } from "./comfy-images";
import { ComfyMedia } from "./ComfyMedia";
import { MediaLink, markdownMediaUrl } from "./MediaLink";
import { PreviewImage } from "./ImagePreview";
import { MaskEditor } from "./MaskEditor";
import { quotedHistoryPrompt } from "./history-quotes";
import { mergeAttachments } from "./drop-attachments";
import { nestedToolActivities } from "./nested-tools";
import { planIsWorking } from "../shared/plan-activity";
import { composerAction } from "../shared/run-state";
import { afterFirstPaint } from "./after-first-paint";
import { visibleGoalText } from "../shared/goal";
import { visiblePlanRequestText } from "../shared/plan";
import { visibleImageAttachmentText } from "../shared/image-attachments";
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
  ProjectInstructions,
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
  parentToolCallId?: string;
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

type SettingsSection =
  | "general"
  | "web-access"
  | "comfyui"
  | "models"
  | "modules"
  | "customization"
  | "configuration"
  | "shortcuts"
  | "archive"
  | "about";

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
  | {
      kind: "message";
      message: JsonObject;
      fragment?: "thinking" | "answer";
      fragmentIndex?: number;
      sourceMessage?: JsonObject;
      historyActions?: boolean;
      sourceIndex: number;
      timestamp: number;
      order: number;
    }
  | {
      kind: "extension";
      entry: ConversationSnapshot["entries"][number];
      sourceIndex: number;
      timestamp: number;
      order: number;
    }
  | {
      kind: "compaction";
      entry: ConversationSnapshot["entries"][number];
      record?: CompactionRecord;
      sourceIndex: number;
      timestamp: number;
      order: number;
    };

/**
 * Each visible assistant text closes the preceding process fold. Later
 * thinking and tools start a new group below it, never absorbing earlier text.
 * Content fragments retain their original order, including while streaming.
 */
type TranscriptDisplayItem =
  | { display: "single"; item: TranscriptTimelineItem }
  | {
      display: "fold";
      key: string;
      process: TranscriptTimelineItem[];
      answer: TranscriptTimelineItem;
    };

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
  // Several tool results can share a timestamp. Position in this session is
  // part of the identity, not just a fallback for messages without a timestamp.
  return `message:${index}:${String(message.id ?? message.timestamp ?? message.role)}`;
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
  if (typeof message.content === "string")
    return message.role === "user"
      ? visiblePlanRequestText(visibleImageAttachmentText(visibleGoalText(message.content)))
      : message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part: JsonObject) => part?.type === "text")
    .map((part: JsonObject) =>
      message.role === "user"
        ? visiblePlanRequestText(visibleImageAttachmentText(visibleGoalText(String(part.text ?? ""))))
        : String(part.text ?? ""),
    )
    .join("\n");
}

function textFromResult(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const content = (result as JsonObject).content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item?.type === "text") return String(item.text ?? "");
        if (item?.type === "image")
          return t("[Изображение: {0}]", String(item.mimeType ?? "image"));
        if (item?.type === "audio")
          return t("[Аудио: {0}]", String(item.mimeType ?? "audio"));
        if (item?.type === "resource_link")
          return t("[Ресурс: {0}]", String(item.title ?? item.name ?? item.uri ?? t("ссылка")));
        if (item?.type === "resource")
          return t("[Встроенный ресурс: {0}]", String(item.resource?.uri ?? t("данные")));
        return `[${String(item?.type ?? t("данные"))}]`;
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
  return (
    <>
      {content.map((part, index) => {
        if (part.type === "text")
          return <Markdown key={index} text={String(part.text ?? "")} />;
        if (part.type === "image") {
          const src = mediaSource(part);
          return src ? (
            <PreviewImage
              className="content-image"
              key={index}
              src={src}
              alt={t("Изображение")}
            />
          ) : (
            <div className="muted" key={index}>{t("Изображение недоступно")}</div>
          );
        }
        if (part.type === "audio") {
          const src = mediaSource(part);
          return src ? (
            <audio className="content-audio" key={index} src={src} controls />
          ) : (
            <div className="muted" key={index}>{t("Аудио недоступно")}</div>
          );
        }
        if (part.type === "resource_link") {
          const href = String(part.uri ?? "");
          return (
            <a
              className="resource-link"
              key={index}
              href={href}
              target="_blank"
              rel="noreferrer"
            >
              {String(part.title ?? part.name ?? href)}
            </a>
          );
        }
        if (part.type === "resource") {
          const resource = part.resource as JsonObject | undefined;
          return (
            <pre className="embedded-resource" key={index}>
              {String(resource?.text ?? `[${resource?.uri ?? t("Ресурс")}]`)}
            </pre>
          );
        }
        return null;
      })}
    </>
  );
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

interface VirtualFilmAnchor {
  key: string;
  offset: number;
  stickToBottom: boolean;
}

// Стрелка «вниз» показывается, только когда до конца чата осталось больше
// порога: он же отсекает кратковременные отставания автопрокрутки при стриминге.
const SCROLL_HINT_THRESHOLD_PX = 120;
const SCROLL_GLIDE_MS = 320;

function filmScrollOffset(film: HTMLElement, scroll: HTMLElement): number {
  return film.getBoundingClientRect().top - scroll.getBoundingClientRect().top
    + scroll.scrollTop - scroll.clientTop;
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
  const layoutRef = useRef<VirtualFilmLayout>({
    resetKey: "",
    keys: [],
    heights: [],
    offsets: [],
    totalHeight: 0,
  });
  const resizeAnchorRef = useRef<VirtualFilmAnchor | null>(null);
  const measurementFrameRef = useRef(0);
  const [calibrating, setCalibrating] = useState(true);
  const [layoutRevision, setLayoutRevision] = useState(0);
  const [range, setRange] = useState({ start: 0, end: items.length });

  useLayoutEffect(() => () => {
    cancelAnimationFrame(measurementFrameRef.current);
    measurementFrameRef.current = 0;
  }, [resetKey]);

  if (layoutRef.current.resetKey !== resetKey) {
    layoutRef.current = {
      resetKey,
      keys: [],
      heights: [],
      offsets: [],
      totalHeight: 0,
    };
  }

  useLayoutEffect(() => {
    layoutRef.current = {
      resetKey,
      keys: [],
      heights: [],
      offsets: [],
      totalHeight: 0,
    };
    resizeAnchorRef.current = null;
    setCalibrating(true);
    setRange({ start: 0, end: items.length });
  }, [resetKey]);

  useLayoutEffect(() => {
    if (!calibrating) return;
    const film = filmRef.current;
    if (!film) return;
    const rows = [
      ...film.querySelectorAll<HTMLElement>("[data-virtual-film-row]"),
    ];
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
    const nextKeys = items.map(itemKey);
    if (
      nextKeys.length !== layout.keys.length ||
      nextKeys.some((key, index) => key !== layout.keys[index])
    ) {
      // Regrouping can replace an earlier row while the last key stays intact.
      // A positional cache would then assign another message's height to it.
      const heightsByKey = new Map(
        layout.keys.map((key, index) => [key, layout.heights[index]]),
      );
      layout.keys = nextKeys;
      layout.heights = nextKeys.map((key) => heightsByKey.get(key) ?? 120);
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
    const filmTop = filmScrollOffset(film, scroll);
    const viewportTop = Math.max(
      0,
      scroll.scrollTop - filmTop - overscan,
    );
    const viewportBottom =
      scroll.scrollTop - filmTop + scroll.clientHeight + overscan;
    const current = layoutRef.current;
    let low = 0;
    let high = current.offsets.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (current.offsets[middle] + current.heights[middle] < viewportTop)
        low = middle + 1;
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
    setRange((value) =>
      value.start === start && value.end === end ? value : { start, end },
    );
  }, [calibrating, items.length, scrollRef]);

  useLayoutEffect(() => {
    if (calibrating) return;
    const anchor = resizeAnchorRef.current;
    if (!anchor) return;
    const scroll = scrollRef.current;
    const film = filmRef.current;
    if (!scroll || !film) return;
    const current = layoutRef.current;
    if (anchor.stickToBottom) {
      scroll.scrollTop = scroll.scrollHeight;
    } else {
      const index = current.keys.indexOf(anchor.key);
      if (index >= 0) {
        const offset = Math.min(
          anchor.offset,
          Math.max(0, current.heights[index] - 1),
        );
        scroll.scrollTop = Math.max(
          0,
          filmScrollOffset(film, scroll) + current.offsets[index] + offset,
        );
      }
    }
    resizeAnchorRef.current = null;
    updateRange();
  }, [calibrating, layoutRevision, scrollRef, updateRange]);

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
        const film = filmRef.current;
        const current = layoutRef.current;
        if (film && current.keys.length > 0) {
          const viewportOffset = Math.max(0, scroll.scrollTop - filmScrollOffset(film, scroll));
          let low = 0;
          let high = current.offsets.length;
          while (low < high) {
            const middle = (low + high) >> 1;
            if (
              current.offsets[middle] + current.heights[middle] <=
              viewportOffset
            )
              low = middle + 1;
            else high = middle;
          }
          const index = Math.min(low, current.keys.length - 1);
          resizeAnchorRef.current = {
            key: current.keys[index],
            offset: Math.max(0, viewportOffset - current.offsets[index]),
            stickToBottom:
              scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <=
              24,
          };
        }
        setRange({ start: 0, end: items.length });
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
    const measureRows = (rows: HTMLElement[]) => {
      let changed = false;
      const scroll = scrollRef.current;
      const current = layoutRef.current;
      let anchor: VirtualFilmAnchor | null = null;
      if (scroll && current.keys.length > 0) {
        const viewportOffset = Math.max(0, scroll.scrollTop - filmScrollOffset(film, scroll));
        let low = 0;
        let high = current.offsets.length;
        while (low < high) {
          const middle = (low + high) >> 1;
          if (
            current.offsets[middle] + current.heights[middle] <=
            viewportOffset
          )
            low = middle + 1;
          else high = middle;
        }
        const index = Math.min(low, current.keys.length - 1);
        anchor = {
          key: current.keys[index],
          offset: Math.max(0, viewportOffset - current.offsets[index]),
          stickToBottom:
            scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= 24,
        };
      }
      for (const row of rows) {
        const index = Number(row.dataset.virtualIndex);
        const nextHeight = row.getBoundingClientRect().height;
        if (
          !film.contains(row) ||
          !Number.isInteger(index) ||
          index < 0 ||
          index >= current.keys.length ||
          row.dataset.virtualKey !== current.keys[index] ||
          Math.abs((current.heights[index] ?? 0) - nextHeight) < 0.5
        )
          continue;
        const difference = nextHeight - current.heights[index];
        current.heights[index] = nextHeight;
        current.totalHeight += difference;
        for (let next = index + 1; next < current.offsets.length; next += 1)
          current.offsets[next] += difference;
        changed = true;
      }
      if (changed) {
        if (!resizeAnchorRef.current) resizeAnchorRef.current = anchor;
        // A collapse can reveal many more rows to measure. Coalesce corrections
        // instead of recursively committing once for each newly visible row.
        if (!measurementFrameRef.current) {
          measurementFrameRef.current = requestAnimationFrame(() => {
            measurementFrameRef.current = 0;
            setLayoutRevision((value) => value + 1);
          });
        }
      }
    };
    const rows = [...film.querySelectorAll<HTMLElement>("[data-virtual-index]")];
    // Measure replacements synchronously before paint, then watch async growth.
    // Reattach after every commit: React may replace nodes without changing range.
    measureRows(rows);
    const observer = new ResizeObserver((entries) =>
      measureRows(entries.map((entry) => entry.target as HTMLElement)),
    );
    rows.forEach((row) => observer.observe(row));
    return () => observer.disconnect();
  });

  if (calibrating) {
    return (
      <div className="virtual-film-calibration" ref={filmRef}>
        {items.map((item, index) => (
          <div data-virtual-film-row key={itemKey(item, index)}>
            {renderItem(item, index)}
          </div>
        ))}
      </div>
    );
  }

  const visible: ReactNode[] = [];
  const start = Math.min(range.start, Math.max(0, items.length - 1));
  const end = Math.min(items.length, Math.max(start + 1, range.end));
  for (
    let index = start;
    index < end;
    index += 1
  ) {
    visible.push(
      <div
        className="virtual-film-frame"
        data-virtual-index={index}
        data-virtual-key={itemKey(items[index], index)}
        key={itemKey(items[index], index)}
      >
        {renderItem(items[index], index)}
      </div>,
    );
  }
  return (
    <div
      className="virtual-film"
      ref={filmRef}
    >
      <div className="virtual-film-spacer" aria-hidden="true"
        style={{ height: `${layout.offsets[start] ?? 0}px` }} />
      {visible}
      <div className="virtual-film-spacer" aria-hidden="true"
        style={{ height: `${Math.max(0, layout.totalHeight - (layout.offsets[end] ?? layout.totalHeight))}px` }} />
    </div>
  );
}

function createRevealTailPlugin(revealFrom: number): Plugin {
  return () => (tree) => {
    let freshWordIndex = 0;
    const visit = (parent: MarkdownTreeNode) => {
      if (!parent.children) return;
      const nextChildren: MarkdownTreeNode[] = [];
      for (const child of parent.children) {
        const end = child.position?.end?.offset;
        if (
          child.type === "text" &&
          child.value &&
          typeof end === "number" &&
          end > revealFrom
        ) {
          const freshLength = Math.min(child.value.length, end - revealFrom);
          const splitAt = child.value.length - freshLength;
          if (splitAt > 0)
            nextChildren.push({
              ...child,
              value: child.value.slice(0, splitAt),
            });
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
              properties: {
                className: [
                  "stream-reveal-fragment",
                  `stream-reveal-delay-${delayStep}`,
                ],
              },
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
  const revealFrom = text.startsWith(previousTextRef.current)
    ? previousTextRef.current.length
    : 0;
  const revealTailPlugin = useMemo(
    () => createRevealTailPlugin(revealFrom),
    [revealFrom],
  );

  useEffect(() => {
    previousTextRef.current = text;
  }, [text]);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[revealTailPlugin]}
      urlTransform={markdownMediaUrl}
      components={{
        img: ({ src, alt, title }) => <PreviewImage className="content-image" src={src} alt={alt} title={title} />,
        a: ({ href, children }) => <MediaLink href={href}>{children}</MediaLink>,
        code: ({ children, className }) => (
          <code className={className}>{children}</code>
        ),
        table: ({ children }) => (
          <div className="markdown-table-wrap">
            <table>{children}</table>
          </div>
        ),
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
  const content =
    message.role === "user"
      ? typeof message.content === "string"
        ? visiblePlanRequestText(visibleImageAttachmentText(visibleGoalText(message.content)))
        : Array.isArray(message.content)
          ? message.content.map((part: JsonObject) =>
              part?.type === "text"
                ? { ...part, text: visiblePlanRequestText(visibleImageAttachmentText(visibleGoalText(String(part.text ?? "")))) }
                : part,
            )
          : message.content
      : message.content;
  if (typeof content === "string") {
    return (
      <>
        {assistant ? (
          <div className="assistant-final">
            {streaming ? (
              <StreamingMarkdown text={content} />
            ) : (
              <Markdown text={content} />
            )}
          </div>
        ) : (
          <Markdown text={content} />
        )}
        {Array.isArray(message.images) && message.images.length > 0 && (
          <div className="message-images">
            {message.images.map(
              (
                image: { name: string; mimeType: string; data: string },
                index: number,
              ) => (
                <PreviewImage
                  key={`${image.name}-${index}`}
                  className="message-image-thumb"
                  src={`data:${image.mimeType};base64,${image.data}`}
                  alt={image.name}
                  title={image.name}
                />
              ),
            )}
          </div>
        )}
        {Array.isArray(message.attachments) && (
          <div className="message-attachments">
            {message.attachments.map((name: string) => (
              <span key={name}>
                <Paperclip size={12} />
                {name}
              </span>
            ))}
          </div>
        )}
      </>
    );
  }
  if (!Array.isArray(content)) return null;
  return (
    <>
      {content.map((part: JsonObject, index: number) => {
        if (
          ["text", "image", "audio", "resource", "resource_link"].includes(
            String(part.type),
          )
        ) {
          const rendered = <ContentParts content={[part]} />;
          return assistant && part.type === "text" ? (
            <div className="assistant-final" key={index}>
              {streaming ? (
                <StreamingMarkdown text={String(part.text ?? "")} />
              ) : (
                rendered
              )}
            </div>
          ) : (
            <Fragment key={index}>{rendered}</Fragment>
          );
        }
        if (part.type === "thinking") {
          if (index > 0 && content[index - 1]?.type === "thinking") return null;
          let thinkingEnd = index;
          while (
            thinkingEnd < content.length &&
            content[thinkingEnd]?.type === "thinking"
          )
            thinkingEnd += 1;
          const text = content
            .slice(index, thinkingEnd)
            .map((candidate: JsonObject) =>
              String(candidate.thinking ?? candidate.text ?? "").trim(),
            )
            .filter(Boolean)
            .join("\n\n");
          if (!text) return null;
          return (
            <div
              className={`thinking-block ${streaming ? "streaming" : ""}`}
              key={index}
            >
              {streaming ? (
                <StreamingMarkdown text={text} />
              ) : (
                <Markdown text={text} />
              )}
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
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={markdownMediaUrl}
      components={{
        img: ({ src, alt, title }) => <PreviewImage className="content-image" src={src} alt={alt} title={title} />,
        a: ({ href, children }) => <MediaLink href={href}>{children}</MediaLink>,
        code: ({ children, className }) => (
          <code className={className}>{children}</code>
        ),
        table: ({ children }) => (
          <div className="markdown-table-wrap">
            <table>{children}</table>
          </div>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  );
}

function parsedToolArguments(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as JsonObject;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return { input: value };
  }
}

function toolCallParts(message: JsonObject): JsonObject[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.filter(
    (part: JsonObject) =>
      part?.type === "toolCall" || part?.type === "tool_call",
  );
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
  const content = message.content.filter(
    (part: JsonObject) =>
      part?.type !== "toolCall" && part?.type !== "tool_call",
  );
  return content.length ? { ...message, content } : undefined;
}

function hasAnswerText(message: JsonObject): boolean {
  if (typeof message.content === "string") return Boolean(message.content.trim());
  if (!Array.isArray(message.content)) return false;
  return message.content.some(
    (part: JsonObject) =>
      part?.type === "text" && String(part.text ?? "").trim(),
  );
}

function splitAssistantTimelineItem(item: TranscriptTimelineItem): TranscriptTimelineItem[] {
  if (item.kind !== "message" || item.message.role !== "assistant") return [item];
  const content: JsonObject[] = Array.isArray(item.message.content)
    ? item.message.content
    : [];
  const groups: { process: boolean; index: number; content: JsonObject[] }[] = [];
  content.forEach((part, index) => {
    const process = ["thinking", "toolCall", "tool_call"].includes(String(part?.type));
    const previous = groups[groups.length - 1];
    if (previous?.process === process) previous.content.push(part);
    else groups.push({ process, index, content: [part] });
  });
  if (groups.length < 2) return [item];
  const lastAnswer = groups.reduce((last, group, index) => !group.process &&
    hasAnswerText({ content: group.content }) ? index : last, -1);
  return groups.map((group, index) => ({
    ...item,
    fragment: group.process ? "thinking" : "answer",
    fragmentIndex: group.index,
    sourceMessage: item.message,
    historyActions: index === lastAnswer,
    message: { ...item.message, content: group.content },
  }));
}

function buildTranscriptDisplay(
  items: TranscriptTimelineItem[],
): TranscriptDisplayItem[] {
  const result: TranscriptDisplayItem[] = [];
  let buffer: TranscriptTimelineItem[] = [];
  const flush = () => {
    for (const item of buffer) result.push({ display: "single", item });
    buffer = [];
  };
  for (const item of items.flatMap(splitAssistantTimelineItem)) {
    if (item.kind === "compaction") {
      flush();
      result.push({ display: "single", item });
      continue;
    }
    if (item.kind === "extension") {
      buffer.push(item);
      continue;
    }
    const role = String(item.message.role ?? "");
    if (role === "custom" && item.message.display === false) continue;
    if (role !== "assistant") {
      if (role === "toolResult" || role === "tool") {
        buffer.push(item);
        continue;
      }
      flush();
      result.push({ display: "single", item });
      continue;
    }
    if (!hasAnswerText(item.message)) {
      buffer.push(item);
      continue;
    }
    const key = `fold:${messageKey(item.message, item.sourceIndex)}:${item.fragmentIndex ?? "whole"}`;
    if (buffer.length) {
      result.push({
        display: "fold",
        key,
        process: buffer.slice(),
        answer: item,
      });
    } else {
      result.push({ display: "single", item });
    }
    buffer = [];
  }
  flush();
  return result;
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

function partialJsonStringValues(
  source: string | undefined,
  field: string,
): string[] {
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

function toolCodeFragments(
  name: string,
  args: JsonObject,
  partialArguments?: string,
): string[] {
  const normalized = name.toLocaleLowerCase();
  if (normalized === "edit") {
    const complete = Array.isArray(args.edits)
      ? args.edits
          .map((edit: JsonObject) => edit?.newText)
          .filter(
            (value: unknown): value is string => typeof value === "string",
          )
      : typeof args.newText === "string"
        ? [args.newText]
        : [];
    return complete.length > 0
      ? complete
      : partialJsonStringValues(partialArguments, "newText");
  }
  if (normalized === "write") {
    if (typeof args.content === "string") return [args.content];
    return partialJsonStringValues(partialArguments, "content");
  }
  return [];
}

function compactLine(value: unknown, limit = 110): string {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function toolPresentation(
  name: string,
  args: JsonObject,
): {
  icon: "terminal" | "file" | "search" | "folder" | "mcp" | "tool";
  label: string;
  summary?: string;
  command?: string;
  showRawArgs?: boolean;
} {
  const normalized = name.toLocaleLowerCase().replace(/^media_/, "comfyui_");
  const path = args.path ?? args.file ?? args.filePath;
  if (normalized.startsWith("comfyui_") || normalized === "desktop_show_image" || normalized === "desktop_get_image_path") {
    const labels: Record<string, string> = {
      desktop_show_image: t("Показать изображение"),
      desktop_get_image_path: t("Путь к изображению из чата"),
      comfyui_list_attachments: t("Изображения из чата"),
      comfyui_status: t("Подключение ComfyUI"),
      comfyui_generate_image: t("Генерация изображения"),
      comfyui_edit_image: t("Редактирование изображения"),
      comfyui_remove_background: t("Удаление фона"),
      comfyui_generate_music: t("Генерация музыки YuE2"),
      comfyui_generate_instrumental_music: t("Инструментальная музыка YuE2"),
      comfyui_cover_music: t("Кавер YuE2"),
      comfyui_publish_music: t("Выбрать треки для ответа"),
      comfyui_plan_music: t("Нотный план YuE2"),
      comfyui_edit_vocals: t("Убрать вокал из нот YuE2"),
      comfyui_generate_3d: t("Генерация 3D-модели"),
      comfyui_compose_image: t("Композиция из референсов"),
      comfyui_inpaint_image: t("Редактирование по маске"),
      comfyui_create_mask: t("Выделение объекта SAM 3.1"),
      comfyui_outpaint_image: t("Расширение холста"),
      comfyui_extract_subject: t("Извлечение объекта Qwen"),
    };
    return { icon: "tool", label: labels[normalized] ?? "ComfyUI", summary: compactLine(args.prompt ?? ""), showRawArgs: true };
  }
  if (
    normalized === "bash" ||
    normalized === "shell" ||
    normalized === "exec"
  ) {
    const command = String(args.command ?? args.cmd ?? args.input ?? "");
    return {
      icon: "terminal",
      label: t("Команда"),
      summary: compactLine(command),
      command,
    };
  }
  if (normalized === "read") {
    const offset = Number(args.offset ?? 0);
    const limit = Number(args.limit ?? 0);
    const range =
      offset > 0
        ? `:${offset}${limit > 0 ? `–${offset + limit - 1}` : ""}`
        : "";
    return {
      icon: "file",
      label: t("Чтение"),
      summary: `${String(path ?? t("файл"))}${range}`,
    };
  }
  if (normalized === "edit")
    return {
      icon: "file",
      label: t("Изменение"),
      summary: String(path ?? t("файл")),
    };
  if (normalized === "write")
    return { icon: "file", label: t("Запись"), summary: String(path ?? t("файл")) };
  if (normalized === "grep")
    return {
      icon: "search",
      label: t("Поиск"),
      summary: `${compactLine(args.pattern ?? "")} · ${String(path ?? ".")}`,
    };
  if (normalized === "find")
    return {
      icon: "search",
      label: t("Поиск файлов"),
      summary: `${compactLine(args.pattern ?? "")} · ${String(path ?? ".")}`,
    };
  if (normalized === "ls")
    return {
      icon: "folder",
      label: t("Список файлов"),
      summary: String(path ?? "."),
    };
  if (normalized.startsWith("mcp__") || normalized.startsWith("mcp_")) {
    const parts = name.split("__");
    return {
      icon: "mcp",
      label: parts.at(-1)?.replace(/[-_]/g, " ") || name,
      summary: parts.length > 2 ? parts[1] : "MCP",
      showRawArgs: true,
    };
  }
  return { icon: "tool", label: name, showRawArgs: true };
}

function ToolIcon({
  kind,
}: {
  kind: ReturnType<typeof toolPresentation>["icon"];
}) {
  if (kind === "terminal") return <SquareTerminal size={15} />;
  if (kind === "file") return <FileText size={15} />;
  if (kind === "search") return <Search size={15} />;
  if (kind === "folder") return <Folder size={15} />;
  if (kind === "mcp") return <Boxes size={15} />;
  return <Wrench size={15} />;
}

function ToolDiffPreview({
  diff,
  expanded,
}: {
  diff: string;
  expanded: boolean;
}) {
  const lines = diff.replace(/\r\n/g, "\n").split("\n");
  const visible = expanded ? lines : lines.slice(0, 10);
  return (
    <pre className="tool-diff-output">
      {visible.map((line, index) => (
        <span
          className={
            line.startsWith("+") && !line.startsWith("+++")
              ? "added"
              : line.startsWith("-") && !line.startsWith("---")
                ? "removed"
                : ""
          }
          key={`${index}-${line}`}
        >
          {line || " "}
        </span>
      ))}
      {!expanded && lines.length > visible.length && (
        <em>{t("… ещё")}{" "}{lines.length - visible.length}{t(" строк")}</em>
      )}
    </pre>
  );
}

function ToolTextOutput({
  text,
  expanded,
}: {
  text: string;
  expanded: boolean;
}) {
  const lines = text.split("\n");
  const visible = expanded ? lines : lines.slice(0, 8);
  return (
    <pre className="tool-text-output">
      {visible.join("\n")}
      {!expanded && lines.length > visible.length
        ? t("\n… ещё {0} строк", lines.length - visible.length)
        : ""}
    </pre>
  );
}

function ToolResultContent({
  result,
  expanded,
  name,
  hideMedia = false,
}: {
  result: unknown;
  expanded: boolean;
  name?: string;
  hideMedia?: boolean;
}) {
  const object =
    result && typeof result === "object" ? (result as JsonObject) : undefined;
  const diff =
    typeof object?.details?.diff === "string" ? object.details.diff : undefined;
  if (diff) return <ToolDiffPreview diff={diff} expanded={expanded} />;
  const text = toolOutputText(result);
  const generated = collectComfyMedia([{ id: "result", name: name ?? "", result }]);
  const media = Array.isArray(object?.content)
    ? (object.content.filter(
        (part: JsonObject) => part?.type !== "text",
      ) as JsonObject[])
    : [];
  return (
    <>
      {text && <ToolTextOutput text={text} expanded={expanded} />}
      {!hideMedia && (generated.length > 0 ? <ComfyMedia parts={generated} /> : media.length > 0 && <ContentParts content={media} />)}
    </>
  );
}

function ToolCard({ tool, hideMedia = false }: { tool: ToolActivity; hideMedia?: boolean }) {
  const args = parsedToolArguments(tool.args);
  const presentation = toolPresentation(tool.name, args);
  const timing = shellTiming(tool.name, args, tool.result, tool.startedAt, tool.preparing);
  const [expanded, setExpanded] = useState(false);
  const output = tool.result === undefined ? "" : toolOutputText(tool.result);
  const codeFragments = toolCodeFragments(
    tool.name,
    args,
    tool.partialArguments,
  );
  const hasDetails = Boolean(
    codeFragments.length ||
      presentation.command ||
      (presentation.showRawArgs && Object.keys(args).length) ||
      output ||
      (tool.result as JsonObject | undefined)?.content?.some?.((part: JsonObject) => part?.type !== "text") ||
      (tool.result as JsonObject | undefined)?.details?.diff,
  );
  return (
    <div
      className={`tool-card ${tool.preparing || tool.running ? "running" : "complete"} ${tool.error ? "error" : ""}`}
    >
      <button
        className="tool-card-head"
        disabled={!hasDetails}
        onClick={() => setExpanded((value) => !value)}
      >
        {hasDetails ? (
          expanded ? (
            <ChevronDown size={15} />
          ) : (
            <ChevronRight size={15} />
          )
        ) : (
          <span className="tool-chevron-space" />
        )}
        <ToolIcon kind={presentation.icon} />
        <span className="tool-heading">
          <strong>{presentation.label}</strong>
          {presentation.summary && <small>{presentation.summary}</small>}
        </span>
        {timing && <ShellTimeout timing={timing} running={tool.running && !tool.preparing} />}
        <span className="tool-state">
          {tool.preparing
            ? t("Формируется…")
            : tool.running
              ? t("Выполняется…")
              : tool.error
                ? t("Ошибка")
                : t("Готово")}
        </span>
      </button>
      {expanded && hasDetails && (
        <div className="tool-card-body">
          {tool.result === undefined && codeFragments.length > 0 && (
            <div className="tool-code-preview">
              {codeFragments.map((fragment, index) => (
                <div
                  className="tool-code-fragment"
                  key={`${index}-${fragment.length}`}
                >
                  {codeFragments.length > 1 && (
                    <small>{t("Фрагмент")}{" "}{index + 1}</small>
                  )}
                  <pre>{fragment || " "}</pre>
                </div>
              ))}
            </div>
          )}
          {presentation.command && (
            <pre className="tool-command">{presentation.command}</pre>
          )}
          {presentation.showRawArgs && Object.keys(args).length > 0 && (
            <details className="tool-arguments">
              <summary>{t("Параметры")}</summary>
              <pre>{JSON.stringify(args, null, 2)}</pre>
            </details>
          )}
          {tool.result !== undefined && (
            <ToolResultContent result={tool.result} name={tool.name} expanded hideMedia={hideMedia} />
          )}
        </div>
      )}
    </div>
  );
}

function WorkingIndicator({
  indicator,
}: {
  indicator?: { frames?: string[]; intervalMs?: number };
}) {
  const frames = indicator?.frames?.filter(Boolean) ?? [];
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0);
    if (frames.length < 2) return;
    const timer = setInterval(
      () => setIndex((value) => (value + 1) % frames.length),
      Math.max(60, indicator?.intervalMs ?? 100),
    );
    return () => clearInterval(timer);
  }, [frames.join("\u0000"), indicator?.intervalMs]);
  return frames.length ? (
    <span className="working-frame">{frames[index] ?? frames[0]}</span>
  ) : (
    <span className="spinner" />
  );
}

function DiffHunkView({ hunk }: { hunk: DiffHunk }) {
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return (
    <div className="diff-hunk">
      <div className="diff-hunk-header">
        @@ −{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
      </div>
      {hunk.lines.map((line, index) => {
        const marker = line[0] ?? " ";
        const isAdded = marker === "+";
        const isRemoved = marker === "-";
        const oldNumber = isAdded ? "" : oldLine++;
        const newNumber = isRemoved ? "" : newLine++;
        return (
          <div
            className={`diff-line ${isAdded ? "added" : isRemoved ? "removed" : "context"}`}
            key={`${index}-${line}`}
          >
            <span>{oldNumber}</span>
            <span>{newNumber}</span>
            <code>{line}</code>
          </div>
        );
      })}
    </div>
  );
}

function DiffPanel({ diff, onClose }: { diff: RunDiff; onClose: () => void }) {
  return (
    <aside className="diff-panel">
      <header className="diff-panel-title">
        <strong>{t("Изменения за прогон")}</strong>
        <button className="icon-button" onClick={onClose}>
          <X size={17} />
        </button>
      </header>
      <div className="diff-panel-summary">
        <span>
          {diff.files.length} {pluralFiles(diff.files.length)}
        </span>
        <span className="diff-add">+{diff.additions}</span>
        <span className="diff-remove">−{diff.deletions}</span>
      </div>
      {diff.incomplete && (
        <div className="diff-warning">{t("Некоторые большие или двоичные файлы изменились и не показаны.")}</div>
      )}
      <div className="diff-files">
        {diff.files.map((file) => (
          <section className="diff-file" key={file.path}>
            <div className="diff-file-head" title={file.path}>
              <FileText size={14} />
              <span>{file.relativePath}</span>
              <small className="diff-add">+{file.additions}</small>
              <small className="diff-remove">−{file.deletions}</small>
            </div>
            {file.hunks.map((hunk, index) => (
              <DiffHunkView
                hunk={hunk}
                key={`${hunk.oldStart}-${hunk.newStart}-${index}`}
              />
            ))}
          </section>
        ))}
        {!diff.files.length && (
          <div className="diff-empty">{t("Текстовые файлы не изменялись.")}</div>
        )}
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
    await window.piDesktop.respondToExtensionUi(conversationId, {
      id: request.id,
      ...payload,
    });
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
          <strong>{request.title ?? t("Расширение Pi")}</strong>
          <button
            className="icon-button"
            onClick={() => void respond({ cancelled: true })}
          >
            <X size={17} />
          </button>
        </div>
        {request.message && <p>{request.message}</p>}
        {request.method === "custom" && (
          <pre className="extension-custom-frame">
            {(request.customLines ?? []).join("\n")}
          </pre>
        )}
        {request.method === "select" && (
          <div className="select-list">
            {(request.options ?? []).map((option) => (
              <button
                key={option}
                onClick={() => void respond({ value: option })}
              >
                {option}
              </button>
            ))}
          </div>
        )}
        {(request.method === "input" || request.method === "editor") &&
          (request.method === "editor" ? (
            <textarea
              className="modal-editor"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoFocus
            />
          ) : (
            <input
              className="modal-input"
              value={value}
              placeholder={request.placeholder}
              onChange={(event) => setValue(event.target.value)}
              autoFocus
            />
          ))}
        <div className="modal-actions">
          <button onClick={() => void respond({ cancelled: true })}>
            {request.method === "custom" ? t("Закрыть") : t("Отмена")}
          </button>
          {request.method === "confirm" && (
            <button onClick={() => void respond({ confirmed: false })}>{t("Нет")}</button>
          )}
          {request.method === "confirm" && (
            <button
              className="primary"
              onClick={() => void respond({ confirmed: true })}
            >{t("Да")}</button>
          )}
          {(request.method === "input" || request.method === "editor") && (
            <button className="primary" onClick={() => void respond({ value })}>{t("Готово")}</button>
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
  if (!event.altKey && !event.metaKey && event.key.length === 1)
    return event.key;
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
    setFolders((current) => [
      ...current,
      ...selected.filter((item) => !current.includes(item)),
    ]);
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
          <strong>{t("Создать проект")}</strong>
          <button className="icon-button" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <label className="project-name-field">
          <span>{t("Название")}</span>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("Название проекта")}
            autoFocus
          />
        </label>
        <div className="project-folders-head">
          <strong>{t("Рабочие папки")}</strong>
          <span>{t("Первая папка будет основной")}</span>
        </div>
        <div className="project-folders">
          {folders.map((folder, index) => (
            <div className="project-folder-chip" key={folder}>
              <Folder size={15} />
              <span>{folder}</span>
              {index === 0 && <small>{t("Основная")}</small>}
              <button
                title={t("Убрать папку")}
                onClick={() =>
                  setFolders((current) =>
                    current.filter((item) => item !== folder),
                  )
                }
              >
                <X size={14} />
              </button>
            </div>
          ))}
          <button
            className="add-folders-button"
            onClick={() => void addFolders()}
          >
            <Plus size={16} />{t(" Добавить папки")}</button>
        </div>
        <div className="modal-actions">
          <button onClick={onClose}>{t("Отмена")}</button>
          <button
            className="primary"
            disabled={!folders.length || saving}
            onClick={() => void create()}
          >
            {saving ? t("Создание…") : t("Создать проект")}
          </button>
        </div>
      </div>
    </div>
  );
}

function RenameConversationDialog({
  title,
  heading = t("Переименовать чат"),
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
      <form
        className="modal-card rename-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          const normalized = value.trim();
          if (normalized) onSave(normalized);
        }}
      >
        <div className="modal-head">
          <strong>{heading}</strong>
          <button type="button" className="icon-button" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <input
          className="modal-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          autoFocus
        />
        <div className="modal-actions">
          <button type="button" onClick={onClose}>{t("Отмена")}</button>
          <button className="primary" type="submit" disabled={!value.trim()}>{t("Сохранить")}</button>
        </div>
      </form>
    </div>
  );
}

function ProjectInstructionsDialog({
  project,
  onClose,
}: {
  project: ProjectRecord;
  onClose: () => void;
}) {
  const [instructions, setInstructions] = useState<ProjectInstructions>();
  const [value, setValue] = useState("");
  const [savedValue, setSavedValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let cancelled = false;
    void window.piDesktop
      .getProjectInstructions(project.id)
      .then((result) => {
        if (cancelled) return;
        setInstructions(result);
        setValue(result.content);
        setSavedValue(result.content);
      })
      .catch((error) => {
        if (!cancelled)
          setStatus(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const save = async () => {
    if (saving) return;
    setSaving(true);
    setStatus("");
    try {
      const result = await window.piDesktop.saveProjectInstructions(
        project.id,
        value,
      );
      setInstructions(result);
      setValue(result.content);
      setSavedValue(result.content);
      setStatus(
        t("Сохранено. Чаты проекта применят инструкции перед следующим запросом."),
      );
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop">
      <div className="modal-card project-instructions-dialog">
        <div className="modal-head">
          <strong>{t("Инструкции проекта «")}{project.name}»</strong>
          <button type="button" className="icon-button" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <p>{t("Pi автоматически добавляет этот файл к системному промпту для проекта.")}</p>
        <textarea
          className="modal-editor"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setStatus("");
          }}
          onKeyDown={(event) => {
            if (
              (event.ctrlKey || event.metaKey) &&
              event.key.toLocaleLowerCase() === "s"
            ) {
              event.preventDefault();
              if (!loading && !saving) void save();
            }
          }}
          disabled={loading}
          placeholder={loading ? t("Загрузка…") : t("Введите инструкции для модели…")}
          spellCheck
          autoFocus
        />
        <div className="project-instructions-info">
          <span>
            {instructions?.filePath ?? `${project.path}\\AGENTS.md`} · UTF-8
          </span>
          {!loading && instructions && !instructions.exists && (
            <small>{t("Файл будет создан при сохранении.")}</small>
          )}
          {status && <strong>{status}</strong>}
        </div>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>{t("Закрыть")}</button>
          <button
            type="button"
            className="primary"
            disabled={
              loading ||
              saving ||
              (instructions?.exists && value === savedValue)
            }
            onClick={() => void save()}
          >
            {saving ? t("Сохранение…") : t("Сохранить")}
          </button>
        </div>
      </div>
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
  const textCommands = commands.filter(
    (command) =>
      !["compact", "reload"].includes(command.name) &&
      (!normalized ||
        command.name.toLocaleLowerCase().includes(normalized) ||
        command.description?.toLocaleLowerCase().includes(normalized)),
  );
  return (
    <div className="modal-backdrop">
      <div className="modal-card command-palette">
        <div className="modal-head">
          <strong>{t("Команды Pi")}</strong>
          <button className="icon-button" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <div className="command-search">
          <Search size={15} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("Найти команду…")}
            autoFocus
          />
        </div>
        <div className="command-section-title">{t("Действия приложения")}</div>
        <div className="command-list">
          <button disabled={busy} onClick={onCompact}>
            <span>
              <strong>{t("Сжать контекст")}</strong>
              <small>{t("Штатная команда Pi `/compact`; можно добавить инструкции для сводки.")}</small>
            </span>
            <code>/compact</code>
          </button>
          <button disabled={busy} onClick={onReload}>
            <span>
              <strong>{t("Перезагрузить ресурсы Pi")}</strong>
              <small>{t("Расширения, навыки, промпты, настройки и файлы контекста.")}</small>
            </span>
            <code>/reload</code>
          </button>
        </div>
        <div className="command-section-title">{t("Команды расширений, шаблоны и навыки")}</div>
        <div className="command-list command-dynamic-list">
          {textCommands.map((command) => (
            <button
              key={`${command.source}-${command.name}`}
              onClick={() => onInsert(command.name)}
            >
              <span>
                <strong>/{command.name}</strong>
                <small>
                  {command.description || t("Описание не предоставлено")}
                </small>
              </span>
              <em>
                {command.source === "extension"
                  ? t("Модуль")
                  : command.source === "skill"
                    ? t("Навык")
                    : t("Шаблон")}
              </em>
            </button>
          ))}
          {!textCommands.length && (
            <div className="command-empty">{t("Подходящих команд нет.")}</div>
          )}
        </div>
        <div className="command-palette-note">{t("Выбор команды расширения помещает её в поле ввода — аргументы можно дописать перед отправкой.")}</div>
      </div>
    </div>
  );
}

function CompactDialog({
  onClose,
  onCompact,
}: {
  onClose: () => void;
  onCompact: (instructions?: string) => void;
}) {
  const [instructions, setInstructions] = useState("");
  return (
    <div className="modal-backdrop">
      <div className="modal-card compact-dialog">
        <div className="modal-head">
          <strong>{t("Сжать контекст")}</strong>
          <button className="icon-button" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <p>{t("Pi создаст сводку предыдущего контекста и сохранит последние сообщения без изменений.")}</p>
        <label>
          <span>{t("Дополнительные инструкции для сводки")}</span>
          <textarea
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder={t("Необязательно")}
            autoFocus
          />
        </label>
        <div className="modal-actions">
          <button onClick={onClose}>{t("Отмена")}</button>
          <button
            className="primary"
            onClick={() => onCompact(instructions.trim() || undefined)}
          >{t("Сжать")}</button>
        </div>
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
  const [contextWindow, setContextWindow] = useState(
    model.contextWindow?.toString() ?? "",
  );
  const [maxTokens, setMaxTokens] = useState(model.maxTokens?.toString() ?? "");
  const [reasoning, setReasoning] = useState(model.reasoning);
  const [vision, setVision] = useState(model.input.includes("image"));
  const [levels, setLevels] = useState<ThinkingLevel[]>(model.thinkingLevels);
  const [samplingParams, setSamplingParams] = useState(
    model.samplingParams ? JSON.stringify(model.samplingParams, null, 2) : "{}",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const toggleLevel = (level: ThinkingLevel) =>
    setLevels((current) =>
      current.includes(level)
        ? current.filter((item) => item !== level)
        : [...current, level],
    );
  const save = async () => {
    setError("");
    let parsedSampling: Record<string, number | boolean | string> | undefined;
    try {
      const parsed = samplingParams.trim() ? JSON.parse(samplingParams) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error(t("Параметры семплирования должны быть объектом JSON"));
      const invalid = Object.entries(parsed).find(
        ([, value]) => !["number", "boolean", "string"].includes(typeof value),
      );
      if (invalid)
        throw new Error(
          t("Параметр «{0}» должен быть числом, строкой или логическим значением", invalid[0]),
        );
      parsedSampling = parsed as Record<string, number | boolean | string>;
    } catch (parseError) {
      setError(
        parseError instanceof Error ? parseError.message : String(parseError),
      );
      return;
    }
    const parseOptionalInteger = (
      value: string,
      label: string,
    ): number | undefined => {
      if (!value.trim()) return undefined;
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0)
        throw new Error(t("{0} должен быть положительным целым числом", label));
      return parsed;
    };
    try {
      setSaving(true);
      await onSave({
        providerId,
        originalModelId: model.id,
        id: id.trim(),
        name: name.trim() || undefined,
        contextWindow: parseOptionalInteger(contextWindow, t("Контекст")),
        maxTokens: parseOptionalInteger(maxTokens, t("Лимит ответа")),
        reasoning,
        input: vision ? ["text", "image"] : ["text"],
        thinkingLevels: reasoning ? levels : ["off"],
        samplingParams: parsedSampling,
      });
      onClose();
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="modal-backdrop">
      <div className="modal-card model-settings-dialog">
        <div className="modal-head">
          <strong>{t("Настройки модели")}</strong>
          <button className="icon-button" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <div className="model-settings-scroll">
          <div className="model-field-grid">
            <label>
              <span>{t("ID модели")}</span>
              <input
                value={id}
                onChange={(event) => setId(event.target.value)}
              />
            </label>
            <label>
              <span>{t("Название в интерфейсе")}</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t("Необязательно")}
              />
            </label>
            <label>
              <span>{t("Размер контекста")}</span>
              <input
                value={contextWindow}
                onChange={(event) => setContextWindow(event.target.value)}
                inputMode="numeric"
                placeholder={t("Автоматически")}
              />
            </label>
            <label>
              <span>{t("Максимум токенов ответа")}</span>
              <input
                value={maxTokens}
                onChange={(event) => setMaxTokens(event.target.value)}
                inputMode="numeric"
                placeholder={t("Автоматически")}
              />
            </label>
          </div>
          <div className="model-toggle-row">
            <label>
              <input
                type="checkbox"
                checked={reasoning}
                onChange={(event) => setReasoning(event.target.checked)}
              />{" "}{t("Модель поддерживает рассуждения")}</label>
            <label>
              <input
                type="checkbox"
                checked={vision}
                onChange={(event) => setVision(event.target.checked)}
              />{" "}{t("Модель принимает изображения")}</label>
          </div>
          <div
            className={`thinking-level-editor ${reasoning ? "" : "disabled"}`}
          >
            <strong>{t("Доступные уровни рассуждений")}</strong>
            <div>
              {(Object.keys(THINKING_LABELS) as ThinkingLevel[]).map(
                (level) => (
                  <label key={level}>
                    <input
                      type="checkbox"
                      disabled={!reasoning}
                      checked={levels.includes(level)}
                      onChange={() => toggleLevel(level)}
                    />
                    {t(THINKING_LABELS[level])}
                  </label>
                ),
              )}
            </div>
          </div>
          <label className="sampling-editor">
            <span>{t("Параметры семплирования, JSON")}</span>
            <textarea
              value={samplingParams}
              onChange={(event) => setSamplingParams(event.target.value)}
              spellCheck={false}
            />
          </label>
          {error && <div className="model-settings-error">{error}</div>}
        </div>
        <div className="modal-actions">
          <button onClick={onClose}>{t("Отмена")}</button>
          <button
            className="primary"
            disabled={saving || !id.trim()}
            onClick={() => void save()}
          >
            {saving ? t("Сохранение…") : t("Сохранить")}
          </button>
        </div>
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
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
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
  const [serverApiKeyChanged, setServerApiKeyChanged] = useState(false);
  const [serverDiscovering, setServerDiscovering] = useState(false);
  const [serverDiscoveryStatus, setServerDiscoveryStatus] = useState("");
  const [serverDiscoveryError, setServerDiscoveryError] = useState(false);
  const [editingServerId, setEditingServerId] = useState<string>();
  const [editingModel, setEditingModel] = useState<{
    providerId: string;
    model: ConfiguredModelInfo;
  }>();
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>();
  const [updatesLoading, setUpdatesLoading] = useState(false);
  const [updatingComponent, setUpdatingComponent] = useState<string>();
  const [updateMessage, setUpdateMessage] = useState("");
  const [updateError, setUpdateError] = useState(false);
  const [moduleSettings, setModuleSettings] = useState<ModuleSettings>();
  const [moduleSettingsLoading, setModuleSettingsLoading] = useState(false);
  const [moduleSettingsMessage, setModuleSettingsMessage] = useState("");
  const sections: Array<{
    id: SettingsSection;
    label: string;
    icon: typeof Settings;
  }> = [
    { id: "general", label: t("Общее"), icon: Settings },
    // Web access is paused: keep its implementation, but hide the settings entry.
    { id: "models", label: t("Модели"), icon: Cpu },
    { id: "comfyui", label: "ComfyUI", icon: Boxes },
    { id: "modules", label: t("Модули"), icon: Boxes },
    { id: "customization", label: t("Кастомизация"), icon: Pencil },
    { id: "configuration", label: t("Конфигурация Pi"), icon: FileText },
    { id: "shortcuts", label: t("Сочетания клавиш"), icon: Keyboard },
    { id: "archive", label: t("Архивированные чаты"), icon: Archive },
    { id: "about", label: t("О программе"), icon: Bot },
  ];
  const visibleSections = sections.filter((item) =>
    item.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const showDataFolder = () => {
    if (dataDir) void window.piDesktop.showItemInFolder(dataDir);
  };
  const showSessionsFolder = () => {
    if (sessionsDir) void window.piDesktop.showItemInFolder(sessionsDir);
  };
  const globalPromptPath = dataDir
    ? `${dataDir.replace(/[\\/]$/, "")}\\agent\\APPEND_SYSTEM.md`
    : "data\\agent\\APPEND_SYSTEM.md";
  const showGlobalPromptFile = () => {
    if (dataDir) void window.piDesktop.showItemInFolder(globalPromptPath);
  };

  useEffect(() => {
    if (section !== "customization" || globalPromptLoaded) return;
    let cancelled = false;
    setGlobalPromptLoading(true);
    setGlobalPromptStatus("");
    void window.piDesktop
      .getGlobalPrompt()
      .then((prompt) => {
        if (cancelled) return;
        setGlobalPrompt(prompt);
        setSavedGlobalPrompt(prompt);
        setGlobalPromptLoaded(true);
      })
      .catch((error) => {
        if (!cancelled)
          setGlobalPromptStatus(
            error instanceof Error ? error.message : String(error),
          );
      })
      .finally(() => {
        if (!cancelled) setGlobalPromptLoading(false);
      });
    return () => {
      cancelled = true;
    };
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
    if (section !== "modules" || moduleSettings || moduleSettingsLoading)
      return;
    setModuleSettingsLoading(true);
    void window.piDesktop
      .getModuleSettings()
      .then(setModuleSettings)
      .catch((error) =>
        setModuleSettingsMessage(
          error instanceof Error ? error.message : String(error),
        ),
      )
      .finally(() => setModuleSettingsLoading(false));
  }, [section, moduleSettings, moduleSettingsLoading]);

  const toggleBuiltinModule = async (
    id: ModuleSettings["builtins"][number]["id"],
    enabled: boolean,
  ) => {
    setModuleSettingsMessage("");
    try {
      setModuleSettings(
        await window.piDesktop.setBuiltinModuleEnabled(id, enabled),
      );
      setModuleSettingsMessage(
        t("Настройка сохранена. Открытые процессы Pi перезапущены; следующий запрос использует новый набор модулей."),
      );
    } catch (error) {
      setModuleSettingsMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const addUserExtension = async (kind: "file" | "directory") => {
    setModuleSettingsMessage("");
    try {
      const next = await window.piDesktop.addUserExtension(kind);
      if (next) {
        setModuleSettings(next);
        setModuleSettingsMessage(
          t("Пользовательское расширение добавлено. Оно загрузится при следующем запросе."),
        );
      }
    } catch (error) {
      setModuleSettingsMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const removeUserExtension = async (name: string) => {
    setModuleSettingsMessage("");
    try {
      const next = await window.piDesktop.removeUserExtension(name);
      if (next) {
        setModuleSettings(next);
        setModuleSettingsMessage(
          t("Пользовательское расширение удалено. Встроенные модули не затронуты."),
        );
      }
    } catch (error) {
      setModuleSettingsMessage(
        error instanceof Error ? error.message : String(error),
      );
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
        setUpdateMessage(
          t("Обновлено: {0}. Новые процессы Pi используют новые версии.", result.updated.join(", ")),
        );
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
      setGlobalPromptStatus(
        t("Сохранено. Все чаты применят правила перед следующим запросом."),
      );
    } catch (error) {
      setGlobalPromptStatus(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setGlobalPromptSaving(false);
    }
  };

  useEffect(() => {
    if (section !== "models" || modelServersLoaded) return;
    let cancelled = false;
    setModelServersLoading(true);
    void window.piDesktop
      .getModelServers()
      .then((servers) => {
        if (cancelled) return;
        setModelServers(servers);
        setModelServersLoaded(true);
        if (!serverAddress && servers[0]?.baseUrl) {
          try {
            const url = new URL(servers[0].baseUrl);
            const basePath = url.pathname.replace(/\/v1\/?$/i, "");
            setServerAddress(`${url.protocol}//${url.hostname}${basePath}`);
            setEditingServerId(servers[0].id);
            setServerApiKey(servers[0].apiKeyConfigured ? "********" : "");
            setServerApiKeyChanged(false);
            setServerPort(
              url.port || (url.protocol === "https:" ? "443" : "80"),
            );
          } catch {
            // Keep the fields empty when a legacy URL cannot be parsed.
          }
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setServerDiscoveryError(true);
          setServerDiscoveryStatus(
            error instanceof Error ? error.message : String(error),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setModelServersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [section, modelServersLoaded]);

  const discoverModelServer = async () => {
    setServerDiscovering(true);
    setServerDiscoveryStatus("");
    setServerDiscoveryError(false);
    try {
      const result = await window.piDesktop.discoverModelServer({
        address: serverAddress,
        port: serverPort,
        ...(serverApiKeyChanged ? { apiKey: serverApiKey.trim() } : {}),
        ...(editingServerId ? { providerId: editingServerId } : {}),
      });
      setModelServers((current) => [
        result.server,
        ...current.filter((server) => server.id !== result.server.id),
      ]);
      const changes = [
        result.addedModels ? t("добавлено моделей: {0}", result.addedModels) : "",
        result.updatedModels ? t("обновлено: {0}", result.updatedModels) : "",
      ]
        .filter(Boolean)
        .join(", ");
      setServerDiscoveryStatus(
        `${result.serverKind}${result.buildInfo ? ` ${result.buildInfo}` : ""}: ${changes || t("конфигурация актуальна")}.`,
      );
      setEditingServerId(result.server.id);
      setServerApiKey(result.server.apiKeyConfigured ? "********" : "");
      setServerApiKeyChanged(false);
    } catch (error) {
      setServerDiscoveryError(true);
      setServerDiscoveryStatus(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setServerDiscovering(false);
    }
  };

  useEffect(() => {
    if (section !== "models" || !modelServersLoaded) return;
    let cancelled = false;
    const refresh = () => { void window.piDesktop.getModelServers().then(servers => {
      if (!cancelled) setModelServers(servers);
    }).catch(() => undefined); };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => { cancelled = true; window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [section, modelServersLoaded]);

  const editModelServer = (server: ConfiguredModelServer) => {
    try {
      const url = new URL(server.baseUrl);
      const basePath = url.pathname.replace(/\/v1\/?$/i, "");
      setServerAddress(`${url.protocol}//${url.hostname}${basePath}`);
      setServerPort(url.port || (url.protocol === "https:" ? "443" : "80"));
      setServerApiKey(server.apiKeyConfigured ? "********" : "");
      setServerApiKeyChanged(false);
      setEditingServerId(server.id);
      setServerDiscoveryError(false);
      setServerDiscoveryStatus(
        t("Редактируется сервер «{0}». Укажите новый адрес и выполните автонастройку.", server.id),
      );
      requestAnimationFrame(() =>
        document
          .querySelector(".server-discovery-card")
          ?.scrollIntoView({ behavior: "smooth", block: "center" }),
      );
    } catch (error) {
      setServerDiscoveryError(true);
      setServerDiscoveryStatus(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const cancelServerEdit = () => {
    setEditingServerId(undefined);
    setServerApiKey("");
    setServerApiKeyChanged(false);
    setServerDiscoveryStatus("");
    setServerDiscoveryError(false);
  };

  const deleteModelServer = async (providerId: string) => {
    try {
      const deleted = await window.piDesktop.deleteModelServer(providerId);
      if (!deleted) return;
      setModelServers((current) =>
        current.filter((server) => server.id !== providerId),
      );
      if (editingServerId === providerId) cancelServerEdit();
    } catch (error) {
      setServerDiscoveryError(true);
      setServerDiscoveryStatus(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const saveConfiguredModel = async (input: ConfiguredModelUpdate) => {
    const updated = await window.piDesktop.updateConfiguredModel(input);
    setModelServers((current) =>
      current.map((server) => (server.id === updated.id ? updated : server)),
    );
  };

  const deleteConfiguredModel = async (providerId: string, modelId: string) => {
    try {
      const updated = await window.piDesktop.deleteConfiguredModel(
        providerId,
        modelId,
      );
      if (updated)
        setModelServers((current) =>
          current.map((server) =>
            server.id === updated.id ? updated : server,
          ),
        );
    } catch (error) {
      setServerDiscoveryError(true);
      setServerDiscoveryStatus(
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  return (
    <div className="settings-page">
      <aside className="settings-sidebar">
        <button className="settings-back" onClick={onBack}>
          <ArrowLeft size={15} />{t(" Вернуться в приложение")}</button>
        <div className="settings-search">
          <Search size={14} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("Поиск настроек…")}
          />
        </div>
        <div className="settings-group-title">{t("Настройки Pi Desktop")}</div>
        <nav className="settings-nav">
          {visibleSections.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={section === item.id ? "selected" : ""}
                onClick={() => onSectionChange(item.id)}
              >
                <Icon size={15} />
                {item.label}
              </button>
            );
          })}
        </nav>
      </aside>
      <main className="settings-content">
        <div className="settings-inner">
          {section === "comfyui" && <ComfySettingsPanel />}
          {section === "web-access" && <WebAccessSettingsPanel />}
          {section === "general" && (
            <>
              <h1>{t("Общее")}</h1>
              <LanguageSettings />
              <NotebookSettings />
              <h2>{t("Портативность")}</h2>
              <div className="settings-card">
                <SettingRow
                  title={t("Папка данных приложения")}
                  description={t("Здесь находятся список проектов, настройки интерфейса и портативная конфигурация Pi.")}
                  value={dataDir}
                  action={{ label: t("Показать"), onClick: showDataFolder }}
                />
                <SettingRow
                  title={t("История сессий Pi")}
                  description={t("Переносимое хранилище сессий в исходном формате Pi.")}
                  value={sessionsDir}
                  action={{ label: t("Показать"), onClick: showSessionsFolder }}
                />
                <SettingRow
                  title={t("Обновления приложения и дополнений")}
                  description={t("Pi обновляется вместе с приложением. Обновления дополнений доступны во вкладке «Модули».")}
                  value={t("Только вручную")}
                />
                <SettingRow
                  title={t("Таймаут запроса")}
                  description={t("Максимальное ожидание ответа модели и RPC-команд.")}
                  value={t("24 часа")}
                />
              </div>
              <h2>{t("Доступ")}</h2>
              <div className="settings-card">
                <SettingRow
                  title={t("Режим Pi")}
                  description={t("Pi запущен с разрешением на штатные инструменты и подтверждённые расширения.")}
                  value={t("Полный доступ")}
                />
                <SettingRow
                  title={t("Хранение")}
                  description={t("История хранится локально в исходном формате сессий Pi.")}
                  value={t("Локальные сессии")}
                />
              </div>
            </>
          )}
          {section === "models" && (
            <>
              <h1>{t("Модели")}</h1>
              <h2>{t("Текущий чат")}</h2>
              <div className="settings-card">
                <SettingRow
                  title={t("Активная модель")}
                  description={t("Модель меняется непосредственно в нижней панели чата.")}
                  value={
                    currentModel?.name ?? currentModel?.id ?? t("Чат не открыт")
                  }
                />
                <SettingRow
                  title={t("Доступные уровни рассуждений")}
                  description={t("Набор зависит от выбранной модели.")}
                  value={
                    thinkingLevels.length
                      ? thinkingLevels
                          .map((level) => t(THINKING_LABELS[level]))
                          .join(", ")
                      : t("Чат не открыт")
                  }
                />
              </div>
              <h2>{t("Добавить сервер автоматически")}</h2>
              <div className="settings-card server-discovery-card">
                <div className="server-fields">
                  <label className="server-address-field">
                    <span>{t("Адрес сервера")}</span>
                    <input
                      value={serverAddress}
                      onChange={(event) => setServerAddress(event.target.value)}
                      placeholder={t("192.168.31.194 или http://localhost")}
                    />
                  </label>
                  <label className="server-port-field">
                    <span>{t("Порт")}</span>
                    <input
                      value={serverPort}
                      onChange={(event) => setServerPort(event.target.value)}
                      inputMode="numeric"
                      placeholder="1234"
                    />
                  </label>
                  <label className="server-key-field">
                    <span>{t("API-ключ, если требуется")}</span>
                    <input
                      type="password"
                      value={serverApiKey}
                      autoComplete="off"
                      onFocus={(event) => { if (!serverApiKeyChanged) event.currentTarget.select(); }}
                      onChange={(event) => { setServerApiKey(event.target.value); setServerApiKeyChanged(true); }}
                      placeholder={t("Необязательно")}
                    />
                  </label>
                </div>
                <div className="server-discovery-footer">
                  <div>
                    <span>{t("Проверяются только служебные endpoints `/v1/models`, `/props` и `/health`.")}</span>
                    <small>{t("Список моделей обновляется автоматически. Исчезнувшие с сервера модели удаляются из списка.")}</small>
                    {serverDiscoveryStatus && (
                      <strong className={serverDiscoveryError ? "error" : ""}>
                        {serverDiscoveryStatus}
                      </strong>
                    )}
                  </div>
                  <div className="server-discovery-actions">
                    {editingServerId && (
                      <button onClick={cancelServerEdit}>{t("Отмена")}</button>
                    )}
                    <button
                      className="primary"
                      disabled={
                        !serverAddress.trim() ||
                        !serverPort.trim() ||
                        serverDiscovering
                      }
                      onClick={() => void discoverModelServer()}
                    >
                      {serverDiscovering
                        ? t("Подключение…")
                        : editingServerId
                          ? t("Обновить автоматически")
                          : t("Добавить автоматически")}
                    </button>
                  </div>
                </div>
              </div>
              <h2>{t("Настроенные серверы")}</h2>
              <div className="configured-servers">
                {modelServersLoading ? (
                  <div className="settings-card settings-empty">{t("Загрузка конфигурации…")}</div>
                ) : modelServers.length ? (
                  modelServers.map((server) => (
                    <div
                      className="settings-card configured-server"
                      key={server.id}
                    >
                      <div className="configured-server-head">
                        <div>
                          <strong>{server.id}</strong>
                          <span>{server.baseUrl}</span>
                          <small>
                            {server.api} · {server.models.length}{" "}
                            {pluralModels(server.models.length)}
                          </small>
                        </div>
                        <div className="configured-server-actions">
                          <button onClick={() => editModelServer(server)}>
                            <Pencil size={13} />{t(" Изменить")}</button>
                          <button
                            className="danger"
                            onClick={() => void deleteModelServer(server.id)}
                          >
                            <Trash2 size={13} />{t(" Удалить")}</button>
                        </div>
                      </div>
                      <div className="configured-model-list">
                        {server.models.map((model) => (
                          <div className="configured-model" key={model.id}>
                            <div>
                              <strong>{model.name ?? model.id}</strong>
                              <span>{model.id}</span>
                            </div>
                            <p>
                              {model.contextWindow
                                ? t("Контекст {0}", model.contextWindow.toLocaleString(getLocale()))
                                : t("Контекст не указан")}
                              {model.maxTokens
                                ? t(" · ответ до {0}", model.maxTokens.toLocaleString(getLocale()))
                                : ""}
                              {model.reasoning
                                ? t(" · рассуждения: {0}", model.thinkingLevels.map((level) => t(THINKING_LABELS[level])).join(", "))
                                : t(" · без рассуждений")}
                              {model.input.length > 1
                                ? t(" · вход: {0}", model.input.join(", "))
                                : ""}
                            </p>
                            {model.samplingParams && (
                              <small>
                                {Object.entries(model.samplingParams)
                                  .map(([key, value]) => `${key}=${value}`)
                                  .join(" · ")}
                              </small>
                            )}
                            <div className="configured-model-actions">
                              <button
                                onClick={() =>
                                  setEditingModel({
                                    providerId: server.id,
                                    model,
                                  })
                                }
                              >
                                <Pencil size={12} />{t(" Изменить")}</button>
                              <button
                                className="danger"
                                onClick={() =>
                                  void deleteConfiguredModel(
                                    server.id,
                                    model.id,
                                  )
                                }
                              >
                                <Trash2 size={12} />{t(" Удалить")}</button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="settings-card settings-empty">{t("Настроенных локальных серверов пока нет.")}</div>
                )}
              </div>
              <h2>{t("Доступные модели")}</h2>
              <div className="settings-card model-settings-list">
                {models.length ? (
                  models.map((model) => (
                    <SettingRow
                      key={`${model.provider}/${model.id}`}
                      title={model.name ?? model.id}
                      description={t("{0} · контекст {1}", model.provider, model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k` : t("не указан"))}
                      value={model.reasoning ? t("Рассуждения") : t("Обычная")}
                    />
                  ))
                ) : (
                  <div className="settings-empty">{t("Откройте чат, чтобы Pi загрузил список моделей.")}</div>
                )}
              </div>
            </>
          )}
          {section === "modules" && (
            <>
              <h1>{t("Модули")}</h1>
              <p className="settings-lead">{t("Встроенные функции хранятся внутри Pi Desktop. Пользовательская папка содержит только дополнения, которые добавил пользователь.")}</p>
              <h2>{t("Встроенные модули")}</h2>
              <div className="settings-card builtin-module-list">
                {moduleSettings?.builtins.length ? (
                  moduleSettings.builtins.map((module) => {
                    const dependency =
                      module.dependsOn &&
                      moduleSettings.builtins.find(
                        (item) => item.id === module.dependsOn,
                      );
                    const dependencyDisabled = Boolean(
                      dependency && !dependency.enabled,
                    );
                    return (
                      <label
                        className={`builtin-module-row${dependencyDisabled ? " dependency-disabled" : ""}`}
                        key={module.id}
                      >
                        <span>
                          <strong>{module.name}</strong>
                          <small>
                            {t(module.description)}
                            {dependency
                              ? t(" · зависит от {0}", dependency.name)
                              : ""}
                          </small>
                        </span>
                        <input
                          type="checkbox"
                          checked={module.enabled}
                          disabled={dependencyDisabled}
                          onChange={(event) =>
                            void toggleBuiltinModule(
                              module.id,
                              event.target.checked,
                            )
                          }
                        />
                      </label>
                    );
                  })
                ) : (
                  <div className="settings-empty">
                    {moduleSettingsLoading
                      ? t("Загрузка модулей…")
                      : t("Не удалось получить список модулей.")}
                  </div>
                )}
              </div>
              <h2>{t("Пользовательские дополнения")}</h2>
              <div className="module-update-toolbar user-extension-toolbar">
                <div>
                  <strong>{t("Папка расширений Pi")}</strong>
                  <span>
                    {moduleSettings?.userExtensionsDir ?? t("Загрузка…")}
                  </span>
                </div>
                {moduleSettings && (
                  <button
                    onClick={() =>
                      void window.piDesktop.showItemInFolder(
                        moduleSettings.userExtensionsDir,
                      )
                    }
                  >
                    <FolderOpen size={13} />{t(" Открыть")}</button>
                )}
                <button onClick={() => void addUserExtension("file")}>
                  <Plus size={13} />{t(" Добавить файл")}</button>
                <button onClick={() => void addUserExtension("directory")}>
                  <Plus size={13} />{t(" Добавить папку")}</button>
              </div>
              <div className="settings-card user-extension-list">
                {moduleSettings?.userExtensions.length ? (
                  moduleSettings.userExtensions.map((extension) => (
                    <div className="user-extension-row" key={extension.name}>
                      <span>
                        <strong>{extension.name}</strong>
                        <small>{extension.path}</small>
                      </span>
                      <button
                        className="danger"
                        onClick={() => void removeUserExtension(extension.name)}
                      >
                        <Trash2 size={13} />{t(" Удалить")}</button>
                    </div>
                  ))
                ) : (
                  <div className="settings-empty">{t("Пользовательских дополнений пока нет. Встроенные модули находятся отдельно.")}</div>
                )}
              </div>
              {moduleSettingsMessage && (
                <div className="module-update-notice success">
                  {moduleSettingsMessage}
                </div>
              )}
              <h2>Pi Engine</h2>
              <div className="settings-card">
                <SettingRow
                  title={t("Версия встроенного движка")}
                  description={t("Встроенное ядро. Обновляется вместе с приложением.")}
                  value={import.meta.env.VITE_PI_ENGINE_VERSION}
                />
              </div>
              <h2>{t("Обновления дополнений")}</h2>
              <div className="module-update-toolbar">
                <div>
                  <strong>{t("Установленные дополнения")}</strong>
                  <span>
                    {updateStatus?.checkedAt
                      ? t("Проверено {0}", new Date(updateStatus.checkedAt).toLocaleString(getLocale()))
                      : t("Обновления ещё не проверялись")}
                  </span>
                </div>
                <button
                  disabled={updatesLoading || Boolean(updatingComponent)}
                  onClick={() => void loadUpdateStatus(true)}
                >
                  <RefreshCw
                    size={13}
                    className={updatesLoading ? "spinning" : ""}
                  />
                  {updatesLoading ? t("Проверка…") : t("Проверить")}
                </button>
                <button
                  className="primary"
                  disabled={
                    updatesLoading ||
                    Boolean(updatingComponent) ||
                    !updateStatus?.components.some(
                      (item) => item.updateable && item.updateAvailable,
                    )
                  }
                  onClick={() => void installUpdate()}
                >
                  {updatingComponent === "all" ? t("Обновление…") : t("Обновить всё")}
                </button>
              </div>
              <div className="settings-card module-update-list">
                {updateStatus?.components.length ? (
                  updateStatus.components.filter((component) => component.id !== "pi-core").map((component) => (
                    <div className="module-update-row" key={component.id}>
                      <div>
                        <strong>{component.name}</strong>
                        <p>{t(component.description)}</p>
                        {component.error && (
                          <small className="error">{t("Не удалось проверить:")}{component.error}
                          </small>
                        )}
                      </div>
                      <div className="module-update-control">
                        <span>
                          {component.source === "local"
                            ? t("Локальный")
                            : component.latestVersion &&
                                component.currentVersion !==
                                  component.latestVersion
                              ? `${component.currentVersion ?? "?"} → ${component.latestVersion}`
                              : (component.currentVersion ??
                                t("Версия неизвестна"))}
                        </span>
                        {component.updateAvailable && component.updateable ? (
                          <button
                            disabled={Boolean(updatingComponent)}
                            onClick={() =>
                              void installUpdate(
                                component.id as UpdateComponentId,
                              )
                            }
                          >
                            {updatingComponent === component.id
                              ? t("Обновление…")
                              : t("Обновить")}
                          </button>
                        ) : (
                          <em>
                            {component.source === "local"
                              ? t("Защищён")
                              : component.error
                                ? t("Нет данных")
                                : t("Актуально")}
                          </em>
                        )}
                      </div>
                    </div>
                  ))
                ) : (
                  <div className="settings-empty">
                    {updatesLoading
                      ? t("Проверка npm…")
                      : t("Нет данных об обновлениях.")}
                  </div>
                )}
              </div>
              {!updateStatus?.npmAvailable && updateStatus && (
                <div className="module-update-notice error">{t("npm не найден. Проверка версий работает, но установка обновлений требует Node.js/npm в PATH.")}</div>
              )}
              {updateMessage && (
                <div
                  className={`module-update-notice ${updateError ? "error" : "success"}`}
                >
                  {updateMessage}
                </div>
              )}
              <h2>{t("Состояние расширений текущего чата")}</h2>
              <div className="settings-card module-list">
                {extensionState?.extensionPaths.length ? (
                  extensionState.extensionPaths.map((extensionPath) => {
                    const name = extensionName(extensionPath);
                    const normalizedName = `/${name}/`;
                    const tools = extensionState.tools.filter((tool) =>
                      tool.source?.replace(/\\/g, "/").includes(normalizedName),
                    );
                    const activeTools = tools.filter(
                      (tool) => tool.active,
                    ).length;
                    const errors = extensionState.errors.filter((error) =>
                      error.extensionPath
                        ?.replace(/\\/g, "/")
                        .includes(normalizedName),
                    );
                    return (
                      <SettingRow
                        key={extensionPath}
                        title={name}
                        description={`${extensionPath}${tools.length ? t(" · инструменты {0}/{1}", activeTools, tools.length) : ""}${errors.length ? t(" · ошибок {0}", errors.length) : ""}`}
                        value={errors.length ? t("Есть ошибки") : t("Загружен")}
                      />
                    );
                  })
                ) : (
                  <div className="settings-empty">{t("Откройте чат, чтобы получить состояние расширений непосредственно из Pi.")}</div>
                )}
              </div>
              {extensionState && (
                <>
                  <h2>{t("Инструменты")}</h2>
                  <div className="settings-card module-list">
                    <SettingRow
                      title={t("Активные инструменты")}
                      description={t("Именно этот набор сейчас передаётся модели.")}
                      value={t("{0} из {1}", extensionState.activeTools.length, extensionState.tools.length)}
                    />
                    {extensionState.errors.map((error, index) => (
                      <SettingRow
                        key={`${error.extensionPath}-${index}`}
                        title={t("Ошибка расширения")}
                        description={`${error.extensionPath ?? t("Неизвестный модуль")}: ${error.error}`}
                        value={error.event ?? "runtime"}
                      />
                    ))}
                  </div>
                  <details className="module-tools-details">
                    <summary>{t("Показать активные инструменты")}</summary>
                    <div>
                      {extensionState.activeTools.map((tool) => (
                        <code key={tool}>{tool}</code>
                      ))}
                    </div>
                  </details>
                </>
              )}
            </>
          )}
          {section === "customization" && (
            <>
              <h1>{t("Кастомизация")}</h1>
              <p className="settings-lead">{t("Глобальные пользовательские инструкции, которые Pi добавляет к своему стандартному системному промпту во всех проектах.")}</p>
              <h2>{t("Глобальный пользовательский промпт")}</h2>
              <div className="settings-card prompt-editor-card">
                <textarea
                  value={globalPrompt}
                  onChange={(event) => {
                    setGlobalPrompt(event.target.value);
                    setGlobalPromptStatus("");
                  }}
                  onKeyDown={(event) => {
                    if (
                      (event.ctrlKey || event.metaKey) &&
                      event.key.toLocaleLowerCase() === "s"
                    ) {
                      event.preventDefault();
                      if (!globalPromptSaving) void saveGlobalPrompt();
                    }
                  }}
                  disabled={globalPromptLoading}
                  placeholder={
                    globalPromptLoading
                      ? t("Загрузка…")
                      : t("Введите общие правила поведения для Pi…")
                  }
                  spellCheck
                />
                <div className="prompt-editor-footer">
                  <div className="prompt-editor-info">
                    <span title={globalPromptPath}>
                      {globalPromptPath} · UTF-8
                    </span>
                    <small>{t("Открытые чаты перечитают правила перед следующим запросом.")}</small>
                    {globalPromptStatus && (
                      <strong>{globalPromptStatus}</strong>
                    )}
                  </div>
                  <div className="prompt-editor-buttons">
                    <button disabled={!dataDir} onClick={showGlobalPromptFile}>
                      <FolderOpen size={13} />{t(" Открыть файл")}</button>
                    <button
                      className="primary"
                      disabled={
                        globalPromptLoading ||
                        globalPromptSaving ||
                        globalPrompt === savedGlobalPrompt
                      }
                      onClick={() => void saveGlobalPrompt()}
                    >
                      {globalPromptSaving ? t("Сохранение…") : t("Сохранить")}
                    </button>
                  </div>
                </div>
              </div>
            </>
          )}
          {section === "configuration" && (
            <>
              <h1>{t("Конфигурация Pi")}</h1>
              <div className="settings-card">
                <SettingRow
                  title={t("Модели")}
                  description={t("Конфигурация провайдеров и локальных моделей.")}
                  value="data\\agent\\models.json"
                  action={{ label: t("Показать"), onClick: showDataFolder }}
                />
                <SettingRow
                  title="MCP"
                  description={t("Подключения Godot AI и управления компьютером.")}
                  value="data\\agent\\mcp.json"
                  action={{ label: t("Показать"), onClick: showDataFolder }}
                />
                <SettingRow
                  title={t("Глобальный промпт")}
                  description={t("Общие правила поведения моделей во всех проектах.")}
                  value={globalPromptPath}
                  action={{ label: t("Показать"), onClick: showGlobalPromptFile }}
                />
                <SettingRow
                  title={t("Настройки ядра")}
                  description={t("Параметры Pi, модулей, таймаутов и инструментов.")}
                  value="data\\agent\\settings.json"
                  action={{ label: t("Показать"), onClick: showDataFolder }}
                />
              </div>
            </>
          )}
          {section === "about" && (
            <>
              <h1>{t("О программе")}</h1>
              <div className="settings-card">
                <SettingRow
                  title="Pi Desktop"
                  description={t("Самостоятельное приложение на основе Pi.")}
                  value="0.1.0"
                />
                <SettingRow
                  title="Pi Engine"
                  description={t("Встроенное ядро. Обновляется вместе с приложением.")}
                  value={import.meta.env.VITE_PI_ENGINE_VERSION}
                />
                <SettingRow
                  title={t("Интерфейс расширений")}
                  description={t("Инструменты, статусы, уведомления и диалоги работают через RPC.")}
                  value={t("Активен")}
                />
              </div>
            </>
          )}
          {section === "shortcuts" && (
            <>
              <h1>{t("Сочетания клавиш")}</h1>
              <div className="settings-card">
                <SettingRow
                  title={t("Новый самостоятельный чат")}
                  description={t("Создать чат без привязки к проекту.")}
                  value="Ctrl+N"
                />
                <SettingRow
                  title={t("Настройки")}
                  description={t("Открыть настройки Pi Desktop.")}
                  value="Ctrl+,"
                />
                <SettingRow
                  title={t("Команды Pi")}
                  description={t("Открыть палитру встроенных действий и команд расширений.")}
                  value="Ctrl+Shift+P"
                />
                <SettingRow
                  title={t("Боковая панель")}
                  description={t("Показать или скрыть проекты и чаты.")}
                  value="Ctrl+B"
                />
                <SettingRow
                  title={t("Отправить сообщение")}
                  description={t("Обычная отправка; во время работы сообщение встанет в очередь.")}
                  value="Enter"
                />
                <SettingRow
                  title={t("Отправить в текущую работу")}
                  description={t("Во время работы немедленно передать корректировку модели.")}
                  value="Ctrl+Enter"
                />
              </div>
            </>
          )}
          {section === "archive" && (
            <>
              <h1>{t("Архивированные чаты")}</h1>
              <p className="settings-lead">{t("Архив скрывает чат, но сохраняет исходную сессию Pi.")}</p>
              <div className="settings-card archived-chat-list">
                {archivedConversations.map((conversation) => (
                  <div className="archived-chat-row" key={conversation.id}>
                    <div>
                      <strong>{conversationTitle(conversation)}</strong>
                      <p>
                        {conversation.projectId
                          ? (projects.find(
                              (project) =>
                                project.id === conversation.projectId,
                            )?.name ?? t("Проект"))
                          : t("Самостоятельный чат")}
                      </p>
                    </div>
                    <div className="archived-chat-actions">
                      <button
                        onClick={() => onRestoreConversation(conversation.id)}
                      >
                        <ArchiveRestore size={14} />{t(" Восстановить")}</button>
                      <button
                        className="danger"
                        onClick={() => onDeleteConversation(conversation.id)}
                      >
                        <Trash2 size={14} />{t(" Удалить")}</button>
                    </div>
                  </div>
                ))}
                {!archivedConversations.length && (
                  <div className="settings-empty">{t("Архив пуст.")}</div>
                )}
              </div>
            </>
          )}
        </div>
      </main>
      {editingModel && (
        <ModelSettingsDialog
          providerId={editingModel.providerId}
          model={editingModel.model}
          onClose={() => setEditingModel(undefined)}
          onSave={saveConfiguredModel}
        />
      )}
    </div>
  );
}

export default function App() {
  useLanguage();
  const [bootstrap, setBootstrap] = useState<BootstrapPayload | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [notebookOpen, setNotebookOpen] = useState(false);
  const [planningOpen, setPlanningOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [archivedConversations, setArchivedConversations] = useState<
    ConversationRecord[]
  >([]);
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const [activeConversationId, setActiveConversationId] = useState<string>();
  const [snapshot, setSnapshot] = useState<ConversationSnapshot>();
  const [messages, setMessages] = useState<JsonObject[]>([]);
  const [streamingMessage, setStreamingMessage] = useState<JsonObject | null>(
    null,
  );
  const [tools, setTools] = useState<Record<string, ToolActivity>>({});
  const [working, setWorking] = useState(false);
  const [pendingRequests, setPendingRequests] = useState<Record<string, true>>({});
  const pendingRequestIdsRef = useRef(new Set<string>());
  const requestPending = Boolean(activeConversationId && pendingRequests[activeConversationId]);
  const [startedAt, setStartedAt] = useState<number>();
  const [elapsed, setElapsed] = useState(0);
  const [lastDuration, setLastDuration] = useState<number>();
  const [runDiff, setRunDiff] = useState<RunDiff>();
  const [diffOpen, setDiffOpen] = useState(false);
  const [input, setInput] = useState("");
  const [historyQuotes, setHistoryQuotes] = useState<string[]>([]);
  const [historyMenu, setHistoryMenu] = useState<{ text: string; x: number; y: number }>();
  const [historyAction, setHistoryAction] = useState<{ conversationId: string; entryId: string; mode: "edit" | "rewind"; text: string }>();
  const [historyBusy, setHistoryBusy] = useState(false);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setHistoryQuotes([]);
    setHistoryMenu(undefined);
    setHistoryAction(undefined);
  }, [activeConversationId]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [maskTarget, setMaskTarget] = useState<Attachment | null>(null);
  useEffect(() => setMaskTarget(null), [activeConversationId]);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const fileDragDepthRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [thinkingMenuOpen, setThinkingMenuOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [goalMode, setGoalMode] = useState(false);
  const planning = snapshot?.conversation.planning;
  const planMode = isPlanning(planning);
  useEffect(() => {
    setPlanningOpen(isPlanning(planning));
    if (isPlanning(planning)) { setNotebookOpen(false); setSkillsOpen(false); }
  }, [activeConversationId, planning?.phase]);
  const [search, setSearch] = useState("");
  const [searchMatches, setSearchMatches] = useState<Set<string>>();
  const [extensionDialog, setExtensionDialog] = useState<{
    conversationId: string;
    request: ExtensionUiRequest;
  }>();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [workingMessage, setWorkingMessage] = useState("");
  const [, setWorkingVisible] = useState(true);
  const [workingIndicator, setWorkingIndicator] = useState<{
    frames?: string[];
    intervalMs?: number;
  }>();
  const [hiddenThinkingLabel, setHiddenThinkingLabel] = useState("");
  const [widgets, setWidgets] = useState<ExtensionWidgetState[]>([]);
  const [headerLines, setHeaderLines] = useState<string[]>([]);
  const [footerLines, setFooterLines] = useState<string[]>([]);
  const [steeringMessages, setSteeringMessages] = useState<string[]>([]);
  const [followUpMessages, setFollowUpMessages] = useState<string[]>([]);
  const [queuedPrompts, setQueuedPrompts] = useState<QueuedPrompt[]>([]);
  const [queuedActionId, setQueuedActionId] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("general");
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [compactDialogOpen, setCompactDialogOpen] = useState(false);
  const [conversationMenu, setConversationMenu] =
    useState<ConversationMenuState>();
  const [projectMenu, setProjectMenu] = useState<ProjectMenuState>();
  const [renameConversation, setRenameConversation] =
    useState<ConversationRecord>();
  const [renameProject, setRenameProject] = useState<ProjectRecord>();
  const [instructionsProject, setInstructionsProject] =
    useState<ProjectRecord>();
  const conversationScrollRef = useRef<HTMLDivElement>(null);
  const conversationThreadRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const userScrollInteractionRef = useRef(false);
  const glideFrameRef = useRef(0);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const activeIdRef = useRef<string | undefined>(undefined);
  const historyRecoveryRef = useRef<string | undefined>(undefined);
  const conversationsRef = useRef<ConversationRecord[]>([]);
  const startedAtRef = useRef<number | undefined>(undefined);
  const editorSyncRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const searchSequenceRef = useRef(0);
  const navigationSequenceRef = useRef(0);
  const queuedActionRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    activeIdRef.current = activeConversationId;
    setGoalMode(false);
    setAddMenuOpen(false);
  }, [activeConversationId]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    if (!activeConversationId) return;
    clearTimeout(editorSyncRef.current);
    editorSyncRef.current = setTimeout(() => {
      void window.piDesktop
        .setHostEditorText(activeConversationId, input)
        .catch(() => undefined);
    }, 180);
    return () => clearTimeout(editorSyncRef.current);
  }, [activeConversationId, input]);

  const addNotice = useCallback(
    (message: string, type: Notice["type"] = "info") => {
      const notice = { id: crypto.randomUUID(), message, type };
      setNotices((current) => [...current, notice]);
      setTimeout(
        () =>
          setNotices((current) =>
            current.filter((item) => item.id !== notice.id),
          ),
        5_000,
      );
    },
    [],
  );

  useEffect(() => {
    const query = search.trim();
    const sequence = ++searchSequenceRef.current;
    if (!query) {
      setSearchMatches(undefined);
      return;
    }
    const timer = setTimeout(() => {
      void window.piDesktop
        .searchConversations(query)
        .then((ids) => {
          if (searchSequenceRef.current === sequence)
            setSearchMatches(new Set(ids));
        })
        .catch((error) =>
          addNotice(
            error instanceof Error ? error.message : String(error),
            "error",
          ),
        );
    }, 250);
    return () => clearTimeout(timer);
  }, [search, addNotice]);

  useEffect(() => {
    let disposed = false;
    let cancelPaint = () => {};
    void window.piDesktop
      .bootstrap()
      .then((payload) => {
        if (disposed) return;
        setLanguage(payload.interfaceLanguage);
        setBootstrap(payload);
        setProjects(payload.projects);
        setConversations(payload.conversations);
        setArchivedConversations(payload.archivedConversations);
        setActiveProjectId(payload.activeProjectId);
        setActiveConversationId(payload.activeConversationId);
        setLoading(false);
        const navigation = navigationSequenceRef.current;
        cancelPaint = afterFirstPaint(() => {
          if (disposed) return;
          if (!window.piDesktop.webClient) window.piDesktop.rendererReady();
          if (payload.activeConversationId && navigationSequenceRef.current === navigation)
            void openConversation(payload.activeConversationId);
        });
      })
      .catch((error) => {
        if (disposed) return;
        setLoading(false);
        addNotice(String(error), "error");
      });
    return () => { disposed = true; cancelPaint(); };
  }, [addNotice]);

  useEffect(
    () =>
      window.piDesktop.onConversationChanged((conversation) => {
        setConversations((current) => {
          const found = current.some((item) => item.id === conversation.id);
          return found
            ? current.map((item) =>
                item.id === conversation.id ? conversation : item,
              )
            : [conversation, ...current];
        });
        setSnapshot((current) =>
          current?.conversation.id === conversation.id
            ? { ...current, conversation }
            : current,
        );
      }),
    [],
  );

  useEffect(() => {
    if (!bootstrap) return;
    const refresh = () => { void window.piDesktop.getModelServers().catch(() => undefined); };
    refresh();
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [Boolean(bootstrap)]);

  useEffect(() => window.piDesktop.onControlSelect(async ({ requestId, snapshot: selected }) => {
    setSettingsOpen(false);
    setConversations((current) => [selected.conversation, ...current.filter((item) => item.id !== selected.conversation.id)]);
    const sequence = navigationSequenceRef.current + 1;
    await openConversation(selected.conversation.id);
    if (navigationSequenceRef.current !== sequence) return;
    // Set the ref before acknowledging: model events can arrive immediately.
    activeIdRef.current = selected.conversation.id;
    window.piDesktop.controlSelectionReady(requestId);
  }), []);

  useEffect(
    () =>
      window.piDesktop.onPiEvent(({ conversationId, event }) => {
        if (conversationId !== activeIdRef.current) {
          if (event.type === "agent_settled") {
            const title =
              conversationsRef.current.find(
                (item) => item.id === conversationId,
              )?.title ?? t("Фоновый чат");
            addNotice(t("Задача завершена: {0}", title));
          }
          return;
        }
        handlePiEvent(event);
      }),
    [addNotice],
  );

  useEffect(
    () =>
      window.piDesktop.onExtensionUi(({ conversationId, request }) => {
        if (request.method === "notify") {
          addNotice(
            request.message ?? t("Уведомление расширения"),
            request.notifyType ?? "info",
          );
          return;
        }
        if (conversationId !== activeIdRef.current) {
          if (
            ["select", "confirm", "input", "editor", "custom"].includes(
              request.method,
            )
          ) {
            const title =
              conversationsRef.current.find(
                (item) => item.id === conversationId,
              )?.title ?? t("Фоновый чат");
            addNotice(
              t("Расширение ожидает действие в чате «{0}»", title),
              "warning",
            );
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
            const next = current.filter(
              (widget) => widget.key !== request.widgetKey,
            );
            if (request.widgetLines)
              next.push({
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
        if (
          ["select", "confirm", "input", "editor", "custom"].includes(
            request.method,
          )
        ) {
          setExtensionDialog({ conversationId, request });
          return;
        }
        if (request.method === "customClose") {
          setExtensionDialog((current) =>
            current?.request.id === request.id ? undefined : current,
          );
        }
      }),
    [addNotice],
  );

  useEffect(() => {
    if (!working || !startedAt) return;
    const update = () => setElapsed(Date.now() - startedAt);
    update();
    const timer = setInterval(update, 1_000);
    return () => clearInterval(timer);
  }, [working, startedAt]);

  const stopConversationGlide = useCallback(() => {
    if (!glideFrameRef.current) return;
    cancelAnimationFrame(glideFrameRef.current);
    glideFrameRef.current = 0;
  }, []);

  const syncScrollToBottomHint = useCallback(() => {
    const element = conversationScrollRef.current;
    if (!element) {
      setShowScrollToBottom(false);
      return;
    }
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    setShowScrollToBottom(
      element.scrollHeight - element.clientHeight > SCROLL_HINT_THRESHOLD_PX &&
        distanceFromBottom > SCROLL_HINT_THRESHOLD_PX,
    );
  }, []);

  const scrollConversationToBottom = useCallback(() => {
    // Пока идёт glide, позиция принадлежит анимации: мгновенный скачок из
    // автопрокрутки или от ResizeObserver сбивал бы её на середине.
    if (glideFrameRef.current) return;
    const element = conversationScrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, []);

  // Плавный спуск в конец. Цель пересчитывается каждый кадр: виртуальный
  // список оценивает невидимые строки в 120 px, поэтому за время анимации
  // scrollHeight ещё меняется, и к концу нужно доехать по актуальной высоте.
  const scrollConversationToBottomSmooth = useCallback(() => {
    stopConversationGlide();
    const element = conversationScrollRef.current;
    if (!element) return;
    const start = element.scrollTop;
    const distance =
      element.scrollHeight - element.clientHeight - start;
    autoScrollRef.current = true;
    setShowScrollToBottom(false);
    if (distance <= SCROLL_HINT_THRESHOLD_PX) {
      element.scrollTop = element.scrollHeight;
      return;
    }
    const startedAt = performance.now();
    const stepFrame = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / SCROLL_GLIDE_MS);
      const eased = 1 - Math.pow(1 - progress, 3);
      const goal = element.scrollHeight - element.clientHeight;
      element.scrollTop = start + (goal - start) * eased;
      if (progress < 1) {
        glideFrameRef.current = requestAnimationFrame(stepFrame);
        return;
      }
      glideFrameRef.current = 0;
      element.scrollTop = element.scrollHeight;
    };
    glideFrameRef.current = requestAnimationFrame(stepFrame);
  }, [stopConversationGlide]);

  useEffect(() => () => stopConversationGlide(), [stopConversationGlide]);

  useEffect(() => {
    if (!autoScrollRef.current) return;
    const frame = requestAnimationFrame(() => {
      scrollConversationToBottom();
      syncScrollToBottomHint();
    });
    return () => cancelAnimationFrame(frame);
  }, [
    messages,
    streamingMessage,
    tools,
    working,
    requestPending,
    workingMessage,
    scrollConversationToBottom,
    syncScrollToBottomHint,
  ]);

  useEffect(() => {
    const thread = conversationThreadRef.current;
    const scroll = conversationScrollRef.current;
    if (!thread || !scroll) return;
    const observer = new ResizeObserver(() => {
      if (autoScrollRef.current) scrollConversationToBottom();
      syncScrollToBottomHint();
    });
    observer.observe(thread);
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [
    activeConversationId,
    scrollConversationToBottom,
    syncScrollToBottomHint,
  ]);

  useEffect(() => {
    stopConversationGlide();
    autoScrollRef.current = true;
    setShowScrollToBottom(false);
    const frame = requestAnimationFrame(() => {
      scrollConversationToBottom();
      syncScrollToBottomHint();
    });
    return () => cancelAnimationFrame(frame);
  }, [
    activeConversationId,
    scrollConversationToBottom,
    stopConversationGlide,
    syncScrollToBottomHint,
  ]);

  const handleConversationScroll = useCallback(() => {
    const element = conversationScrollRef.current;
    if (!element) return;
    const distanceFromBottom =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    if (distanceFromBottom <= 24) autoScrollRef.current = true;
    else if (userScrollInteractionRef.current) autoScrollRef.current = false;
    syncScrollToBottomHint();
  }, [syncScrollToBottomHint]);

  const handleConversationWheel = useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (event.deltaY < 0) {
        stopConversationGlide();
        autoScrollRef.current = false;
      }
    },
    [stopConversationGlide],
  );

  const handleConversationPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const element = event.currentTarget;
      const rect = element.getBoundingClientRect();
      const scrollbarArea = Math.max(
        16,
        element.offsetWidth - element.clientWidth + 4,
      );
      if (
        event.pointerType === "touch" ||
        event.clientX >= rect.right - scrollbarArea
      ) {
        stopConversationGlide();
        userScrollInteractionRef.current = true;
      }
    },
    [stopConversationGlide],
  );

  const handleConversationPointerEnd = useCallback(() => {
    userScrollInteractionRef.current = false;
  }, []);

  const handlePiEvent = (event: JsonObject) => {
    if (event.type === "desktop_models_update") {
      setSnapshot(current => current ? { ...current, models: event.models ?? current.models,
        state: event.state ?? { ...current.state, model: event.model, thinkingLevel: event.thinkingLevel ?? current.state.thinkingLevel },
        thinkingLevels: event.thinkingLevels ?? current.thinkingLevels } : current);
      return;
    }
    if (event.run) setSnapshot(current => current ? { ...current, run: event.run } : current);
    if (event.type === "desktop_run_state" && event.stopped === true) {
      setWorking(false);
      setWorkingMessage("");
      setStreamingMessage(null);
      setTools({});
      setSnapshot(current => current ? { ...current, state: { ...current.state, isStreaming: false, isCompacting: false } } : current);
      if (typeof event.run?.durationMs === "number") {
        setLastDuration(event.run.durationMs);
        setElapsed(event.run.durationMs);
      }
      startedAtRef.current = undefined;
      return;
    }
    if (event.type === "desktop_run_started" || event.type === "agent_start") {
      setSnapshot(current => current ? { ...current, planWorkingRevision: event.planWorkingRevision } : current);
      const continuingRun = startedAtRef.current !== undefined;
      const runStartedAt =
        typeof event.run?.startedAt === "string"
          ? Date.parse(event.run.startedAt)
          : NaN;
      const now = Number.isFinite(runStartedAt)
        ? runStartedAt
        : (startedAtRef.current ?? Date.now());
      setWorking(true);
      setStartedAt(now);
      startedAtRef.current = now;
      setWorkingMessage("");
      if (!continuingRun) {
        setElapsed(Math.max(0, Date.now() - now));
        setLastDuration(undefined);
        setRunDiff(undefined);
        setDiffOpen(false);
      }
    } else if (event.type === "desktop_chat_naming") {
      setWorkingMessage(event.active ? t("Модель выбирает название чата…") : "");
    } else if (event.type === "desktop_plan_activity") {
      setSnapshot(current => current ? { ...current, planWorkingRevision: event.revision } : current);
    } else if (event.type === "desktop_history_rewound" && event.snapshot) {
      applyRuntimeSnapshot(event.snapshot as ConversationSnapshot);
      setWorking(false);
      setTools({});
      setRunDiff(undefined);
      setDiffOpen(false);
      setLastDuration(undefined);
      setStartedAt(undefined);
      startedAtRef.current = undefined;
      setElapsed(0);
      autoScrollRef.current = true;
    } else if (event.type === "agent_settled") {
      setWorking(false);
      setWorkingMessage("");
      setStreamingMessage(null);
      const savedDuration =
        typeof event.run?.durationMs === "number"
          ? event.run.durationMs
          : undefined;
      if (startedAtRef.current || savedDuration !== undefined) {
        const duration = savedDuration ?? Date.now() - startedAtRef.current!;
        setElapsed(duration);
        setLastDuration(duration);
        startedAtRef.current = undefined;
      }
      setTools({});
      if (Array.isArray(event.messages)) setMessages(event.messages);
      else setMessages((current) => {
        try {
          const next = event.messagePatch ? applyMessagePatch<JsonObject>(current, event.messagePatch) : current;
          if (typeof event.messageCount === "number" && next.filter(message => !message.optimistic).length !== event.messageCount)
            throw new Error("Message stream needs synchronization");
          return next;
        } catch {
          // Opening a chat mid-run can miss events. Recover explicitly rather
          // than silently dropping messages or restoring every history each turn.
          queueMicrotask(() => void recoverConversationHistory());
          return current;
        }
      });
      if (event.state) {
        setSnapshot((current) =>
          current
            ? {
                ...current,
                state: event.state,
                entries: Array.isArray(event.entries)
                  ? event.entries
                  : current.entries,
                extensionState: event.extensionState ?? current.extensionState,
                historyTargets: event.historyTargets ?? current.historyTargets,
              }
            : current,
        );
      }
    } else if (event.type === "message_start") {
      if (event.message?.role === "assistant")
        setStreamingMessage(structuredClone(event.message));
      else if (event.message && event.message.role !== "toolResult" && event.message.role !== "tool") {
        setMessages((current) => {
          const incomingText = messageText(event.message);
          let optimisticIndex = current.findIndex(
            (item) => item.optimistic && messageText(item) === incomingText,
          );
          if (optimisticIndex < 0)
            optimisticIndex = current.findIndex((item) => item.optimistic);
          if (optimisticIndex < 0) return [...current, event.message];
          const next = [...current];
          next[optimisticIndex] = {
            ...next[optimisticIndex],
            ...event.message,
            attachments:
              next[optimisticIndex].attachments ?? event.message.attachments,
            optimistic: false,
          };
          return next;
        });
      }
    } else if (event.type === "message_update") {
      const delta = event.assistantMessageEvent;
      if (!delta) return;
      setStreamingMessage((current) =>
        applyAssistantMessageDelta(current ?? undefined, delta),
      );
    } else if (event.type === "message_end" && event.message) {
      if (event.message.role === "assistant") {
        setMessages((current) => [...current, event.message]);
        setStreamingMessage(null);
      } else if (
        event.message.role === "toolResult" ||
        event.message.role === "tool"
      ) {
        setMessages((current) => [...current, event.message]);
      }
      if (event.state) {
        setSnapshot((current) =>
          current ? { ...current, state: event.state } : current,
        );
      }
    } else if (event.type === "desktop_state" && event.state) {
      setSnapshot((current) =>
        current
          ? {
              ...current,
              state: event.state,
              commands: Array.isArray(event.commands)
                ? event.commands
                : current.commands,
            }
          : current,
      );
    } else if (event.type === "tool_execution_start") {
      setTools((current) => ({
        ...current,
        [event.toolCallId]: {
          id: event.toolCallId,
          parentToolCallId: event.parentToolCallId,
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
          ...(current[event.toolCallId] ?? {
            id: event.toolCallId,
            name: event.toolName,
            running: true,
            startedAt: Date.now(),
          }),
          result: event.partialResult,
          ...(typeof event.parentToolCallId === "string" ? { parentToolCallId: event.parentToolCallId } : {}),
        },
      }));
    } else if (event.type === "tool_execution_end") {
      setTools((current) => ({
        ...current,
        [event.toolCallId]: {
          ...(current[event.toolCallId] ?? {
            id: event.toolCallId,
            name: event.toolName,
            startedAt: Date.now(),
          }),
          result: event.result,
          ...(typeof event.parentToolCallId === "string" ? { parentToolCallId: event.parentToolCallId } : {}),
          running: false,
          error: Boolean(event.isError),
        },
      }));
    } else if (event.type === "queue_update") {
      const steering = Array.isArray(event.steering)
        ? event.steering.map(String)
        : [];
      const followUp = Array.isArray(event.followUp)
        ? event.followUp.map(String)
        : [];
      setSteeringMessages(steering);
      setFollowUpMessages(followUp);
      setSnapshot((current) =>
        current
          ? {
              ...current,
              state: {
                ...current.state,
                steeringMessages: steering,
                followUpMessages: followUp,
                pendingMessageCount: steering.length + followUp.length,
              },
            }
          : current,
      );
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
      setSnapshot((current) =>
        current
          ? { ...current, state: { ...current.state, isCompacting: true } }
          : current,
      );
      setWorkingMessage(t("Сжатие контекста…"));
    } else if (event.type === "compaction_end") {
      setSnapshot((current) =>
        current
          ? {
              ...current,
              state: event.state ?? { ...current.state, isCompacting: false },
              entries: Array.isArray(event.entries)
                ? event.entries
                : current.entries,
              compactions: Array.isArray(event.compactions)
                ? event.compactions
                : current.compactions,
            }
          : current,
      );
      setWorking(Boolean(event.state?.isStreaming));
      setWorkingMessage("");
      if (event.errorMessage)
        addNotice(t("Сжатие контекста: {0}", String(event.errorMessage)), "warning");
    } else if (event.type === "auto_retry_start") {
      setWorking(true);
      setWorkingMessage(
        t("Повтор запроса {0}/{1}…", Number(event.attempt ?? 0), Number(event.maxAttempts ?? 0)),
      );
    } else if (event.type === "auto_retry_end") {
      setWorkingMessage("");
      if (event.success === false && event.finalError)
        addNotice(String(event.finalError), "error");
    } else if (event.type === "summarization_retry_scheduled") {
      setWorkingMessage(
        t("Повтор сжатия {0}/{1}…", Number(event.attempt ?? 0), Number(event.maxAttempts ?? 0)),
      );
    } else if (event.type === "summarization_retry_finished") {
      setWorkingMessage("");
    } else if (event.type === "desktop_persistence_error") {
      addNotice(String(event.error ?? t("Не удалось сохранить состояние чата")), "error");
      // Persistence errors do not terminate the live model process.
    } else if (event.type === "extension_error") {
      // An extension failure is not a run-settled event. The agent may recover
      // or continue with other tools; keep Stop and the live indicator available.
      addNotice(String(event.error ?? t("Ошибка расширения Pi")), "error");
    } else if (event.type === "runtime_error") {
      addNotice(String(event.error ?? t("Ошибка Pi")), "error");
      setWorking(false);
      setWorkingMessage("");
      if (typeof event.run?.durationMs === "number")
        setLastDuration(event.run.durationMs);
    } else if (event.type === "desktop_run_diff" && event.diff) {
      setRunDiff(event.diff as RunDiff);
      if (typeof event.run?.durationMs === "number")
        setLastDuration(event.run.durationMs);
    } else if (event.type === "desktop_preparing") {
      const preparingMessage = String(event.message ?? "");
      if (preparingMessage) {
        setWorking(true);
        setWorkingMessage(preparingMessage);
      } else {
        setWorkingMessage((current) =>
          current.startsWith(t("Подготавливаю отслеживание")) ? "" : current,
        );
      }
    } else if (event.type === "desktop_diff_error") {
      addNotice(
        t("Не удалось построить diff: {0}", String(event.error ?? t("неизвестная ошибка"))),
        "warning",
      );
    } else if (event.type === "desktop_queue_update") {
      setQueuedPrompts(
        Array.isArray(event.queued) ? (event.queued as QueuedPrompt[]) : [],
      );
    } else if (event.type === "desktop_queue_error") {
      addNotice(
        t("Не удалось автоматически отправить сообщение из очереди: {0}", String(event.error ?? t("неизвестная ошибка"))),
        "error",
      );
    }
  };

  const openConversation = async (conversationId: string) => {
    const navigationSequence = ++navigationSequenceRef.current;
    activeIdRef.current = conversationId;
    setActiveConversationId(conversationId);
    setSnapshot(undefined);
    setWorking(false);
    const conversation = conversations.find(
      (item) => item.id === conversationId,
    );
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
      setStreamingMessage(
        next.liveMessage
          ? structuredClone(next.liveMessage as JsonObject)
          : null,
      );
      setTools(
        next.liveTools
          ? (structuredClone(next.liveTools) as Record<string, ToolActivity>)
          : {},
      );
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
      setExtensionDialog(
        next.extensionUi.pendingDialogs[0]
          ? { conversationId, request: next.extensionUi.pendingDialogs[0] }
          : undefined,
      );
      document.title = next.extensionUi.title || "Pi Desktop";
      setRunDiff(next.run?.diff);
      setLastDuration(next.run?.durationMs);
      if (next.state.isStreaming) {
        const savedStartedAt = next.run?.startedAt
          ? Date.parse(next.run.startedAt)
          : NaN;
        const now = Number.isFinite(savedStartedAt)
          ? savedStartedAt
          : Date.now();
        setStartedAt(now);
        startedAtRef.current = now;
      } else {
        setStartedAt(undefined);
        startedAtRef.current = undefined;
      }
    } catch (error) {
      if (navigationSequenceRef.current !== navigationSequence) return;
      addNotice(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    } finally {
      if (navigationSequenceRef.current === navigationSequence)
        setLoading(false);
    }
  };

  const newChat = async (projectId?: string) => {
    const navigationSequence = ++navigationSequenceRef.current;
    activeIdRef.current = undefined;
    setSnapshot(undefined);
    setWorking(false);
    setLoading(true);
    try {
      const next = await window.piDesktop.createConversation(projectId);
      if (navigationSequenceRef.current !== navigationSequence) return;
      setConversations((current) => {
        const found = current.some((item) => item.id === next.conversation.id);
        return found
          ? current.map((item) =>
              item.id === next.conversation.id ? next.conversation : item,
            )
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
      addNotice(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    } finally {
      if (navigationSequenceRef.current === navigationSequence)
        setLoading(false);
    }
  };

  const projectCreated = async (project: ProjectRecord) => {
    setProjectDialogOpen(false);
    setProjects((current) => [
      project,
      ...current.filter((item) => item.id !== project.id),
    ]);
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
      addNotice(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  };

  const showConversationMenu = (
    event: React.MouseEvent,
    conversationId: string,
  ) => {
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
      x: Math.min(event.clientX, window.innerWidth - 300),
      y: Math.min(event.clientY, window.innerHeight - 220),
    });
  };

  const clearConversationView = (conversationId: string) => {
    if (activeConversationId !== conversationId) return;
    navigationSequenceRef.current++;
    activeIdRef.current = undefined;
    setLoading(false);
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
      const conversation = conversations.find(
        (item) => item.id === conversationId,
      );
      setConversations((current) =>
        current.filter((item) => item.id !== conversationId),
      );
      if (conversation)
        setArchivedConversations((current) => [
          { ...conversation, archived: true, status: "idle" },
          ...current,
        ]);
      clearConversationView(conversationId);
    } catch (error) {
      addNotice(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  };

  const restoreChat = async (conversationId: string) => {
    try {
      await window.piDesktop.restoreConversation(conversationId);
      const conversation = archivedConversations.find(
        (item) => item.id === conversationId,
      );
      setArchivedConversations((current) =>
        current.filter((item) => item.id !== conversationId),
      );
      if (conversation)
        setConversations((current) => [
          { ...conversation, archived: false },
          ...current,
        ]);
    } catch (error) {
      addNotice(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  };

  const deleteChat = async (conversationId: string) => {
    setConversationMenu(undefined);
    try {
      const deleted = await window.piDesktop.deleteConversation(conversationId);
      if (!deleted) return;
      setConversations((current) =>
        current.filter((item) => item.id !== conversationId),
      );
      setArchivedConversations((current) =>
        current.filter((item) => item.id !== conversationId),
      );
      clearConversationView(conversationId);
    } catch (error) {
      addNotice(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  };

  const saveConversationTitle = async (title: string) => {
    const conversation = renameConversation;
    if (!conversation) return;
    setRenameConversation(undefined);
    try {
      await window.piDesktop.renameConversation(conversation.id, title);
      setConversations((current) =>
        current.map((item) =>
          item.id === conversation.id ? { ...item, title } : item,
        ),
      );
    } catch (error) {
      addNotice(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  };

  const saveProjectTitle = async (name: string) => {
    const project = renameProject;
    if (!project) return;
    setRenameProject(undefined);
    try {
      const updated = await window.piDesktop.renameProject(project.id, name);
      setProjects((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
    } catch (error) {
      addNotice(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  };

  const removeProject = async (projectId: string) => {
    setProjectMenu(undefined);
    try {
      const removed = await window.piDesktop.removeProject(projectId);
      if (!removed) return;
      setProjects((current) => current.filter((item) => item.id !== projectId));
      setConversations((current) =>
        current.filter((item) => item.projectId !== projectId),
      );
      if (activeProjectId === projectId) {
        setActiveProjectId(undefined);
        setActiveConversationId(undefined);
        setSnapshot(undefined);
        setMessages([]);
      }
    } catch (error) {
      addNotice(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  };

  const beginRequest = (conversationId: string): boolean => {
    if (pendingRequestIdsRef.current.has(conversationId)) return false;
    pendingRequestIdsRef.current.add(conversationId);
    setPendingRequests(current => ({ ...current, [conversationId]: true }));
    return true;
  };
  const finishRequest = (conversationId: string) => {
    pendingRequestIdsRef.current.delete(conversationId);
    setPendingRequests(current => {
      const next = { ...current };
      delete next[conversationId];
      return next;
    });
  };
  const primaryAction = composerAction(working, Boolean(input.trim() || attachments.length || historyQuotes.length), snapshot?.run);
  const resumeExecution = async () => {
    if (!activeConversationId || !beginRequest(activeConversationId)) return;
    const id = activeConversationId;
    autoScrollRef.current = true;
    try {
      await window.piDesktop.resumeConversation(id);
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      finishRequest(id);
    }
  };

  const changePlanning = async (action: "start" | "revise" | "approve" | "cancel", revision: number) => {
    if (!activeConversationId) return;
    const id = activeConversationId;
    if (!beginRequest(id)) throw new Error(t("Дождитесь завершения предыдущего действия."));
    try {
      await window.piDesktop.controlPlanning(id, action, revision);
      if (activeIdRef.current === id) {
        setGoalMode(false);
        setPlanningOpen(action !== "approve" && action !== "cancel");
        setNotebookOpen(false); setSkillsOpen(false);
        if (action === "revise" || action === "start") composerInputRef.current?.focus();
      }
    } finally { finishRequest(id); }
  };

  const submit = async (explainQuote?: string) => {
    if (loading) return;
    const quick = explainQuote !== undefined;
    const submittedQuotes = quick ? [explainQuote] : historyQuotes;
    const originalInput = input;
    const message = quick ? t("Объясни подробнее выделенный фрагмент.") :
      input.trim() || (attachments.length ? t("Посмотри вложения.") : historyQuotes.length ? t("Посмотри выделенные фрагменты.") : "");
    const text = message ? quotedHistoryPrompt(message, submittedQuotes) : "";
    if (!text && !quick && primaryAction === "resume") { await resumeExecution(); return; }
    if (!text || !activeConversationId || (!working && pendingRequestIdsRef.current.has(activeConversationId))) return;
    if (!working && (text === "/compact" || text.startsWith("/compact "))) {
      setInput("");
      await executeCompact(
        text.startsWith("/compact ") ? text.slice(9).trim() : undefined,
      );
      return;
    }
    if (!working && text === "/reload") {
      setInput("");
      await executeReload();
      return;
    }
    const conversationId = activeConversationId;
    const submittedAttachments = quick ? [] : attachments;
    const submittedAsGoal = !quick && goalMode;
    if (!working && !beginRequest(conversationId)) return;
    autoScrollRef.current = true;
    if (!quick) {
      setInput("");
      setAttachments([]);
      setHistoryQuotes([]);
      setGoalMode(false);
    }
    if (working) {
      try {
        const queued = await window.piDesktop.queuePrompt(
          conversationId,
          text,
          submittedAttachments,
          false,
        );
        if (activeIdRef.current === conversationId) setQueuedPrompts(queued);
      } catch (error) {
        if (!quick && activeIdRef.current === conversationId) {
          setInput(originalInput);
          setAttachments(submittedAttachments);
          setHistoryQuotes(submittedQuotes);
        }
        addNotice(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
      return;
    }
    const optimistic = {
      id: `local-${crypto.randomUUID()}`,
      role: "user",
      content: text,
      timestamp: Date.now(),
      attachments: submittedAttachments.map((item) => item.name),
      images: submittedAttachments
        .filter(
          (item) => item.mimeType?.startsWith("image/") && Boolean(item.data),
        )
        .map((item) => ({
          name: item.name,
          mimeType: item.mimeType as string,
          data: item.data as string,
        })),
      optimistic: true,
    };
    setMessages((current) => [...current, optimistic]);
    try {
      if (submittedAsGoal)
        await window.piDesktop.setGoal(
          conversationId,
          text,
          submittedAttachments,
          false,
        );
      else
        await window.piDesktop.sendPrompt(
          conversationId,
          text,
          submittedAttachments,
          undefined,
          false,
        );
    } catch (error) {
      if (activeIdRef.current === conversationId) {
        setMessages((current) =>
          current.filter((item) => item.id !== optimistic.id),
        );
        if (!quick) {
          setInput(originalInput);
          setAttachments(submittedAttachments);
          setHistoryQuotes(submittedQuotes);
          setGoalMode(submittedAsGoal);
        }
      }
      addNotice(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    } finally {
      finishRequest(conversationId);
    }
  };

  const sendQueuedPrompt = async (prompt: QueuedPrompt) => {
    if (!activeConversationId) return;
    if (queuedActionRef.current) return;
    const conversationId = activeConversationId;
    queuedActionRef.current = prompt.id;
    setQueuedActionId(prompt.id);
    try {
      const queued = await window.piDesktop.sendQueuedPrompt(
        conversationId,
        prompt.id,
      );
      if (activeIdRef.current === conversationId) setQueuedPrompts(queued);
      autoScrollRef.current = true;
    } catch (error) {
      addNotice(
        error instanceof Error ? error.message : String(error),
        "error",
      );
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
      const queued = await window.piDesktop.removeQueuedPrompt(
        conversationId,
        prompt.id,
      );
      if (activeIdRef.current === conversationId) {
        setQueuedPrompts(queued);
        setInput((current) =>
          current ? `${prompt.message}\n\n${current}` : prompt.message,
        );
        setAttachments((current) => [
          ...prompt.attachments,
          ...current.filter(
            (item) =>
              !prompt.attachments.some(
                (queuedAttachment) =>
                  queuedAttachment.id === item.id ||
                  queuedAttachment.path === item.path,
              ),
          ),
        ]);
      }
    } catch (error) {
      addNotice(
        error instanceof Error ? error.message : String(error),
        "error",
      );
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
      const queued = await window.piDesktop.removeQueuedPrompt(
        conversationId,
        promptId,
      );
      if (activeIdRef.current === conversationId) setQueuedPrompts(queued);
    } catch (error) {
      addNotice(
        error instanceof Error ? error.message : String(error),
        "error",
      );
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
      if (restored)
        setInput((current) =>
          current ? `${restored}\n\n${current}` : restored,
        );
      setSteeringMessages([]);
      setFollowUpMessages([]);
    } catch (error) {
      addNotice(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  };

  const addAttachments = async () => {
    try {
      const selected = await window.piDesktop.chooseAttachments();
      if (selected.length) {
        setAttachments((current) => mergeAttachments(current, selected));
      }
    } catch (error) {
      addNotice(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  };

  const dropAttachments = async (files: File[]) => {
    const conversationId = activeConversationId;
    if (!conversationId) {
      addNotice(t("Сначала откройте или создайте чат."), "error");
      return;
    }
    try {
      const paths: string[] = [];
      const pastedFiles: File[] = [];
      for (const file of files) {
        const originalPath = window.piDesktop.getDroppedFilePath(file);
        if (originalPath) paths.push(originalPath);
        else if (file.type.startsWith("image/")) pastedFiles.push(file);
      }
      const [originals, pasted] = await Promise.all([
        paths.length ? window.piDesktop.attachFilePaths(paths) : Promise.resolve([]),
        Promise.all(pastedFiles.map(pastedImageAttachment)),
      ]);
      if (activeIdRef.current !== conversationId) return;
      setAttachments((current) => mergeAttachments(current, [...originals, ...pasted]));
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const changeModel = async (model: ModelInfo) => {
    if (!activeConversationId) return;
    setModelMenuOpen(false);
    try {
      const state = await window.piDesktop.setModel(
        activeConversationId,
        model.provider,
        model.id,
      );
      setSnapshot((current) =>
        current
          ? {
              ...current,
              state,
              thinkingLevels: model.thinkingLevels ?? current.thinkingLevels,
            }
          : current,
      );
    } catch (error) {
      addNotice(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  };

  const changeThinking = async (level: ThinkingLevel) => {
    if (!activeConversationId) return;
    setThinkingMenuOpen(false);
    try {
      const state = await window.piDesktop.setThinkingLevel(
        activeConversationId,
        level,
      );
      setSnapshot((current) => (current ? { ...current, state } : current));
    } catch (error) {
      addNotice(
        error instanceof Error ? error.message : String(error),
        "error",
      );
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

  const recoverConversationHistory = async () => {
    const id = activeIdRef.current;
    if (!id || historyRecoveryRef.current === id) return;
    historyRecoveryRef.current = id;
    const navigation = navigationSequenceRef.current;
    try {
      const next = await window.piDesktop.openConversation(id);
      if (activeIdRef.current !== id || navigationSequenceRef.current !== navigation) return;
      setMessages(next.messages as JsonObject[]);
      setSnapshot(current => current ? { ...current, entries: next.entries, historyTargets: next.historyTargets } : next);
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      if (historyRecoveryRef.current === id) historyRecoveryRef.current = undefined;
    }
  };

  const confirmHistoryAction = async () => {
    const action = historyAction;
    if (!action || historyBusy || working || activeConversationId !== action.conversationId) return;
    setHistoryBusy(true);
    try {
      if (action.mode === "edit") {
        await window.piDesktop.editLastMessage(action.conversationId, action.entryId, action.text);
      } else {
        const next = await window.piDesktop.rewindConversation(action.conversationId, action.entryId);
        if (activeIdRef.current === action.conversationId) applyRuntimeSnapshot(next);
      }
      if (activeIdRef.current === action.conversationId) setHistoryAction(undefined);
    } catch (error) {
      addNotice(error instanceof Error ? error.message : String(error), "error");
    } finally {
      setHistoryBusy(false);
    }
  };

  const executeCompact = async (instructions?: string) => {
    if (!activeConversationId || working) return;
    const started = Date.now();
    setCommandPaletteOpen(false);
    setCompactDialogOpen(false);
    setWorking(true);
    setWorkingMessage(t("Сжатие контекста…"));
    setStartedAt(started);
    startedAtRef.current = started;
    setElapsed(0);
    autoScrollRef.current = true;
    try {
      const next = await window.piDesktop.compactConversation(
        activeConversationId,
        instructions,
      );
      applyRuntimeSnapshot(next);
      addNotice(t("Контекст сжат штатным механизмом Pi."), "info");
    } catch (error) {
      addNotice(
        error instanceof Error ? error.message : String(error),
        "error",
      );
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
    if (
      !window.confirm(
        t("Перезагрузить расширения, навыки, промпты и настройки Pi? Текущий процесс перечитает конфигурацию, поэтому KV-кэш может быть пересчитан."),
      )
    )
      return;
    setCommandPaletteOpen(false);
    setWorking(true);
    setWorkingMessage(t("Перезагрузка ресурсов Pi…"));
    try {
      const next = await window.piDesktop.reloadRuntime(activeConversationId);
      applyRuntimeSnapshot(next);
      addNotice(t("Ресурсы Pi перезагружены."), "info");
    } catch (error) {
      addNotice(
        error instanceof Error ? error.message : String(error),
        "error",
      );
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
          setHistoryMenu(undefined);
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
  const activeConversation =
    conversations.find((item) => item.id === activeConversationId) ??
    snapshot?.conversation;
  const grouped = useMemo(
    () =>
      projects.map((project) => ({
        project,
        chats: conversations
          .filter(
            (item) =>
              item.projectId === project.id &&
              (!searchMatches || searchMatches.has(item.id)),
          )
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      })),
    [projects, conversations, searchMatches],
  );
  const standaloneChats = useMemo(
    () =>
      conversations
        .filter(
          (item) =>
            !item.projectId && (!searchMatches || searchMatches.has(item.id)),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [conversations, searchMatches],
  );
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
      addNotice(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  };
  const historicalTranscriptItems = useMemo(() => {
    const visibleExtensionEntries = (snapshot?.entries ?? []).filter(
      (entry) => entry.renderedLines?.length,
    );
    const compactionEntries = (snapshot?.entries ?? []).filter(
      (entry) => entry.type === "compaction",
    );
    return [
      ...messages.map(
        (message, sourceIndex): TranscriptTimelineItem => ({
          kind: "message",
          message,
          sourceIndex,
          timestamp: transcriptTimestamp(
            message.timestamp,
            Number.MAX_SAFE_INTEGER - 100_000 + sourceIndex,
          ),
          order: sourceIndex * 2,
        }),
      ),
      ...visibleExtensionEntries.map(
        (entry, sourceIndex): TranscriptTimelineItem => ({
          kind: "extension",
          entry,
          sourceIndex,
          timestamp: transcriptTimestamp(
            entry.timestamp,
            Number.MAX_SAFE_INTEGER - 50_000 + sourceIndex,
          ),
          order: sourceIndex * 2 + 1,
        }),
      ),
      ...compactionEntries.map(
        (entry, sourceIndex): TranscriptTimelineItem => ({
          kind: "compaction",
          entry,
          record: snapshot?.compactions.find(
            (record) => record.entryId === entry.id,
          ),
          sourceIndex,
          timestamp: transcriptTimestamp(
            entry.timestamp,
            Number.MAX_SAFE_INTEGER - 25_000 + sourceIndex,
          ),
          order: sourceIndex * 2 + 2,
        }),
      ),
    ].sort(
      (left, right) =>
        left.timestamp - right.timestamp || left.order - right.order,
    );
  }, [messages, snapshot?.entries, snapshot?.compactions]);
  const transcriptItems: TranscriptTimelineItem[] = streamingMessage
    ? [
        ...historicalTranscriptItems,
        {
          kind: "message",
          message: streamingMessage,
          sourceIndex: messages.length,
          timestamp: Number.MAX_SAFE_INTEGER,
          order: Number.MAX_SAFE_INTEGER,
        },
      ]
    : historicalTranscriptItems;
  const slashQuery =
    input.startsWith("/") && !input.includes(" ")
      ? input.slice(1).toLocaleLowerCase()
      : undefined;
  const slashCommands =
    slashQuery === undefined
      ? []
      : (snapshot?.commands ?? [])
          .filter((command) =>
            command.name.toLocaleLowerCase().includes(slashQuery),
          )
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
        calls.add(
          toolCallIdentifier(call, `message-${messageIndex}-tool-${callIndex}`),
        );
      });
    });
    return { results, calls };
  }, [messages]);
  const streamingToolIds = new Set<string>();
  if (streamingMessage) {
    toolCallParts(streamingMessage).forEach((call, callIndex) => {
      streamingToolIds.add(
        toolCallIdentifier(
          call,
          `message-${messages.length}-tool-${callIndex}`,
        ),
      );
    });
  }
  const hasTranscriptTool = (id: string): boolean =>
    historicalToolIndex.calls.has(id) || streamingToolIds.has(id);
  const buildToolActivity = (
    call: JsonObject,
    fallbackId: string,
  ): ToolActivity => {
    const id = toolCallIdentifier(call, fallbackId);
    const live = tools[id];
    const persisted = historicalToolIndex.results.get(id);
    return {
      id,
      name: String(
        call.name && call.name !== t("Инструмент")
          ? call.name
          : (live?.name ?? persisted?.toolName ?? t("Инструмент")),
      ),
      args: call.arguments ?? call.args ?? live?.args,
      partialArguments:
        typeof call.partialArguments === "string"
          ? call.partialArguments
          : undefined,
      result: persisted ? resultMessagePayload(persisted) : live?.result,
      running: live?.running ?? false,
      preparing: !live && !persisted && working,
      error: persisted ? Boolean(persisted.isError) : live?.error,
      startedAt: live?.startedAt ?? 0,
    };
  };
  const nestedFor = (id: string) => nestedToolActivities(id, tools, historicalToolIndex.results);
  const placedNestedIds = new Set<string>();
  for (const id of new Set([...historicalToolIndex.calls, ...streamingToolIds])) {
    for (const child of nestedFor(id)) placedNestedIds.add(child.id);
  }
  const orphanTools = Object.values(tools).filter(
    (tool) => !hasTranscriptTool(tool.id) && !placedNestedIds.has(tool.id),
  );
  const runningTool = Object.values(tools).find((tool) => tool.running);
  const streamingParts = Array.isArray(streamingMessage?.content)
    ? (streamingMessage.content as JsonObject[])
    : [];
  const hasStreamingAnswer = streamingParts.some(
    (part) => part.type === "text" && String(part.text ?? "").trim(),
  );
  const hasStreamingThinking = streamingParts.some(
    (part) =>
      part.type === "thinking" &&
      String(part.thinking ?? part.text ?? "").trim(),
  );
  const activityLabel = runningTool
    ? t("Выполняется: {0}", toolPresentation(runningTool.name, parsedToolArguments(runningTool.args)).label)
    : workingMessage
      ? workingMessage
      : hasStreamingAnswer
        ? t("Модель формирует ответ…")
        : hasStreamingThinking
          ? hiddenThinkingLabel || t("Модель размышляет…")
          : t("Модель работает…");
  const transcriptItemKey = (
    item: TranscriptTimelineItem,
    index: number,
  ): string => {
    if (item.kind === "message")
      return `${messageKey(item.message, item.sourceIndex)}:${item.fragment ?? "whole"}${item.fragmentIndex === undefined ? "" : `:${item.fragmentIndex}`}`;
    return String(item.entry.id ?? `${item.kind}-${item.sourceIndex}-${index}`);
  };
  const renderTranscriptItem = (item: TranscriptTimelineItem, published?: ReadonlySet<string>, answerMedia?: Record<string, unknown>[]): ReactNode => {
    if (item.kind === "compaction") {
      const tokensBefore =
        item.record?.tokensBefore ?? Number(item.entry.tokensBefore);
      const tokensAfter =
        item.record?.tokensAfter ?? Number(item.entry.estimatedTokensAfter);
      return (
        <div className="compaction-entry">
          <Check size={14} />
          <span>{t("Контекст сжат:")}<strong>{formatCompactTokens(tokensBefore)}</strong>{" "}
            → <strong>{formatCompactTokens(tokensAfter)}</strong>
            {item.record?.durationMs !== undefined
              ? t(" за {0}", formatElapsed(item.record.durationMs))
              : ""}
          </span>
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
    if (message.role === "custom" && message.display === false) return null;
    if (message.role === "toolResult" || message.role === "tool") {
      const id = toolResultIdentifier(message);
      if (id && hasTranscriptTool(id)) return null;
      return (
        <ToolCard
          hideMedia={published?.has(id ?? messageKey(message, index))}
          tool={{
            id: id ?? messageKey(message, index),
            name: String(message.toolName ?? message.name ?? t("Инструмент")),
            result: resultMessagePayload(message),
            running: false,
            error: Boolean(message.isError),
            startedAt: 0,
          }}
        />
      );
    }
    const visibleMessage = messageWithoutToolCalls(message);
    const calls = toolCallParts(message);
    const originalMessage = item.sourceMessage ?? message;
    const isStreamingMessage = originalMessage === streamingMessage;
    const historyTarget = item.historyActions !== false && !isStreamingMessage && !message.optimistic
      ? snapshot?.historyTargets?.find(target => target.messageIndex === index) : undefined;
    const canRewind = Boolean(historyTarget) && historyHasLaterMessages(messages, index);
    return (
      <>
        {visibleMessage && (
          <article className={`message ${message.role ?? "assistant"}`}>
            {message.role === "user" ? (
              <div className="user-bubble">
                <MessageContent message={visibleMessage} />
              </div>
            ) : (
              <div className="assistant-message">
                <MessageContent
                  message={visibleMessage}
                  assistant
                  streaming={isStreamingMessage}
                />
                {answerMedia && answerMedia.length > 0 && <div className="assistant-published-media"><ComfyMedia parts={answerMedia} /></div>}
              </div>
            )}
            {historyTarget && activeConversationId && (historyTarget.editable || canRewind) && (
              <div className="message-history-actions">
                {historyTarget.editable && <button title={t("Редактировать последнее сообщение")} disabled={working || historyBusy}
                  onClick={() => setHistoryAction({ conversationId: activeConversationId, entryId: historyTarget.entryId, mode: "edit", text: messageText(originalMessage) })}>
                  <Pencil size={13} />{t("Изменить")}</button>}
                {canRewind && <button title={t("Откатить сессию до этого сообщения включительно")} disabled={working || historyBusy}
                  onClick={() => setHistoryAction({ conversationId: activeConversationId, entryId: historyTarget.entryId, mode: "rewind", text: messageText(originalMessage) })}>
                  <RotateCcw size={13} />{t("Откатить сюда")}</button>}
              </div>
            )}
          </article>
        )}
        {calls.map((call, callIndex) => (
          <Fragment key={toolCallIdentifier(call, `${messageKey(message, index)}-${callIndex}`)}>
          <ToolCard
            hideMedia={published?.has(toolCallIdentifier(call, `${messageKey(message, index)}-${callIndex}`))}
            key={toolCallIdentifier(
              call,
              `${messageKey(message, index)}-${callIndex}`,
            )}
            tool={buildToolActivity(
              call,
              `${messageKey(message, index)}-${callIndex}`,
            )}
          />
          {nestedFor(toolCallIdentifier(call, `${messageKey(message, index)}-${callIndex}`)).map(child => (
            <ToolCard key={child.id} tool={child} />
          ))}
          </Fragment>
        ))}
      </>
    );
  };

  const transcriptDisplay = useMemo(
    () => buildTranscriptDisplay(transcriptItems),
    [transcriptItems],
  );
  const currentTurnStart = messages.reduce((last, message, index) => message.role === "user" ? index : last, -1);
  const [expandedProcessFolds, setExpandedProcessFolds] = useState<Set<string>>(
    () => new Set(),
  );
  const toggleProcessFold = useCallback((key: string) => {
    setExpandedProcessFolds((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const displayItemKey = (display: TranscriptDisplayItem): string =>
    display.display === "single"
      ? transcriptItemKey(display.item, 0)
      : display.key;
  const foldStats = (process: TranscriptTimelineItem[]) => {
    let calls = 0;
    let errors = 0;
    let thinking = false;
    for (const item of process) {
      if (item.kind !== "message") continue;
      const content: JsonObject[] = Array.isArray(item.message.content)
        ? item.message.content
        : [];
      if (
        content.some(
          (part) =>
            part?.type === "thinking" &&
            String(part.thinking ?? part.text ?? "").trim(),
        )
      )
        thinking = true;
      toolCallParts(item.message).forEach((call, callIndex) => {
        calls += 1;
        const id = toolCallIdentifier(
          call,
          `message-${item.sourceIndex}-tool-${callIndex}`,
        );
        const persisted = historicalToolIndex.results.get(id);
        const nested = nestedFor(id);
        calls += nested.length;
        errors += nested.filter(tool => tool.error).length;
        if (persisted) {
          if (persisted.isError) errors += 1;
        } else if (tools[id]?.error) errors += 1;
      });
    }
    return { calls, errors, thinking };
  };
  const renderDisplayItem = (display: TranscriptDisplayItem): ReactNode => {
    if (display.display === "single") return renderTranscriptItem(display.item);
    const expanded = expandedProcessFolds.has(display.key);
    const imageTools: { id: string; name: string; result?: unknown; args?: unknown }[] = [];
    {
      for (const item of display.process) {
        if (item.kind !== "message") continue;
        const message = item.message;
        toolCallParts(message).forEach((call, index) => {
          imageTools.push(buildToolActivity(call, `${messageKey(message, item.sourceIndex)}-${index}`));
        });
        if (message.role === "toolResult" || message.role === "tool") {
          const id = toolResultIdentifier(message) ?? messageKey(message, item.sourceIndex);
          imageTools.push({
            id,
            name: String(message.toolName ?? message.name ?? tools[id]?.name ?? ""),
            result: resultMessagePayload(message),
            args: tools[id]?.args,
          });
        }
      }
    }
    const answerMessage = display.answer.kind === "message" ? display.answer.message : undefined;
    const answerComplete = answerCanPublishMedia({
      streaming: display.answer.kind === "message" && (display.answer.sourceMessage ?? answerMessage) === streamingMessage,
      working,
      currentTurn: display.answer.sourceIndex >= currentTurnStart,
      stopReason: answerMessage?.stopReason,
    });
    const published = collectAnswerMedia(imageTools, answerComplete, answerMessage ? messageText(answerMessage) : "");
    const { calls, errors, thinking } = foldStats(display.process);
    const label =
      thinking && calls
        ? t("Размышления и инструменты")
        : thinking
          ? t("Размышления")
          : calls
            ? t("Инструменты")
            : t("Ход работы");
    const summary = [label];
    if (calls) summary.push(t("вызовов: {0}", calls));
    if (errors) summary.push(t("с ошибками: {0}", errors));
    return (
      <div className="process-fold">
        <button
          type="button"
          className={`process-fold-head ${expanded ? "open" : ""}`}
          onClick={() => toggleProcessFold(display.key)}
        >
          <ChevronRight size={14} />
          <span>{summary.join(" · ")}</span>
        </button>
        {expanded && (
          <div className="process-fold-body">
            {display.process.map((item, index) => (
              <Fragment key={transcriptItemKey(item, index)}>
                {renderTranscriptItem(item, published.toolIds)}
              </Fragment>
            ))}
          </div>
        )}
        {renderTranscriptItem(display.answer, undefined, published.parts)}
      </div>
    );
  };

  return (
    <div className="app-shell">
      {maskTarget && <MaskEditor key={maskTarget.id} image={maskTarget} initialMask={attachments.find(item => item.maskFor === maskTarget.id)} onClose={() => setMaskTarget(null)} onSave={mask => {
        setAttachments(current => current.some(item => item.id === maskTarget.id) ? [...current.filter(item => item.maskFor !== maskTarget.id), mask] : current);
        setMaskTarget(null);
      }} />}
      <div className="titlebar">
        <div className="titlebar-drag">
          {!settingsOpen && (
            <button
              className="title-icon"
              title={
                sidebarOpen
                  ? t("Скрыть боковую панель")
                  : t("Показать боковую панель")
              }
              onClick={() => setSidebarOpen((value) => !value)}
            >
              <PanelLeft size={15} />
            </button>
          )}
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
            onRestoreConversation={(conversationId) =>
              void restoreChat(conversationId)
            }
            onDeleteConversation={(conversationId) =>
              void deleteChat(conversationId)
            }
          />
        ) : (
          <>
            {sidebarOpen && (
              <aside className="sidebar">
                <div className="sidebar-brand">
                  <div className="brand-label">Pi Desktop</div>
                </div>
                <div className="search-box">
                  <Search size={14} />
                  <input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder={t("Поиск по чатам")}
                  />
                </div>
                <div className="project-list">
                  <div className="sidebar-section-title">
                    <span>{t("Проекты")}</span>
                    <button
                      title={t("Создать проект")}
                      onClick={() => setProjectDialogOpen(true)}
                    >
                      <Plus size={15} />
                    </button>
                  </div>
                  {grouped.map(({ project, chats }) => (
                    <section
                      className="project-section"
                      key={project.id}
                      onContextMenu={(event) =>
                        showProjectMenu(event, project.id)
                      }
                    >
                      <div className="project-row-wrap">
                        <button
                          className={`project-row ${activeProjectId === project.id ? "active" : ""}`}
                          onClick={() => void openProject(project.id)}
                        >
                          <Folder size={16} />
                          <span>{project.name}</span>
                        </button>
                        <button
                          className="project-new-chat"
                          title={t("Новый чат в проекте «{0}»", project.name)}
                          onClick={() => void newChat(project.id)}
                        >
                          <Plus size={14} />
                        </button>
                        <button
                          className="project-more"
                          title={t("Действия с проектом")}
                          onClick={(event) =>
                            showProjectMenu(event, project.id)
                          }
                        >
                          <MoreHorizontal size={14} />
                        </button>
                      </div>
                      <div className="chat-list">
                        {chats.map((chat) => (
                          <div
                            className="chat-entry"
                            key={chat.id}
                            data-conversation-id={chat.id}
                            onContextMenu={(event) =>
                              showConversationMenu(event, chat.id)
                            }
                          >
                            <button
                              className={`chat-row ${chat.id === activeConversationId ? "selected" : ""}`}
                              onClick={() => void openConversation(chat.id)}
                            >
                              <span className={`status-dot ${chat.status}`} />
                              <span>{conversationTitle(chat)}</span>
                            </button>
                            <button
                              className="chat-more"
                              title={t("Действия с чатом")}
                              onClick={(event) =>
                                showConversationMenu(event, chat.id)
                              }
                            >
                              <MoreHorizontal size={15} />
                            </button>
                          </div>
                        ))}
                      </div>
                    </section>
                  ))}
                  <button
                    className="new-chat-button standalone-new-chat"
                    onClick={() => void newChat()}
                  >
                    <MessageSquarePlus size={17} />{t(" Новый чат")}</button>
                  <div className="sidebar-section-title chats-title">
                    <span>{t("Чаты")}</span>
                  </div>
                  <div className="standalone-chat-list">
                    {standaloneChats.map((chat) => (
                      <div
                        className="chat-entry"
                        key={chat.id}
                        data-conversation-id={chat.id}
                        onContextMenu={(event) =>
                          showConversationMenu(event, chat.id)
                        }
                      >
                        <button
                          className={`chat-row ${chat.id === activeConversationId ? "selected" : ""}`}
                          onClick={() => void openConversation(chat.id)}
                        >
                          <span className={`status-dot ${chat.status}`} />
                          <span>{conversationTitle(chat)}</span>
                        </button>
                        <button
                          className="chat-more"
                          title={t("Действия с чатом")}
                          onClick={(event) =>
                            showConversationMenu(event, chat.id)
                          }
                        >
                          <MoreHorizontal size={15} />
                        </button>
                      </div>
                    ))}
                    {!standaloneChats.length && (
                      <div className="sidebar-empty">{t("Самостоятельных чатов пока нет")}</div>
                    )}
                  </div>
                </div>
                <button
                  className="sidebar-footer"
                  onClick={() => setSettingsOpen(true)}
                >
                  <Settings size={16} />
                  <span>{t("Настройки")}</span>
                </button>
              </aside>
            )}

            <main className={`main-panel${activeConversationId && (notebookOpen || (planningOpen && planning) || snapshot?.conversation.plan?.steps.length) ? " has-plan" : ""}`}
              onDragEnter={(event) => {
                if (!Array.from(event.dataTransfer.types).includes("Files")) return;
                event.preventDefault();
                fileDragDepthRef.current += 1;
                if (activeConversationId) setDraggingFiles(true);
              }}
              onDragOver={(event) => {
                if (!Array.from(event.dataTransfer.types).includes("Files")) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = activeConversationId ? "copy" : "none";
              }}
              onDragLeave={() => {
                fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
                if (!fileDragDepthRef.current) setDraggingFiles(false);
              }}
              onDrop={(event) => {
                if (!Array.from(event.dataTransfer.types).includes("Files")) return;
                event.preventDefault();
                fileDragDepthRef.current = 0;
                setDraggingFiles(false);
                void dropAttachments(Array.from(event.dataTransfer.files));
              }}
            >
              {draggingFiles && <div className="chat-drop-overlay"><div>{t("Отпустите, чтобы прикрепить к сообщению")}</div></div>}
              <header className="chat-header">
                <button
                  className="icon-button"
                  onClick={() => setSidebarOpen((value) => !value)}
                >
                  <Menu size={18} />
                </button>
                {activeProject ? <FolderOpen size={17} /> : <Bot size={17} />}
                <strong>
                  {(activeConversation ? conversationTitle(activeConversation) : undefined) ??
                    activeProject?.name ??
                    "Pi Desktop"}
                </strong>
                <div className="header-spacer" />
                {activeConversationId && window.piDesktop.webMode !== "remote" && <button className={`notebook-toggle${skillsOpen ? " is-active" : ""}`} title={t("Навыки — переиспользуемые инструкции")}
                  aria-label={t("Навыки")} aria-expanded={skillsOpen} onClick={() => { setSkillsOpen(value => !value); setPlanningOpen(false); setNotebookOpen(false); }}><Wrench size={17} /><span>{t("Навыки")}</span></button>}
                {activeConversationId && planning && <button className={`notebook-toggle${planningOpen ? " is-active" : ""}`} title={planning.phase === "completed" ? t("План реализации выполнен") : t("Документ плана реализации")}
                  aria-label={t("План реализации")} aria-expanded={planningOpen} onClick={() => { setPlanningOpen(value => !value); setNotebookOpen(false); setSkillsOpen(false); }}>{planning.phase === "completed" ? <Check size={17} /> : <ListChecks size={17} />}<span>{planning.phase === "completed" ? t("План выполнен") : t("План")}</span></button>}
                {activeConversationId && <button className={`notebook-toggle${notebookOpen ? " is-active" : ""}`} title={t("Блокнот — память текущего чата")}
                  aria-label={t("Блокнот")} aria-expanded={notebookOpen} onClick={() => { setNotebookOpen(value => !value); setPlanningOpen(false); }}><BookOpen size={17} /><span>{t("Блокнот")}</span></button>}
                <BrowserPanel conversationId={activeConversationId ?? undefined} />
                {activeProject && (
                  <button
                    className="path-button"
                    title={t("Показать в проводнике: {0}", activeProject.path)}
                    onClick={() =>
                      void window.piDesktop.showItemInFolder(activeProject.path)
                    }
                  >
                    {activeProject.name}
                  </button>
                )}
              </header>

              <div
                className="conversation-scroll"
                ref={conversationScrollRef}
                onContextMenu={(event) => {
                  if (event.target instanceof HTMLImageElement) return;
                  const selection = window.getSelection();
                  const text = selection?.toString().trim();
                  if (!activeConversationId || !text || !selection?.anchorNode || !selection.focusNode ||
                      !event.currentTarget.contains(selection.anchorNode) || !event.currentTarget.contains(selection.focusNode)) return;
                  event.preventDefault();
                  setHistoryMenu({ text, x: Math.max(8, Math.min(event.clientX, window.innerWidth - 228)),
                    y: Math.max(8, Math.min(event.clientY, window.innerHeight - 136)) });
                }}
                onScroll={handleConversationScroll}
                onWheel={handleConversationWheel}
                onPointerDown={handleConversationPointerDown}
                onPointerUp={handleConversationPointerEnd}
                onPointerCancel={handleConversationPointerEnd}
              >
                {loading ? (
                  <div className="chat-loading" role="status" aria-live="polite">
                    <span className="spinner" />
                    <strong>{bootstrap ? t("Загрузка чата…") : t("Запуск приложения…")}</strong>
                    <span>{t("Можно переключиться на другой чат")}</span>
                  </div>
                ) : !activeConversationId ? (
                  <div className="welcome">
                    <div className="welcome-logo">
                      <Bot size={34} />
                    </div>
                    <h1>{t("С чего начнём?")}</h1>
                    <p>{t("Начните самостоятельный чат или создайте проект с одной или несколькими рабочими папками.")}</p>
                    <div className="welcome-actions">
                      <button
                        className="primary large"
                        onClick={() => void newChat()}
                      >
                        <MessageSquarePlus size={18} />{t(" Новый чат")}</button>
                      <button
                        className="secondary large"
                        onClick={() => setProjectDialogOpen(true)}
                      >
                        <FolderOpen size={18} />{t(" Создать проект")}</button>
                    </div>
                  </div>
                ) : (
                  <div className="thread" ref={conversationThreadRef}>
                    {headerLines.length > 0 && (
                      <div className="extension-frame header-frame">
                        {headerLines.map((line, index) => (
                          <div key={`${index}-${line}`}>{line}</div>
                        ))}
                      </div>
                    )}
                    <VirtualFilm
                      items={transcriptDisplay}
                      itemKey={displayItemKey}
                      renderItem={renderDisplayItem}
                      resetKey={activeConversationId}
                      scrollRef={conversationScrollRef}
                    />
                    {orphanTools.map((tool) => (
                      <ToolCard key={tool.id} tool={tool} />
                    ))}
                    {footerLines.length > 0 && (
                      <div className="extension-frame footer-frame">
                        {footerLines.map((line, index) => (
                          <div key={`${index}-${line}`}>{line}</div>
                        ))}
                      </div>
                    )}
                    {working && (
                      <div
                        className="run-activity"
                        role="status"
                        aria-live="polite"
                      >
                        <div className="run-activity-phase">
                          <WorkingIndicator indicator={workingIndicator} />
                          <span className="working-message">
                            {activityLabel}
                          </span>
                        </div>
                        <div className="run-activity-total">
                          <Clock3 size={13} />{t(" Работаю…")}{" "}
                          <strong>{formatElapsed(elapsed)}</strong>
                        </div>
                      </div>
                    )}
                    {!working && requestPending && (
                      <div className="run-activity" role="status" aria-live="polite">
                        <div className="run-activity-phase">
                          <WorkingIndicator />
                          <span className="working-message">{t("Подготовка запроса…")}</span>
                        </div>
                      </div>
                    )}
                    {!working && !requestPending && snapshot?.run?.error && (
                      <div className="run-error" role="alert">
                        <strong>{t("Работа прервана из-за ошибки")}</strong>
                        <div>{snapshot.run.error}</div>
                      </div>
                    )}
                    {!working && !requestPending && lastDuration !== undefined && (
                      <div className="run-complete">
                        <span>
                          <Clock3 size={13} />{t(" Запрос занял")}{" "}
                          {formatElapsed(lastDuration)}
                        </span>
                        {runDiff && runDiff.files.length > 0 && (
                            <section className="run-diff-card">
                              <div className="run-diff-card-head">
                                <span className="run-diff-card-icon">
                                  <FileText size={16} />
                                </span>
                                <span className="run-diff-card-summary">
                                  <strong>
                                    {runDiff.files.length === 1
                                      ? t("Изменён")
                                      : t("Изменены")}{" "}
                                    {runDiff.files.length}{" "}
                                    {pluralFiles(runDiff.files.length)}
                                  </strong>
                                  <small>
                                    <span className="diff-add">
                                      +{runDiff.additions}
                                    </span>{" "}
                                    <span className="diff-remove">
                                      −{runDiff.deletions}
                                    </span>
                                  </small>
                                </span>
                                <button
                                  className="run-diff-review"
                                  onClick={() => setDiffOpen(true)}
                                >{t("Проверить")}</button>
                              </div>
                              <div className="run-diff-file-list">
                                {runDiff.files.map((file) => (
                                  <div
                                    className="run-diff-file"
                                    key={file.path}
                                    title={file.path}
                                  >
                                    <span>{file.relativePath}</span>
                                    <small>
                                      <span className="diff-add">
                                        +{file.additions}
                                      </span>{" "}
                                      <span className="diff-remove">
                                        −{file.deletions}
                                      </span>
                                    </small>
                                  </div>
                                ))}
                                {runDiff.incomplete && (
                                  <div className="run-diff-incomplete">{t("Некоторые большие или двоичные файлы не показаны.")}</div>
                                )}
                              </div>
                            </section>
                          )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {activeConversationId && planning && planningOpen && <aside className="conversation-plan conversation-notebook" aria-label={t("План реализации текущего чата")}>
                <PlanningPanel key={`planning-${activeConversationId}`} planning={planning} working={working || requestPending} onAction={changePlanning} onClose={() => setPlanningOpen(false)} />
              </aside>}
              {activeConversationId && snapshot && notebookOpen && !planningOpen && <aside className="conversation-plan conversation-notebook" aria-label={t("Блокнот текущего чата")}>
                <NotebookPanel key={`notebook-${activeConversationId}`} conversationId={activeConversationId} notebook={snapshot.conversation.notebook} open={notebookOpen} onClose={() => setNotebookOpen(false)} />
              </aside>}
              {activeConversationId && skillsOpen && <SkillsPanel key={`skills-${activeConversationId}`} conversationId={activeConversationId} onClose={() => setSkillsOpen(false)} />}
              {activeConversationId && !planMode && !notebookOpen && !planningOpen && snapshot?.conversation.plan?.steps.length ? (
                <aside className="conversation-plan" aria-label={t("План текущего чата")}>
                  <PlanPanel key={`plan-${snapshot.conversation.id}`} conversationId={snapshot.conversation.id} plan={snapshot.conversation.plan} working={planIsWorking(snapshot.conversation.plan, working, snapshot.planWorkingRevision)} />
                </aside>
              ) : null}
              {activeConversationId && !loading && (
                <div
                  className={`composer-wrap${modelMenuOpen || thinkingMenuOpen || addMenuOpen || slashCommands.length > 0 ? " dropdown-open" : ""}`}
                >
                  {showScrollToBottom && (
                    <button
                      className="scroll-to-bottom"
                      type="button"
                      title={t("К концу чата")}
                      aria-label={t("Прокрутить чат до конца")}
                      onClick={() => scrollConversationToBottomSmooth()}
                    >
                      <ArrowDown size={17} />
                    </button>
                  )}
                  {snapshot && !planMode && (
                    <GoalPanel
                      key={snapshot.conversation.id}
                      conversation={snapshot.conversation}
                      working={working}
                    />
                  )}
                  {working && runDiff && runDiff.files.length > 0 && (
                      <div className="live-diff-summary">
                        <button
                          className="diff-summary-chip"
                          onClick={() => setDiffOpen(true)}
                        >{t("Изменено")}{runDiff.files.length}{" "}
                          {pluralFiles(runDiff.files.length)}{" "}
                          <span className="diff-add">+{runDiff.additions}</span>{" "}
                          <span className="diff-remove">
                            −{runDiff.deletions}
                          </span>
                        </button>
                      </div>
                    )}
                  {slashCommands.length > 0 && (
                    <div className="slash-menu">
                      {slashCommands.map((command) => (
                        <button
                          key={`${command.source}-${command.name}`}
                          onClick={() => setInput(`/${command.name} `)}
                        >
                          <span>
                            <strong>/{command.name}</strong>
                            <small>
                              {command.source === "builtin" ? t(command.description ?? command.source) : command.description ?? command.source}
                            </small>
                          </span>
                          <em>{command.source}</em>
                        </button>
                      ))}
                    </div>
                  )}
                  {queuedPrompts.length > 0 && (
                    <div className="queued-messages desktop-queue">
                      <div className="queued-head">
                        <span>{t("Ожидают отправки:")}{" "}{queuedPrompts.length}</span>
                      </div>
                      {queuedPrompts.map((prompt) => (
                        <div className="queued-message" key={prompt.id}>
                          <Clock3 size={13} />
                          <span title={prompt.message}>{prompt.message}</span>
                          {prompt.attachments.length > 0 && (
                            <small>{prompt.attachments.length}{t(" влож.")}</small>
                          )}
                          <div className="queued-actions">
                            <button
                              className="queued-send"
                              title={t("Передать сообщение модели")}
                              disabled={Boolean(queuedActionId)}
                              onClick={() => void sendQueuedPrompt(prompt)}
                            >
                              <Zap size={13} />
                              <span>{t("Скорректировать")}</span>
                            </button>
                            <button
                              title={t("Вернуть в поле ввода")}
                              disabled={Boolean(queuedActionId)}
                              onClick={() => void editQueuedPrompt(prompt)}
                            >
                              <Pencil size={13} />
                            </button>
                            <button
                              title={t("Удалить из очереди")}
                              disabled={Boolean(queuedActionId)}
                              onClick={() => void deleteQueuedPrompt(prompt.id)}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {(steeringMessages.length > 0 ||
                    followUpMessages.length > 0) && (
                    <div className="queued-messages">
                      <div className="queued-head">
                        <span>{t("Очередь Pi:")}{" "}
                          {steeringMessages.length + followUpMessages.length}
                        </span>
                        <button onClick={() => void restoreQueuedMessages()}>{t("Вернуть в редактор")}</button>
                      </div>
                      {steeringMessages.map((message, index) => (
                        <div
                          className="queued-message steer"
                          key={`steer-${index}`}
                        >
                          <Zap size={13} />
                          <span>{message}</span>
                          <small>{t("в текущую работу")}</small>
                        </div>
                      ))}
                      {followUpMessages.map((message, index) => (
                        <div className="queued-message" key={`follow-${index}`}>
                          <Clock3 size={13} />
                          <span>{message}</span>
                          <small>{t("следом")}</small>
                        </div>
                      ))}
                    </div>
                  )}
                  {widgets
                    .filter((widget) => widget.placement === "aboveEditor")
                    .map((widget) => (
                      <div className="extension-widget" key={widget.key}>
                        {widget.lines.map((line, index) => (
                          <div key={`${index}-${line}`}>{line}</div>
                        ))}
                      </div>
                    ))}
                  <div className="composer">
                    {historyQuotes.length > 0 && (
                      <div className="history-quote-list" aria-label={t("Цитаты из переписки")}>
                        {historyQuotes.map((quote, index) => (
                          <div className="history-quote" key={index}>
                            <blockquote title={quote}>{quote}</blockquote>
                            <button type="button" title={t("Убрать цитату")} aria-label={t("Убрать цитату")}
                              onClick={() => setHistoryQuotes(current => current.filter((_, i) => i !== index))}>
                              <X size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {attachments.length > 0 && (
                      <div className="attachment-list">
                        {attachments.map((attachment) => {
                          const remove = () =>
                            setAttachments((current) =>
                              current.filter(
                                (item) => item.id !== attachment.id && item.maskFor !== attachment.id,
                              ),
                            );
                          if (
                            attachment.mimeType?.startsWith("image/") &&
                            attachment.data
                          ) {
                            return (
                              <div
                                className="attachment-preview"
                                key={attachment.id}
                                title={attachment.name}
                              >
                                <PreviewImage
                                  src={`data:${attachment.mimeType};base64,${attachment.data}`}
                                  alt={attachment.name}
                                />
                                {!attachment.maskFor && <button className="attachment-mask-button" type="button" title={t("Нарисовать маску")} onClick={() => setMaskTarget(attachment)}>{t("Маска")}</button>}
                                {attachment.maskFor && <span className="attachment-mask-label">{t("Маска")}</span>}
                                <button
                                  type="button"
                                  title={t("Удалить изображение")}
                                  aria-label={t("Удалить {0}", attachment.name)}
                                  onClick={remove}
                                >
                                  <X size={13} />
                                </button>
                              </div>
                            );
                          }
                          return (
                            <div
                              className="attachment-chip"
                              key={attachment.id}
                              title={attachment.path}
                            >
                              <Paperclip size={13} />
                              <span>{attachment.name}</span>
                              <button
                                type="button"
                                title={t("Удалить вложение")}
                                aria-label={t("Удалить {0}", attachment.name)}
                                onClick={remove}
                              >
                                <X size={13} />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    <textarea
                      ref={composerInputRef}
                      value={input}
                      onChange={(event) => setInput(event.target.value)}
                      onPaste={(event) => {
                        const imageFiles = [
                          ...event.clipboardData.files,
                        ].filter((file) => file.type.startsWith("image/"));
                        if (!imageFiles.length) return;
                        event.preventDefault();
                        void Promise.all(imageFiles.map(pastedImageAttachment))
                          .then((items) =>
                            setAttachments((current) => [...current, ...items]),
                          )
                          .catch((error) =>
                            addNotice(
                              error instanceof Error
                                ? error.message
                                : String(error),
                              "error",
                            ),
                          );
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          void submit();
                        }
                      }}
                      placeholder={
                        working
                          ? t("Сообщение будет добавлено в очередь…")
                          : goalMode
                            ? t("Опишите цель")
                            : t("Спросите что-нибудь или опишите задачу")
                      }
                      rows={2}
                    />
                    <div className="composer-toolbar">
                      <div className="composer-add-wrap">
                        <button
                          className="icon-button"
                          title={t("Добавить")}
                          onClick={() => {
                            setModelMenuOpen(false);
                            setThinkingMenuOpen(false);
                            setAddMenuOpen((value) => !value);
                          }}
                        >
                          <Plus size={19} />
                        </button>
                        {addMenuOpen && (
                          <div className="composer-add-menu">
                            <button
                              onClick={() => {
                                setAddMenuOpen(false);
                                void addAttachments();
                              }}
                            >
                              <Paperclip size={16} />
                              <span>
                                <strong>{t("Файлы и папки")}</strong>
                                <small>{t("Добавить вложения")}</small>
                              </span>
                            </button>
                            <button
                              disabled={
                                working || planMode || Boolean(snapshot?.conversation.goal)
                              }
                              onClick={() => {
                                setAddMenuOpen(false);
                                setGoalMode(true);
                              }}
                            >
                              <Target size={16} />
                              <span>
                                <strong>{t("Цель")}</strong>
                                <small>{t("Поставьте цель, к которой будете двигаться")}</small>
                              </span>
                            </button>
                            <button aria-pressed={planMode} disabled={working || requestPending} onClick={() => { setAddMenuOpen(false); void changePlanning(planMode ? "cancel" : "start", planning?.revision ?? 0).catch(error => addNotice(String(error), "error")); }}>
                              <ListChecks size={16} />
                              <span><strong>{t("План")}</strong><small>{t("Изучить задачу и согласовать план · только чтение")}</small></span>
                              {planMode && <Check size={14} />}
                            </button>
                          </div>
                        )}
                      </div>
                      <button
                        className="icon-button"
                        title={t("Команды Pi (Ctrl+Shift+P)")}
                        onClick={() => setCommandPaletteOpen(true)}
                      >
                        <SquareTerminal size={17} />
                      </button>
                      <span className="access-chip">
                        <Check size={13} /> {planMode ? t("План · только чтение") : t("Полный доступ")}
                      </span>
                      {goalMode && (
                        <button
                          className="goal-mode-chip"
                          title={t("Отключить режим цели")}
                          onClick={() => setGoalMode(false)}
                        >
                          <Target size={14} />{t(" Цель")}{" "}<X size={12} />
                        </button>
                      )}
                      {planMode && <button className="goal-mode-chip" title={t("Открыть план для согласования")}
                        onClick={() => { setPlanningOpen(true); setNotebookOpen(false); setSkillsOpen(false); }}><ListChecks size={14} />{planning?.phase === "review" ? t("Согласование плана") : t("Планирование")}</button>}
                      <div className="composer-spacer" />
                      <div className="dropdown-wrap model-dropdown-wrap">
                        <button
                          className="selector-button model-selector-button"
                          title={
                            snapshot?.state.model?.name ??
                            snapshot?.state.model?.id ??
                            t("Модель")
                          }
                          onClick={() => {
                            setThinkingMenuOpen(false);
                            setModelMenuOpen((value) => !value);
                            void window.piDesktop.getModelServers().catch(() => undefined);
                          }}
                        >
                          <span className="selector-label">
                            {snapshot?.state.model?.name ??
                              snapshot?.state.model?.id ??
                              t("Модель")}
                          </span>
                          <ChevronDown size={13} />
                        </button>
                        {modelMenuOpen && (
                          <div className="dropdown-menu model-menu">
                            {snapshot?.models.map((model) => (
                              <button
                                key={`${model.provider}/${model.id}`}
                                className="dropdown-item"
                                onClick={() => void changeModel(model)}
                              >
                                <span>
                                  <strong>{model.name ?? model.id}</strong>
                                  <small>{model.provider}</small>
                                </span>
                                {snapshot.state.model?.provider ===
                                  model.provider &&
                                  snapshot.state.model?.id === model.id && (
                                    <Check size={15} />
                                  )}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="dropdown-wrap thinking-dropdown-wrap">
                        <button
                          className="selector-button thinking-selector-button"
                          title={t("Уровень рассуждений")}
                          onClick={() => {
                            setModelMenuOpen(false);
                            setThinkingMenuOpen((value) => !value);
                          }}
                        >
                          <span className="selector-label">
                            {
                              t(THINKING_LABELS[
                                snapshot?.state.thinkingLevel ?? "off"
                              ])
                            }
                          </span>
                          <ChevronDown size={13} />
                        </button>
                        {thinkingMenuOpen && (
                          <div className="dropdown-menu thinking-menu">
                            {snapshot?.thinkingLevels.map((level) => (
                              <button
                                key={level}
                                className="dropdown-item"
                                onClick={() => void changeThinking(level)}
                              >
                                <span>{t(THINKING_LABELS[level])}</span>
                                {snapshot.state.thinkingLevel === level && (
                                  <Check size={15} />
                                )}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      {working ? (
                        <>
                          <button
                            className="send-button"
                            title={t("Поставить в очередь")}
                            disabled={!input.trim() && !attachments.length && !historyQuotes.length}
                            onClick={() => void submit()}
                          >
                            <Send size={17} />
                          </button>
                          <button
                            className="send-button stop"
                            title={t("Остановить")}
                            onClick={() =>
                              void window.piDesktop.abort(activeConversationId).catch(error => addNotice(String(error), "error"))
                            }
                          >
                            <CircleStop size={18} />
                          </button>
                        </>
                      ) : (
                        <button
                          className={`send-button${primaryAction === "resume" ? " resume" : ""}`}
                          title={primaryAction === "resume" ? t("Продолжить прерванную работу") : t("Отправить")}
                          aria-label={primaryAction === "resume" ? t("Продолжить") : t("Отправить")}
                          aria-busy={requestPending}
                          disabled={requestPending || (primaryAction !== "resume" && !input.trim() && !attachments.length && !historyQuotes.length)}
                          onClick={() => void submit()}
                        >
                          {primaryAction === "resume" ? <><Play size={17} /><span>{t("Продолжить")}</span></> : <Send size={17} />}
                        </button>
                      )}
                    </div>
                  </div>
                  {widgets
                    .filter((widget) => widget.placement === "belowEditor")
                    .map((widget) => (
                      <div className="extension-widget below" key={widget.key}>
                        {widget.lines.map((line, index) => (
                          <div key={`${index}-${line}`}>{line}</div>
                        ))}
                      </div>
                    ))}
                  <div className="status-line">
                    {snapshot?.state.contextUsage && (
                      <span className="status-item status-context">
                        <Gauge size={14} />{t(" Контекст:")}{" "}
                        {snapshot.state.contextUsage.tokens === null
                          ? "—"
                          : formatTokens(
                              snapshot.state.contextUsage.tokens,
                            )}{" "}
                        /{" "}
                        {formatTokens(
                          snapshot.state.contextUsage.contextWindow,
                        )}
                        {snapshot.state.contextUsage.percent === null
                          ? ""
                          : ` (${Math.round(snapshot.state.contextUsage.percent)}%)`}
                      </span>
                    )}
                    {statuses.tokenSpeed && (
                      <span
                        className="status-item"
                        key="tokenSpeed"
                        title={statuses.tokenSpeed}
                      >
                        {statuses.tokenSpeed}
                      </span>
                    )}
                    {Object.entries(statuses)
                      .filter(([key]) => key !== "tokenSpeed")
                      .map(([key, status]) => (
                        <span className="status-item" key={key} title={status}>
                          {status}
                        </span>
                      ))}
                    {snapshot?.state.isCompacting && (
                      <span className="status-item compacting">
                        <span className="spinner" />{t(" Сжатие контекста")}</span>
                    )}
                  </div>
                </div>
              )}
            </main>
            {diffOpen && runDiff && (
              <DiffPanel diff={runDiff} onClose={() => setDiffOpen(false)} />
            )}
          </>
        )}
      </div>

      <div className="toast-stack">
        {notices.map((notice) => (
          <div key={notice.id} className={`toast ${notice.type}`}>
            {notice.message}
          </div>
        ))}
      </div>
      {extensionDialog && (
        <ExtensionDialog
          item={extensionDialog}
          onClose={() => setExtensionDialog(undefined)}
        />
      )}
      {projectDialogOpen && (
        <ProjectDialog
          onClose={() => setProjectDialogOpen(false)}
          onCreated={(project) => void projectCreated(project)}
          onError={(message) => addNotice(message, "error")}
        />
      )}
      {historyAction && (
        <div className="modal-backdrop" onKeyDown={event => {
          if (event.key === "Escape" && !historyBusy) setHistoryAction(undefined);
        }}>
          <div className="modal-card history-action-dialog" role="dialog" aria-modal="true" aria-labelledby="history-action-title">
            <div className="modal-head">
              <strong id="history-action-title">{historyAction.mode === "edit" ? t("Изменить последнее сообщение") : t("Откатить сессию?")}</strong>
              <button className="icon-button" aria-label={t("Закрыть")} disabled={historyBusy} onClick={() => setHistoryAction(undefined)}><X size={17} /></button>
            </div>
            {historyAction.mode === "edit" ? (
              <textarea className="modal-editor" aria-label={t("Текст сообщения")} autoFocus disabled={historyBusy}
                value={historyAction.text} onChange={event => setHistoryAction({ ...historyAction, text: event.target.value })} />
            ) : <blockquote className="history-rewind-preview">{historyAction.text.slice(0, 500) || t("Сообщение с вложением")}</blockquote>}
            <p>{historyAction.mode === "edit"
              ? t("Этот запрос и последующие ответы будут заменены в текущей ветке. Изображения сохранятся. После отправки модель ответит заново.")
              : t("Выбранное сообщение останется, последующие сообщения исчезнут из текущего контекста.")}</p>
            <p>{t("Предыдущая ветка сохранится в файле сессии. Цель и очередь сообщений будут сброшены. Выполненные команды, изменения файлов и созданные медиа не отменяются.")}</p>
            <div className="modal-actions">
              <button disabled={historyBusy} onClick={() => setHistoryAction(undefined)}>{t("Отмена")}</button>
              <button className="primary" disabled={working || historyBusy || (historyAction.mode === "edit" && !historyAction.text.trim())}
                onClick={() => void confirmHistoryAction()}>
                {historyBusy ? t("Применяю…") : historyAction.mode === "edit" ? t("Отправить исправленный запрос") : t("Откатить")}
              </button>
            </div>
          </div>
        </div>
      )}
      {historyMenu && (
        <div className="context-menu-layer" onPointerDown={() => setHistoryMenu(undefined)}
          onContextMenu={(event) => { event.preventDefault(); setHistoryMenu(undefined); }}>
          <div className="conversation-menu history-context-menu" role="menu" aria-label={t("Выделенный текст")}
            style={{ left: historyMenu.x, top: historyMenu.y }}
            onPointerDown={(event) => { event.stopPropagation(); event.preventDefault(); }}>
            <button role="menuitem" onClick={() => {
              const text = historyMenu.text;
              setHistoryMenu(undefined);
              void navigator.clipboard.writeText(text).catch(error => addNotice(String(error), "error"));
            }}>{t("Копировать")}</button>
            <button role="menuitem" onClick={() => {
              setHistoryQuotes(current => [...current, historyMenu.text]);
              setHistoryMenu(undefined);
              composerInputRef.current?.focus();
            }}>{t("Добавить в чат")}</button>
            <button role="menuitem" onClick={() => {
              const text = historyMenu.text;
              setHistoryMenu(undefined);
              void submit(text);
            }}>{t("Подробнее")}</button>
          </div>
        </div>
      )}
      {projectMenu &&
        (() => {
          const project = projects.find(
            (item) => item.id === projectMenu.projectId,
          );
          if (!project) return null;
          return (
            <div
              className="context-menu-layer"
              onPointerDown={() => setProjectMenu(undefined)}
            >
              <div
                className="conversation-menu project-context-menu"
                style={{ left: projectMenu.x, top: projectMenu.y }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <button
                  onClick={() => {
                    setRenameProject(project);
                    setProjectMenu(undefined);
                  }}
                >
                  <Pencil size={15} />{t(" Переименовать")}</button>
                <button
                  onClick={() => {
                    setInstructionsProject(project);
                    setProjectMenu(undefined);
                  }}
                >
                  <FileText size={15} />{t(" Редактировать инструкции проекта")}</button>
                <button
                  onClick={() => {
                    void window.piDesktop.showItemInFolder(project.path);
                    setProjectMenu(undefined);
                  }}
                >
                  <FolderOpen size={15} />{t(" Показать папку")}</button>
                <button
                  onClick={() => {
                    void newChat(project.id);
                    setProjectMenu(undefined);
                  }}
                >
                  <MessageSquarePlus size={15} />{t(" Новый чат")}</button>
                <div className="conversation-menu-separator" />
                <button
                  className="danger"
                  onClick={() => void removeProject(project.id)}
                >
                  <Trash2 size={15} />{t(" Убрать проект")}</button>
              </div>
            </div>
          );
        })()}
      {conversationMenu &&
        (() => {
          const conversation = conversations.find(
            (item) => item.id === conversationMenu.conversationId,
          );
          if (!conversation) return null;
          return (
            <div
              className="context-menu-layer"
              onPointerDown={() => setConversationMenu(undefined)}
            >
              <div
                className="conversation-menu"
                style={{ left: conversationMenu.x, top: conversationMenu.y }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                <button
                  onClick={() => {
                    setRenameConversation(conversation);
                    setConversationMenu(undefined);
                  }}
                >
                  <Pencil size={15} />{t(" Переименовать")}</button>
                <button onClick={() => void archiveChat(conversation.id)}>
                  <Archive size={15} />{t(" Архивировать")}</button>
                <div className="conversation-menu-separator" />
                <button
                  className="danger"
                  onClick={() => void deleteChat(conversation.id)}
                >
                  <Trash2 size={15} />{t(" Удалить")}</button>
              </div>
            </div>
          );
        })()}
      {renameConversation && (
        <RenameConversationDialog
          title={renameConversation.title}
          onClose={() => setRenameConversation(undefined)}
          onSave={(title) => void saveConversationTitle(title)}
        />
      )}
      {renameProject && (
        <RenameConversationDialog
          heading={t("Переименовать проект")}
          title={renameProject.name}
          onClose={() => setRenameProject(undefined)}
          onSave={(title) => void saveProjectTitle(title)}
        />
      )}
      {instructionsProject && (
        <ProjectInstructionsDialog
          project={instructionsProject}
          onClose={() => setInstructionsProject(undefined)}
        />
      )}
      {commandPaletteOpen && snapshot && (
        <CommandPalette
          commands={snapshot.commands}
          busy={working}
          onClose={() => setCommandPaletteOpen(false)}
          onCompact={() => {
            setCommandPaletteOpen(false);
            setCompactDialogOpen(true);
          }}
          onReload={() => void executeReload()}
          onInsert={insertCommand}
        />
      )}
      {compactDialogOpen && (
        <CompactDialog
          onClose={() => setCompactDialogOpen(false)}
          onCompact={(instructions) => void executeCompact(instructions)}
        />
      )}
    </div>
  );
}

function formatElapsed(milliseconds: number): string {
  const total = Math.floor(milliseconds / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours)
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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
  return stripTerminalCodes(value).replace(/\s+/g, " ").trim();
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
  if (getLanguage() === "en") return count === 1 ? "file" : "files";
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return t("файлов");
  if (last === 1) return t("файл");
  if (last >= 2 && last <= 4) return t("файла");
  return t("файлов");
}

function pluralModels(count: number): string {
  if (getLanguage() === "en") return count === 1 ? "model" : "models";
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return t("моделей");
  if (last === 1) return t("модель");
  if (last >= 2 && last <= 4) return t("модели");
  return t("моделей");
}

function extensionName(extensionPath: string): string {
  const parts = extensionPath.replace(/\\/g, "/").split("/").filter(Boolean);
  const extensionIndex = parts.lastIndexOf("extensions");
  if (extensionIndex >= 0 && parts[extensionIndex + 1])
    return parts[extensionIndex + 1];
  return parts.at(-2) ?? parts.at(-1) ?? extensionPath;
}

async function pastedImageAttachment(file: File): Promise<Attachment> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (!context)
    throw new Error(t("Не удалось подготовить изображение из буфера обмена"));
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const png = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error(t("Не удалось преобразовать изображение в PNG"))),
      "image/png",
    );
  });
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(
        reader.error ??
          new Error(t("Не удалось прочитать изображение из буфера обмена")),
      );
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(png);
  });
  const separator = dataUrl.indexOf(",");
  if (separator < 0)
    throw new Error(t("Некорректное изображение в буфере обмена"));
  const sourceName =
    file.name?.replace(/\.[^.]+$/, "") || `clipboard-${Date.now()}`;
  const name = `${sourceName}.png`;
  return {
    id: crypto.randomUUID(),
    name,
    path: `clipboard:${name}`,
    mimeType: "image/png",
    data: dataUrl.slice(separator + 1),
  };
}
