import { MediaLink } from "./MediaLink";
import { t } from "./i18n";
import { createContext } from "react";
import type { CitationSource } from "./web-citations";

type Source = { url: string; title: string; status: string; anchor?: string; kind?: string; date?: string; preview?: string; reason?: string };
type ToolSources = { name: string; result?: unknown }[];

export const WebCitations = createContext<ReadonlyMap<string, CitationSource>>(new Map());

export function webSearchDetails(result: unknown): { phase?: string; sources?: Source[] } | undefined {
  if (!result || typeof result !== "object") return;
  return (result as { details?: { webResearch?: { phase?: string; sources?: Source[] } } }).details?.webResearch;
}

export function collectWebSearchSources(tools: ToolSources): Source[] {
  const byUrl = new Map<string, Source>();
  for (const tool of tools) {
    if (tool.name !== "web_search") continue;
    for (const source of webSearchDetails(tool.result)?.sources ?? []) {
      if (!byUrl.has(source.url) || source.status === "read") byUrl.set(source.url, source);
    }
  }
  return [...byUrl.values()];
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
  if (source.status === "read") return t("Страница прочитана");
  if (source.status === "snippet") return t("Фрагмент из выдачи");
  if (source.kind === "image") return t("Изображение");
  if (source.kind === "ref") return t("Видео");
  return t("Страница недоступна");
}

export function WebSearchSources({ sources }: { sources: Source[] }) {
  return <ol className="web-search-sources" aria-label={t("Источники")}>
    {sources.map((source, index) => (
      <li key={`${index}:${source.url}`}>
        <MediaLink href={/^https?:\/\//i.test(source.url) ? source.url : undefined}>{source.title || source.url}</MediaLink>
        <small>{[source.kind === "news" ? t("Новости") : "", sourceStatus(source), source.date].filter(Boolean).join(" · ")}</small>
        {source.preview && <p>{source.preview}</p>}
        {source.reason && <small>{source.reason}</small>}
      </li>
    ))}
  </ol>;
}
