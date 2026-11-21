import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { requestJson } from "./providers.mjs";
import { service } from "./settings.mjs";

const split = new RecursiveCharacterTextSplitter({ separators: ["\n\n", "\n"], chunkSize: 150, chunkOverlap: 50 });
const topResults = 5;

export function cleanPageText(text) {
  return text.replace(/\r\n?/g, "\n").replace(/\\+\n/g, "\n").replace(/[\t ]*\n[\t \n]*/g, "\n")
    .replace(/[ \t]+/g, " ").trim().slice(0, 50_000);
}

async function rank(query, documents, settings, signal) {
  const provider = settings.rerankerType;
  const original = documents.slice(0, topResults);
  if (provider === "none" || !query || !documents.length) return { texts: original };

  try {
    const jina = provider === "jina";
    const endpoint = jina ? service(settings, "jinaApiKey", "jinaApiUrl", "JINA_API_URL", "https://api.jina.ai/v1/rerank")
      : service(settings, "cohereApiKey", "cohereApiUrl", "COHERE_API_URL", "https://api.cohere.com/v2/rerank");
    if (!endpoint.key) throw new Error(provider + " requires an API key");
    const data = await requestJson(endpoint.url, {
      ...endpoint, signal, timeout: settings.rerankerTimeout ?? 8_000, headers: { Authorization: "Bearer " + endpoint.key },
      body: {
        query, documents, top_n: Math.min(topResults, documents.length),
        model: jina ? "jina-reranker-v2-base-multilingual" : "rerank-v3.5",
        ...(jina ? { return_documents: true } : {}),
      },
    });
    const indices = [...new Set((data.results ?? []).map(item => item.index))]
      .filter(index => Number.isInteger(index) && index >= 0 && index < documents.length)
      .slice(0, topResults);
    if (!indices.length) throw new Error("No ranked passages returned");
    return { texts: indices.map(index => documents[index]) };
  } catch (error) {
    signal?.throwIfAborted();
    return { texts: original, fallback: error.message };
  }
}

function focusedExcerpt(content, query, limit) {
  const terms = new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(term => term.length >= 3 || /^\d{2}$/.test(term)));
  if (!terms.size) return content.slice(0, limit);
  const blocks = [];
  for (let start = 0; start < content.length; start += 360) {
    const text = content.slice(start, start + 500);
    const words = new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu));
    let score = 0;
    for (const term of terms) if (words.has(term)) score += /^\d{2}$/.test(term) ? 3 : 1;
    if (score) blocks.push({ text, score });
  }
  blocks.sort((a, b) => b.score - a.score);
  if (!blocks.length) return content.slice(0, limit);
  return expand(content, blocks.slice(0, topResults).map(block => block.text), limit);
}

// As in LibreChat, retain surrounding text and merge overlapping highlights.
// The result is kept in relevance order, with complete duplicate ranges removed.
function expand(text, highlights, limit) {
  const used = [];
  const parts = [];
  let remaining = limit;
  for (const highlight of highlights) {
    const index = text.indexOf(highlight.trim());
    let start = index < 0 ? 0 : Math.max(0, index - 300);
    let end = index < 0 ? Math.min(text.length, highlight.length + 300) : Math.min(text.length, index + highlight.length + 300);
    const before = text.lastIndexOf("\n", index);
    const after = text.indexOf("\n", index + highlight.length);
    if (before >= start) start = before + 1;
    if (after >= 0 && after <= end) end = after;
    let slices = [[start, end]];
    for (const [left, right] of used) {
      slices = slices.flatMap(([s, e]) => e <= left || s >= right ? [[s, e]] :
        [[s, Math.min(e, left)], [Math.max(s, right), e]].filter(([a, b]) => b > a));
    }
    const next = slices.map(([left, right]) => text.slice(left, right).trim()).filter(Boolean).join("\n");
    if (!next) continue;
    parts.push(next.slice(0, remaining));
    used.push([start, end]);
    remaining -= Math.min(next.length, remaining) + 2;
    if (remaining <= 0) break;
  }
  return parts.join("\n\n");
}

export async function excerpts(text, query, settings, signal, limit, wholePage = false) {
  const content = cleanPageText(text);
  const fallback = () => wholePage && query ? focusedExcerpt(content, query, limit) : content.slice(0, limit);
  if (!query || settings.rerankerType === "none") return { excerpt: fallback() };
  const documents = await split.splitText(content);
  const ranked = await rank(query, documents, settings, signal);
  return { excerpt: ranked.fallback ? fallback() : expand(content, ranked.texts, limit), fallback: ranked.fallback };
}
