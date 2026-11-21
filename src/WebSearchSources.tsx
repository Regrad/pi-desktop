import { MediaLink } from "./MediaLink";
import { t } from "./i18n";
import { createContext, useId, useRef, useState } from "react";
import { Check, ChevronRight, Globe, Link2, Search } from "lucide-react";
import type { CitationSource } from "./web-citations";

type Source = { url: string; title: string; status: string; anchor?: string; kind?: string; date?: string; preview?: string; reason?: string };
type ToolSources = { name: string; result?: unknown }[];
type SearchCall = {
  id: string;
  result?: unknown;
  args: { query?: unknown; url?: unknown };
  running: boolean;
  preparing?: boolean;
  error?: boolean;
  output: string;
};
type SearchReport = {
  phase?: string;
  query?: string;
  url?: string;
  provider?: string;
  scraper?: string;
  reranker?: string;
  completed?: number;
  total?: number;
  sources?: Source[];
};
const providerNames: Record<string, string> = {
  cohere: "Cohere", firecrawl: "Firecrawl", jina: "Jina", keenable: "Keenable", searxng: "SearXNG",
  serper: "Serper", tavily: "Tavily",
};

export const WebCitations = createContext<ReadonlyMap<string, CitationSource>>(new Map());

function webSearchDetails(result: unknown): SearchReport | undefined {
  if (!result || typeof result !== "object") return;
  return (result as { details?: { webResearch?: SearchReport } }).details?.webResearch;
}

export function indexWebCitations(tools: ToolSources): Map<string, CitationSource> {
  const byAnchor = new Map<string, CitationSource>();
  const numbers = new Map<string, number>();
  for (const tool of tools) {
    if (tool.name !== "web_search") continue;
    for (const source of webSearchDetails(tool.result)?.sources ?? []) {
      if (!source.anchor) continue;
      const number = numbers.get(source.url) ?? numbers.size + 1;
      numbers.set(source.url, number);
      byAnchor.set(source.anchor, { url: source.url, title: source.title, number });
    }
  }
  return byAnchor;
}

function sourceStatus(source: Source): string {
  if (source.status === "reading") return t("Открывается…");
  if (source.status === "read") return t("Страница прочитана");
  if (source.status === "snippet") return t("Фрагмент из выдачи");
  if (source.kind === "image") return t("Изображение");
  if (source.kind === "ref") return t("Видео");
  return t("Страница недоступна");
}

function domain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./i, ""); }
  catch { return ""; }
}

function WebSearchSources({ sources }: { sources: Source[] }) {
  return <ol className="web-search-sources" aria-label={t("Источники")}>
    {sources.map(source => (
      <li key={source.url}>
        <div className="web-source-copy">
          <MediaLink href={/^https?:\/\//i.test(source.url) ? source.url : undefined}>{source.title || domain(source.url) || source.url}</MediaLink>
          <small>{domain(source.url)}</small>
        </div>
        <span className="web-source-state" data-status={source.status}>
          {source.status === "read" && <Check size={13} aria-hidden="true" />}{sourceStatus(source)}
        </span>
      </li>
    ))}
  </ol>;
}

const sourcePriority: Record<string, number> = { read: 4, reading: 3, snippet: 2, result: 1, unavailable: 0 };

export function WebSearchActivity({ calls }: { calls: SearchCall[] }) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const reports = calls.map(call => webSearchDetails(call.result));
  const waitingFor = calls.findIndex(call => call.running || call.preparing);
  const active = waitingFor !== -1;
  const report = reports[active ? waitingFor : reports.length - 1];
  const phase = report?.phase;
  const error = calls.every(call => call.error);
  const interrupted = !active && calls.every(call => !call.output);
  const label = active ? phase === "reading" ? t("Чтение источников…") : phase === "ranking" ? t("Отбор выдержек…") : t("Поиск в интернете…")
    : error ? t("Ошибка веб-поиска") : interrupted ? t("Поиск прерван") : t("Поиск завершён");
  const provider = providerNames[(report?.provider || report?.scraper) ?? ""];
  const unique = new Map<string, Source>();
  for (const result of reports) {
    for (const source of result?.sources ?? []) {
      const previous = unique.get(source.url);
      if (!previous || (sourcePriority[source.status] ?? 0) > (sourcePriority[previous.status] ?? 0)) unique.set(source.url, source);
    }
  }
  const sources = [...unique.values()];
  const readDomains = new Map<string, Source>();
  for (const source of sources) {
    const host = domain(source.url);
    if (host && source.status === "read" && /^https?:\/\//i.test(source.url) && !readDomains.has(host)) readDomains.set(host, source);
  }
  const targets = [...new Set(calls.map((call, index) => {
    const result = reports[index];
    return result?.url || (typeof call.args.url === "string" ? call.args.url : "") ||
      result?.query || (typeof call.args.query === "string" ? call.args.query : "");
  }).filter(Boolean))];
  const Icon = active ? Search : Globe;
  return <div className={`web-activity ${active ? "live" : "settled"}`}>
    <button className="web-activity-heading" type="button" popoverTarget={id} aria-expanded={open} aria-controls={id}
      onClick={event => {
        const bounds = event.currentTarget.getBoundingClientRect();
        const below = window.innerHeight - bounds.bottom - 14;
        const above = bounds.top - 14;
        panel.current?.style.setProperty("--source-left", `${Math.max(8, Math.min(bounds.left, window.innerWidth - 444))}px`);
        panel.current?.style.setProperty("--source-edge", `${below >= Math.min(250, above) ? bounds.bottom + 6 : window.innerHeight - bounds.top + 6}px`);
        panel.current?.style.setProperty("--source-height", `${Math.max(72, Math.min(300, Math.max(above, below)))}px`);
        if (panel.current) panel.current.dataset.side = below >= Math.min(250, above) ? "below" : "above";
      }}>
      <span className="web-activity-icon" aria-hidden="true"><Icon size={15} /></span>
      <span className="web-activity-label" aria-live="polite">{label}</span>
      {sources.length > 0 && <small className="web-activity-count">{t("Источники")} · {sources.length}</small>}
      <ChevronRight className="web-activity-chevron" size={13} aria-hidden="true" />
    </button>
    <div className="web-activity-sites" aria-label={t("Прочитанные сайты")}>
      {[...readDomains].slice(0, 2).map(([host, source]) => <MediaLink key={host} href={source.url} title={source.title || host}>{host}</MediaLink>)}
    </div>
    <div id={id} ref={panel} popover="auto" className="web-activity-details" aria-label={t("Источники")}
      onToggle={event => setOpen(event.currentTarget.matches(":popover-open"))}>
      <div className="web-activity-panel-head"><strong>{t("Источники")}</strong>{provider && <small>{provider}</small>}</div>
      {targets.length > 0 && <p className="web-activity-target" dir="auto">{targets.join(" · ")}</p>}
      {sources.length > 0 ? <WebSearchSources sources={sources} /> : <p className="web-activity-target">
        {active ? t("Источники появятся после поиска") : error ? calls.find(call => call.error)?.output : t("Источники не найдены")}
      </p>}
    </div>
  </div>;
}
