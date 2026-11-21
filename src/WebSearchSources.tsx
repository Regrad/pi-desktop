import { MediaLink } from "./MediaLink";
import { t } from "./i18n";

type Source = { url: string; title: string; status: string; preview?: string; reason?: string };

export function webSearchDetails(result: unknown): { phase?: string; sources?: Source[] } | undefined {
  if (!result || typeof result !== "object") return;
  return (result as { details?: { webResearch?: { phase?: string; sources?: Source[] } } }).details?.webResearch;
}

export function collectWebSearchSources(tools: { name: string; result?: unknown }[]): Source[] {
  const byUrl = new Map<string, Source>();
  for (const tool of tools) {
    if (tool.name !== "web_search") continue;
    for (const source of webSearchDetails(tool.result)?.sources ?? []) {
      if (!byUrl.has(source.url) || source.status === "read") byUrl.set(source.url, source);
    }
  }
  return [...byUrl.values()];
}

export function WebSearchSources({ sources }: { sources: Source[] }) {
  return <ol className="web-search-sources" aria-label={t("Источники")}>
    {sources.map((source, index) => (
      <li key={`${index}:${source.url}`}>
        <MediaLink href={/^https?:\/\//i.test(source.url) ? source.url : undefined}>{source.title || source.url}</MediaLink>
        <small>{source.status === "read" ? t("Страница прочитана") : source.status === "snippet" ? t("Фрагмент из выдачи") : t("Страница недоступна")}</small>
        {(source.preview || source.reason) && <p>{source.preview || source.reason}</p>}
      </li>
    ))}
  </ol>;
}
