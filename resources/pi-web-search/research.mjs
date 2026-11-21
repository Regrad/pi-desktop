import { publicUrl } from "./http.mjs";
import { searchWeb } from "./providers.mjs";
import { scrapePages } from "./scrapers.mjs";
import { excerpts } from "./ranking.mjs";

const maxRead = 5;
const maxResults = 8;
const compact = value => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";

function collect(batches) {
  const seen = new Map();
  const candidates = [];
  for (const { kind, results = [] } of batches) {
    seen.set(kind, seen.get(kind) ?? new Set());
    const used = seen.get(kind);
    for (const result of results) {
      if (used.size >= maxResults) break;
      try {
        const url = publicUrl(result.url).href;
        if (used.has(url) || (kind === "news" && seen.get("search")?.has(url))) continue;
        const index = used.size;
        used.add(url);
        candidates.push({
          kind, url, index, title: compact(result.title).slice(0, 240), snippet: compact(result.snippet).slice(0, 500),
          date: compact(result.date).slice(0, 80), read: (kind === "search" || kind === "news") && index < maxRead,
        });
      } catch { /* Results must identify public web pages. */ }
    }
  }
  return candidates;
}

function sourceResult({ read, snippet, ...source }, page) {
  if (page?.text && read) {
    return { ...source, url: page.url, title: compact(page.title).slice(0, 240) || source.title, status: "read", excerpt: snippet };
  }
  const status = source.kind === "image" || source.kind === "ref" ? "result" : snippet ? "snippet" : "unavailable";
  return { ...source, status, excerpt: snippet, reason: page?.error };
}

export async function researchWeb(input, settings, signal, update, io = { search: searchWeb, scrape: scrapePages, excerpts }) {
  signal?.throwIfAborted();
  const query = (input.query ?? "").trim();
  const report = { query, url: input.url, provider: input.url ? undefined : settings.searchProvider,
    scraper: settings.scraperProvider, reranker: settings.rerankerType };
  let search;
  if (input.url) {
    search = { batches: [{ kind: "search", results: [{ url: publicUrl(input.url).href }] }], errors: [] };
  } else {
    update({ ...report, phase: "searching" });
    search = await io.search({ ...input, query }, settings, signal);
    report.provider = search.provider ?? report.provider;
  }
  const candidates = collect(search.batches);
  const toRead = candidates.filter(result => result.read);
  const finished = new Map();
  const showProgress = (phase, pages) => update({
    ...report, phase, completed: pages.size, total: toRead.length,
    sources: candidates.map(candidate => {
      const { url, title, kind, status } = sourceResult(candidate, pages.get(candidate.url));
      return { url, title, kind, status: candidate.read && !pages.has(candidate.url) ? "reading" : status };
    }),
  });
  let pages = finished;
  if (toRead.length) {
    showProgress("reading", finished);
    pages = await io.scrape(toRead.map(candidate => candidate.url), settings, signal, (url, page) => {
      finished.set(url, page);
      showProgress("reading", finished);
    });
    if (settings.rerankerType !== "none" && query && [...pages.values()].some(page => page.text)) {
      showProgress("ranking", pages);
    }
  }
  const sources = await Promise.all(candidates.map(async candidate => {
    const page = pages.get(candidate.url);
    const source = sourceResult(candidate, page);
    if (source.status !== "read") return source;
    const passages = await io.excerpts(page.text, query, settings, signal, input.url ? 6000 : 1800, Boolean(input.url));
    return { ...source, excerpt: passages.excerpt, reason: passages.fallback };
  }));
  signal?.throwIfAborted();
  return { ...report, phase: "done", sources, errors: search.errors };
}
