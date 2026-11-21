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

export async function researchWeb(input, settings, signal, update, io = { search: searchWeb, scrape: scrapePages, excerpts }) {
  signal?.throwIfAborted();
  const query = (input.query ?? "").trim();
  let search;
  if (input.url) {
    search = { batches: [{ kind: "search", results: [{ url: publicUrl(input.url).href }] }], errors: [] };
  } else {
    update({ phase: "searching", query });
    search = await io.search({ ...input, query }, settings, signal);
  }
  const candidates = collect(search.batches);
  const toRead = candidates.filter(result => result.read);
  let pages = new Map();
  if (toRead.length) {
    update({ phase: "reading", query, provider: search.provider, total: toRead.length });
    pages = await io.scrape(toRead.map(candidate => candidate.url), settings, signal);
    if (settings.rerankerType !== "none" && query && [...pages.values()].some(page => page.text)) {
      update({ phase: "ranking", query, provider: search.provider, total: toRead.length });
    }
  }
  const sources = await Promise.all(candidates.map(async ({ read, snippet, ...candidate }) => {
    const page = pages.get(candidate.url);
    if (!page?.text || !read) {
      const status = candidate.kind === "image" || candidate.kind === "ref" ? "result" : snippet ? "snippet" : "unavailable";
      return { ...candidate, status, excerpt: snippet, reason: page?.error };
    }
    const passages = await io.excerpts(page.text, query, settings, signal, input.url ? 6000 : 1800, Boolean(input.url));
    return {
      ...candidate, url: page.url, title: compact(page.title).slice(0, 240) || candidate.title, status: "read",
      excerpt: passages.excerpt, reason: passages.fallback,
    };
  }));
  signal?.throwIfAborted();
  return { phase: "done", query, provider: search.provider, scraper: settings.scraperProvider, reranker: settings.rerankerType, sources, errors: search.errors };
}
