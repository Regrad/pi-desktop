import { readFile } from "node:fs/promises";
import path from "node:path";
import { requestSignal, requestText } from "./http.mjs";

function credential(value, variable) {
  if (typeof value !== "string" || !value.trim()) return process.env[variable];
  const reference = value.match(/^\$(?:\{(\w+)\}|(\w+))$/);
  if (reference) return process.env[reference[1] ?? reference[2]];
  if (value.startsWith("!")) throw new Error("Configure search credentials as a value or an environment variable");
  return value.trim();
}

export async function loadWebSettings(agentDir) {
  try {
    const config = JSON.parse(await readFile(path.join(agentDir, "web-search.json"), "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error();
    return config;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("Invalid web-search.json in the agent directory");
  }
}

function endpoint(base, suffix) {
  const url = new URL(base);
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith(suffix)) url.pathname += suffix;
  return url;
}

function jsonPost(body, headers, signal) {
  return { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body), signal };
}

async function jsonRequest(url, options) {
  const response = await requestText(url, options);
  return JSON.parse(response.text);
}

function exaTextResults(text) {
  const entries = [...text.matchAll(/^Title:[ \t]*([^\r\n]*)\r?\nURL:[ \t]*(https?:\/\/\S+)[ \t]*$/gim)];
  return entries.map((entry, index) => {
    const data = text.slice(entry.index + entry[0].length, entries[index + 1]?.index ?? text.length);
    return { title: entry[1], url: entry[2], snippet: data.split(/^Highlights?:/im)[1] ?? data.split(/^Text:/im)[1] ?? "" };
  });
}

async function searchExa(query, settings, signal) {
  const apiKey = credential(settings.exaApiKey, "EXA_API_KEY");
  if (apiKey) {
    const data = await jsonRequest("https://api.exa.ai/search",
      jsonPost({ query, numResults: 8, contents: { highlights: { maxCharacters: 700 } } }, { "x-api-key": apiKey }, signal));
    return data.results?.map(item => ({ ...item, snippet: item.highlights?.join(" ") }));
  }
  const response = await requestText("https://mcp.exa.ai/mcp", jsonPost({
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "web_search_exa", arguments: { query, numResults: 8, contextMaxCharacters: 6000 } },
  }, { Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" }, signal));
  const envelope = response.contentType.includes("text/event-stream")
    ? response.text.split(/\r?\n\r?\n/).flatMap(event => {
      const payload = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
      return payload ? [JSON.parse(payload)] : [];
    }).find(event => event.id === 1)
    : JSON.parse(response.text);
  if (!envelope?.result || envelope.result.isError) throw new Error("Exa rejected the search");
  return envelope.result.content?.flatMap(block => block.type === "text" ? exaTextResults(block.text) : []);
}

async function searchSearxng(query, settings, signal) {
  const base = settings.searxngBaseUrl || process.env.SEARXNG_BASE_URL;
  if (!base) throw new Error("Configure searxngBaseUrl in web-search.json");
  const url = endpoint(base, "/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("safesearch", "1");
  const headers = Object.fromEntries(Object.entries(settings.searxngHeaders ?? {}).filter(([, value]) => typeof value === "string"));
  const data = await jsonRequest(url, { headers: { Accept: "application/json", ...headers }, signal, configuredProvider: true });
  return data.results?.map(item => ({ ...item, snippet: item.content }));
}

async function searchTavily(query, settings, signal) {
  const key = credential(settings.tavilyApiKey, "TAVILY_API_KEY");
  if (!key) throw new Error("Configure TAVILY_API_KEY for Tavily search");
  const data = await jsonRequest("https://api.tavily.com/search",
    jsonPost({ query, max_results: 8, include_raw_content: false, include_answer: false }, { Authorization: `Bearer ${key}` }, signal));
  return data.results?.map(item => ({ ...item, snippet: item.content }));
}

async function searchSerper(query, settings, signal) {
  const key = credential(settings.serperApiKey, "SERPER_API_KEY");
  if (!key) throw new Error("Configure SERPER_API_KEY for Serper search");
  const data = await jsonRequest("https://google.serper.dev/search", jsonPost({ q: query, num: 8 }, { "X-API-KEY": key }, signal));
  return data.organic?.map(item => ({ ...item, url: item.link }));
}

async function searchKeenable(query, settings, signal) {
  const key = credential(settings.keenableApiKey, "KEENABLE_API_KEY");
  const data = await jsonRequest(key ? "https://api.keenable.ai/v1/search" : "https://api.keenable.ai/v1/search/public",
    jsonPost({ query, max_results: 8 }, { "X-Keenable-Title": "Pi Desktop", ...(key ? { "X-API-Key": key } : {}) }, signal));
  return data.results?.map(item => ({ ...item, snippet: item.snippet || item.description }));
}

const providers = { exa: searchExa, searxng: searchSearxng, tavily: searchTavily, serper: searchSerper, keenable: searchKeenable };

export async function searchWeb(query, settings, signal) {
  const preferred = Object.hasOwn(providers, settings.provider) ? settings.provider
    : (settings.searxngBaseUrl || process.env.SEARXNG_BASE_URL) ? "searxng" : "exa";
  const order = preferred === "exa" && settings.provider !== "exa" ? ["exa", "keenable"] : [preferred];
  let failure;
  for (const name of order) {
    try {
      const results = await providers[name](query, settings, requestSignal(signal, 12_000));
      if (!Array.isArray(results)) throw new Error("Unexpected search response");
      return { provider: name, results };
    } catch (error) {
      signal?.throwIfAborted();
      failure = new Error(`${name}: ${error.message}`);
    }
  }
  throw failure;
}

export async function scrapeWithFirecrawl(url, settings, signal) {
  const key = credential(settings.firecrawlApiKey, "FIRECRAWL_API_KEY");
  const base = settings.firecrawlBaseUrl || process.env.FIRECRAWL_BASE_URL;
  if (!key && !base) return;
  const version = settings.firecrawlApiVersion === "v1" ? "v1" : "v2";
  const data = await jsonRequest(endpoint(base || "https://api.firecrawl.dev", `/${version}/scrape`), {
    ...jsonPost({
      url, formats: ["markdown"], onlyMainContent: true, timeout: 9_000,
      ...(version === "v2" ? { lockdown: settings.firecrawlFreshScrape !== true && process.env.FIRECRAWL_FRESH_SCRAPE !== "1", parsers: [] } : {}),
    }, key ? { Authorization: `Bearer ${key}` } : {}, signal),
    configuredProvider: Boolean(base),
  });
  const content = data.data?.markdown;
  if (data.success && typeof content === "string" && content.trim()) {
    return { url: data.data.metadata?.sourceURL || url, title: data.data.metadata?.title, text: content };
  }
}
