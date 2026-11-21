import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { publicUrl, resolvePublicUrl, requestSignal, requestText } from "./http.mjs";
import { scrapeWithFirecrawl, searchWeb } from "./providers.mjs";

const maxPages = 5;
const compact = value => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
const cleanText = text => text.replace(/(?:[ \t\r]+\n|\n[ \t\r]+)/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

export function extractPage(page) {
  if (!/html/i.test(page.contentType)) return { url: page.url, text: cleanText(page.text) };
  const { document } = parseHTML(page.text);
  const title = compact(document.title);
  for (const element of document.querySelectorAll("script,style,noscript,template,iframe")) element.remove();
  const base = document.createElement("base");
  base.href = page.url;
  document.head.prepend(base);
  const article = new Readability(document.cloneNode(true), { keepClasses: false }).parse();
  const readable = article?.content ? parseHTML(`<body>${article.content}</body>`).document : undefined;
  const body = readable?.querySelector("body") ?? document.querySelector("main,article,[role=main]") ?? document.body;
  for (const element of body.querySelectorAll("nav,footer,aside,form")) element.remove();
  for (const link of body.querySelectorAll("a[href]")) {
    try {
      const url = publicUrl(new URL(link.getAttribute("href"), page.url));
      if (link.textContent.trim() && url.href !== page.url && link.textContent.trim() !== url.href) link.append(` (${url.href})`);
    } catch { /* Keep the label of links that cannot be read as public pages. */ }
  }
  for (const block of body.querySelectorAll("p,li,pre,tr,h1,h2,h3,h4,br")) block.append("\n\n");
  return { url: page.url, title: compact(article?.title) || title, text: cleanText(body.textContent ?? "") };
}

const words = text => (text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => word.length >= 3);
const commonWords = new Set(["the", "and", "for", "how", "what", "from", "with", "this", "что", "как", "это", "для", "или", "где", "про"]);

export function relevantExcerpt(text, query, limit) {
  const terms = [...new Set(words(query).filter(word => !commonWords.has(word)))];
  if (!terms.length || text.length <= limit) return text.slice(0, limit);
  const chunks = text.split(/\n{2,}/).filter(part => part.trim()).flatMap(paragraph =>
    paragraph.match(/.{1,620}(?:\s+|$)|.{1,620}/gs) ?? []);
  const ranked = chunks.map((chunk, index) => {
    const present = new Set(words(chunk));
    return { chunk, index, score: terms.filter(term => present.has(term)).length };
  });
  ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  const chosen = [];
  let remaining = limit;
  for (const item of ranked) {
    if (remaining <= 2) break;
    chosen.push({ ...item, chunk: item.chunk.trim().slice(0, remaining) });
    remaining -= chosen.at(-1).chunk.length + 2;
  }
  return chosen.sort((left, right) => left.index - right.index).map(item => item.chunk).join("\n\n");
}

function selectSources(results) {
  const seen = new Set();
  const chosen = [];
  for (const result of results) {
    try {
      const url = publicUrl(result.url).href;
      if (seen.has(url)) continue;
      seen.add(url);
      chosen.push({ url, title: compact(result.title).slice(0, 240), snippet: compact(result.snippet).slice(0, 500) });
      if (chosen.length === maxPages) break;
    } catch { /* Skip malformed and non-public provider results. */ }
  }
  return chosen;
}

async function readPage(url, settings, signal) {
  try {
    const result = extractPage(await requestText(url, { page: true, redirects: 4, signal: requestSignal(signal, 7_500) }));
    if (!result.text) throw new Error("Page has no readable text");
    return result;
  } catch (directFailure) {
    signal?.throwIfAborted();
    if (!settings.firecrawlApiKey && !settings.firecrawlBaseUrl && !process.env.FIRECRAWL_API_KEY && !process.env.FIRECRAWL_BASE_URL) throw directFailure;
    await resolvePublicUrl(url);
    signal?.throwIfAborted();
    const result = await scrapeWithFirecrawl(url, settings, requestSignal(signal, 10_000));
    if (!result) throw directFailure;
    return { ...result, url: publicUrl(result.url).href };
  }
}

export async function researchWeb({ query = "", url }, settings, signal, update, io = { search: searchWeb, read: readPage }) {
  signal?.throwIfAborted();
  query = query.trim();
  let candidates, provider;
  if (url) {
    candidates = [{ url: publicUrl(url).href, title: "", snippet: "" }];
  } else {
    update({ phase: "searching", query });
    const search = await io.search(query, settings, signal);
    candidates = selectSources(search.results);
    provider = search.provider;
  }
  if (candidates.length) update({ phase: "reading", query, provider, total: candidates.length });
  const sources = await Promise.all(candidates.map(async candidate => {
    try {
      const page = await io.read(candidate.url, settings, signal);
      return {
        url: page.url, title: compact(page.title).slice(0, 240) || candidate.title,
        status: "read", excerpt: relevantExcerpt(page.text, query, url ? 6000 : 1700),
      };
    } catch (error) {
      signal?.throwIfAborted();
      return {
        url: candidate.url, title: candidate.title, status: candidate.snippet ? "snippet" : "unavailable",
        excerpt: candidate.snippet, reason: String(error.message).slice(0, 160),
      };
    }
  }));
  signal?.throwIfAborted();
  return { phase: "done", query, provider, sources };
}
