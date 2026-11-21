import { requestSignal, requestText } from "./http.mjs";
import { credential, service } from "./settings.mjs";

export async function requestJson(url, { body, headers, signal, timeout = 12_000, configuredProvider } = {}) {
  const response = await requestText(url, {
    configuredProvider,
    signal: requestSignal(signal, timeout),
    headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
  });
  return JSON.parse(response);
}

export function providerPath(base, suffix) {
  const url = new URL(base);
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith(suffix) ? pathname : pathname + suffix;
  return url;
}

const dateRange = { h: "day", d: "day", w: "week", m: "month", y: "year" };
const keenableRange = { h: "1h", d: "1d", w: "7d", m: "1mo", y: "1y" };
const countryNames = new Intl.DisplayNames("en", { type: "region", fallback: "none" });

function resultRows(response, property) {
  if (!Array.isArray(response?.[property])) throw new Error("Unexpected search provider response");
  return response[property];
}

async function serper(input, settings, type, signal) {
  const key = credential(settings, "serperApiKey");
  if (!key) throw new Error("Serper requires an API key");
  const endpoint = type === "search" ? "search" : type;
  const data = await requestJson("https://google.serper.dev/" + endpoint, {
    headers: { "X-API-KEY": key }, signal,
    body: {
      q: input.query, num: 8, safe: ["off", "moderate", "active"][settings.safeSearch] ?? "moderate",
      ...(input.date ? { tbs: "qdr:" + input.date } : {}),
      ...(input.country ? { gl: input.country.toLowerCase() } : {}),
    },
  });
  return resultRows(data, type === "search" ? "organic" : type).map(item => ({
    url: item.link, title: item.title, snippet: item.snippet, date: item.date, imageUrl: item.imageUrl,
  }));
}

async function searxng(input, settings, type, signal) {
  const connection = service(settings, "searxngApiKey", "searxngInstanceUrl", "SEARXNG_INSTANCE_URL", "https://localhost", "SEARXNG_BASE_URL");
  if (!settings.searxngInstanceUrl && !process.env.SEARXNG_INSTANCE_URL && !process.env.SEARXNG_BASE_URL) throw new Error("Set the SearXNG instance URL");
  const url = providerPath(connection.url, "/search");
  const options = settings.searxngSearchOptions ?? {};
  const engines = Array.isArray(options.engines) ? options.engines.join(",") : options.engines;
  const parameters = {
    q: input.query, format: "json", pageno: "1", categories: type === "search" ? "general" : type,
    language: options.language || "all", engines: engines || "google,bing,duckduckgo",
    safesearch: String(settings.safeSearch ?? 1),
  };
  const timeRange = options.timeRange ?? dateRange[input.date];
  if (timeRange && timeRange !== "week") parameters.time_range = timeRange;
  for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);
  const headers = Object.fromEntries(Object.entries(settings.searxngHeaders ?? {}).filter(([, value]) => typeof value === "string"));
  if (connection.key) headers["X-API-Key"] = connection.key;
  const data = await requestJson(url, { headers, signal, configuredProvider: connection.configuredProvider, timeout: options.timeout });
  return resultRows(data, "results").map(item => ({
    url: item.url, title: item.title, snippet: item.content, date: item.publishedDate, imageUrl: item.img_src,
  }));
}

async function tavily(input, settings, type, signal) {
  const connection = service(settings, "tavilyApiKey", "tavilySearchUrl", "TAVILY_SEARCH_URL", "https://api.tavily.com/search");
  if (!connection.key) throw new Error("Tavily requires an API key");
  const options = settings.tavilySearchOptions ?? {};
  const topic = type === "news" ? "news" : options.topic ?? "general";
  const range = options.timeRange ?? dateRange[input.date];
  const region = /^[a-z]{2}$/i.test(input.country ?? "") ? input.country.toUpperCase() : undefined;
  const country = region ? countryNames.of(region === "UK" ? "GB" : region)?.toLowerCase() : input.country?.toLowerCase();
  const data = await requestJson(connection.url, {
    ...connection, signal, timeout: options.timeout,
    headers: { Authorization: "Bearer " + connection.key },
    body: {
      query: input.query, search_depth: options.searchDepth ?? "basic", topic,
      max_results: options.maxResults ?? 8, include_images: Boolean(type === "images" || options.includeImages),
      include_answer: false, include_raw_content: false,
      ...(range ? { time_range: range } : {}),
      ...(country && topic === "general" ? { country } : {}),
      ...(options.includeDomains ? { include_domains: options.includeDomains } : {}),
      ...(options.excludeDomains ? { exclude_domains: options.excludeDomains } : {}),
      ...(options.safeSearch !== undefined ? { safe_search: options.safeSearch } : {}),
    },
  });
  if (type === "images") return resultRows(data, "images").map(item => {
    const imageUrl = typeof item === "string" ? item : item.url;
    return { url: imageUrl, imageUrl, title: item.description, snippet: "" };
  });
  return resultRows(data, "results").map(item => ({ url: item.url, title: item.title, snippet: item.content, date: item.published_date }));
}

async function keenable(input, settings, _type, signal) {
  const key = credential(settings, "keenableApiKey");
  const connection = service(settings, "keenableApiKey", "keenableApiUrl", "KEENABLE_API_URL",
    key ? "https://api.keenable.ai/v1/search" : "https://api.keenable.ai/v1/search/public");
  const options = settings.keenableSearchOptions ?? {};
  const data = await requestJson(connection.url, {
    ...connection, signal, timeout: options.timeout,
    headers: {
      "X-Keenable-Title": options.attributionTitle ?? "Pi Desktop",
      ...(connection.key ? { "X-API-Key": connection.key } : {}),
    },
    body: {
      query: input.query, max_results: options.maxResults ?? 8, ...(options.site ? { site: options.site } : {}),
      ...(input.date ? { published_after: keenableRange[input.date] } : {}),
    },
  });
  return resultRows(data, "results").map(item => ({ url: item.url, title: item.title, snippet: item.snippet || item.description, date: item.published_at }));
}

const adapters = { serper, searxng, tavily, keenable };
const media = [["news", "news"], ["images", "image"], ["videos", "ref"]];

export async function searchWeb(input, settings, signal) {
  const provider = settings.searchProvider;
  const adapter = adapters[provider];
  const enabled = media.filter(([type]) => input[type] && provider !== "keenable" && !(provider === "tavily" && type === "videos"));
  const batches = await Promise.all([["search", "search"], ...enabled].map(async ([type, kind]) => {
    try {
      const results = await adapter(input, settings, type, signal);
      return { kind, results };
    } catch (error) {
      signal?.throwIfAborted();
      return { kind, error: error.message };
    }
  }));
  const errors = batches.filter(batch => batch.error);
  if (errors.length === batches.length) throw new Error(provider + ": " + errors[0].error);
  return { provider, batches, errors };
}
