import { MediaLink } from "./MediaLink";
import { t } from "./i18n";
import { createContext } from "react";
import { Check, ChevronRight, Globe, Link2, Search } from "lucide-react";
import type { CitationSource } from "./web-citations";

type Source = { url: string; title: string; status: string; anchor?: string; kind?: string; date?: string; preview?: string; reason?: string };
type ToolSources = { name: string; result?: unknown }[];
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
    {sources.map((source, index) => (
      <li key={`${source.kind}:${index}`}>
        <span className="web-source-icon" aria-hidden="true"><Link2 size={14} /></span>
        <div className="web-source-copy">
          <MediaLink href={/^https?:\/\//i.test(source.url) ? source.url : undefined}>{source.title || domain(source.url) || source.url}</MediaLink>
          <small>{[domain(source.url), source.kind === "news" ? t("Новости") : "", source.date].filter(Boolean).join(" · ")}</small>
          {source.preview && <p>{source.preview}</p>}
          {source.reason && <small>{source.reason}</small>}
        </div>
        <span className="web-source-state" data-status={source.status}>
          {source.status === "read" && <Check size={13} aria-hidden="true" />}{sourceStatus(source)}
        </span>
      </li>
    ))}
  </ol>;
}

export function WebSearchActivity({ result, args, running, preparing, error, output }: {
  result?: unknown;
  args: { query?: unknown; url?: unknown };
  running: boolean;
  preparing?: boolean;
  error?: boolean;
  output: string;
}) {
  const report = webSearchDetails(result);
  const sources = report?.sources ?? [];
  const query = report?.query || (typeof args.query === "string" ? args.query : "");
  const url = report?.url || (typeof args.url === "string" ? args.url : "");
  const active = running || preparing;
  const phase = report?.phase;
  const interrupted = phase ? phase !== "done" : !output;
  const label = active
    ? preparing ? t("Готовлю поиск…") : phase === "ranking" ? t("Отбор выдержек…") :
      phase === "reading" || url ? t("Чтение источников…") : t("Поиск в интернете…")
    : error ? t("Ошибка веб-поиска") : interrupted ? t("Поиск прерван") :
      url ? t("Страница проверена") : t("Поиск завершён");
  const provider = providerNames[(phase === "reading" ? report?.scraper : phase === "ranking" ? report?.reranker : report?.provider || report?.scraper) ?? ""];
  const Icon = url ? Link2 : active ? Search : Globe;
  const header = <>
    <span className="web-activity-icon" aria-hidden="true"><Icon size={15} /></span>
    <span className="web-activity-label">{label}</span>
    {provider && <small>{provider}</small>}
  </>;
  const target = <>
    {query && <span className="web-activity-target" dir="auto">{query}</span>}
    {url && <span className="web-activity-target" dir="auto">{url}</span>}
  </>;

  if (active) return (
    <section className="web-activity live" aria-label={t("Веб-поиск")}>
      <div className="web-activity-heading" role="status">
        {header}
        {phase === "reading" && report?.total ? <small className="web-activity-count">{report.completed ?? 0}/{report.total}</small> : null}
      </div>
      {target}
      {sources.length > 0 && <WebSearchSources sources={sources} />}
    </section>
  );

  return <details className="web-activity settled">
    <summary className="web-activity-heading">
      {header}
      {sources.length > 0 && <small className="web-activity-count">{t("Источники")} · {sources.length}</small>}
      <ChevronRight className="web-activity-chevron" size={14} aria-hidden="true" />
    </summary>
    <div className="web-activity-details">
      {target}
      {sources.length > 0 && <WebSearchSources sources={sources} />}
      {sources.length === 0 && (output || (phase === "done" && t("Источники не найдены"))) && (
        <p className="web-activity-target">{phase === "done" && !error ? t("Источники не найдены") : output}</p>
      )}
    </div>
  </details>;
}
