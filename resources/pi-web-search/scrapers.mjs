import { publicUrl, resolvePublicUrl } from "./http.mjs";
import { requestJson, providerPath } from "./providers.mjs";
import { credential, service } from "./settings.mjs";

function page(source, fallback) {
  if (typeof source.text !== "string" || !source.text.trim()) throw new Error("The extractor returned no page text");
  return { url: publicUrl(source.url || fallback).href, title: source.title, text: source.text };
}

function scraperTimeout(settings, providerOptions, defaultValue = 7500) {
  return settings.scraperTimeout ?? providerOptions?.timeout ?? defaultValue;
}

async function firecrawl(url, settings, signal) {
  const connection = service(settings, "firecrawlApiKey", "firecrawlApiUrl", "FIRECRAWL_API_URL", "https://api.firecrawl.dev", "FIRECRAWL_BASE_URL");
  if (!connection.key && connection.url.origin === "https://api.firecrawl.dev") throw new Error("Firecrawl requires an API key");
  const version = settings.firecrawlVersion === "v1" ? "v1" : "v2";
  const options = settings.firecrawlOptions ?? {};
  const timeout = scraperTimeout(settings, options);
  const response = await requestJson(providerPath(connection.url, "/" + version + "/scrape"), {
    ...connection, signal, timeout,
    headers: connection.key ? { Authorization: "Bearer " + connection.key } : {},
    body: {
      url, formats: ["markdown"], onlyMainContent: options.onlyMainContent ?? true, timeout,
      ...(options.waitFor !== undefined ? { waitFor: options.waitFor } : {}),
      ...(options.includeTags ? { includeTags: options.includeTags } : {}),
      ...(options.excludeTags ? { excludeTags: options.excludeTags } : {}),
      ...(options.maxAge !== undefined ? { maxAge: options.maxAge } : {}),
      ...(version === "v2" && options.parsePDF === false ? { parsers: [] } : {}),
    },
  });
  if (!response.success) throw new Error("Firecrawl could not read the page");
  return page({ url: response.data?.metadata?.sourceURL, title: response.data?.metadata?.title, text: response.data?.markdown }, url);
}

async function serper(url, settings, signal) {
  const connection = service(settings, "serperApiKey", "serperScrapeUrl", "SERPER_SCRAPE_URL", "https://scrape.serper.dev");
  if (!connection.key) throw new Error("Serper Scrape requires an API key");
  const options = settings.serperScraperOptions ?? {};
  const data = await requestJson(connection.url, {
    ...connection, signal, timeout: scraperTimeout(settings, options), headers: { "X-API-KEY": connection.key },
    body: { url, includeMarkdown: options.includeMarkdown ?? true },
  });
  return page({ title: data.metadata?.title, text: data.markdown ?? data.text }, url);
}

async function keenable(url, settings, signal) {
  const key = credential(settings, "keenableApiKey");
  const connection = service(settings, "keenableApiKey", "keenableFetchUrl", "KEENABLE_FETCH_URL",
    key ? "https://api.keenable.ai/v1/fetch" : "https://api.keenable.ai/v1/fetch/public");
  const options = settings.keenableScraperOptions ?? {};
  connection.url.searchParams.set("url", url);
  const response = await requestJson(connection.url, {
    ...connection, signal, timeout: scraperTimeout(settings, options),
    headers: {
      "X-Keenable-Title": options.attributionTitle ?? "Pi Desktop",
      ...(connection.key ? { "X-API-Key": connection.key } : {}),
    },
  });
  return page({ url: response.url, title: response.title, text: response.content }, url);
}

function normalizedUrl(url) {
  try {
    const parsed = publicUrl(url);
    return parsed.hostname + parsed.pathname.replace(/\/$/, "") + parsed.search;
  } catch { return undefined; }
}

async function tavily(urls, settings, signal) {
  const connection = service(settings, "tavilyApiKey", "tavilyExtractUrl", "TAVILY_EXTRACT_URL", "https://api.tavily.com/extract");
  if (!connection.key) throw new Error("Tavily Extract requires an API key");
  const options = settings.tavilyScraperOptions ?? {};
  const timeout = scraperTimeout(settings, options);
  const response = await requestJson(connection.url, {
    ...connection, signal, timeout, headers: { Authorization: "Bearer " + connection.key },
    body: {
      urls, extract_depth: options.extractDepth ?? "basic", format: options.format ?? "markdown",
      include_images: options.includeImages ?? false,
      timeout: Math.max(1, Math.min(60, timeout / 1000)),
    },
  });
  const rows = new Map((response.results ?? []).map(item => [normalizedUrl(item.url), item]));
  return new Map(urls.map(url => {
    const result = rows.get(normalizedUrl(url));
    if (!result?.raw_content) return [url, { error: "Tavily could not read the page" }];
    return [url, page({ url: result.url, text: result.raw_content }, url)];
  }));
}

const adapters = { firecrawl, serper, keenable };

export async function scrapePages(urls, settings, signal, validate = resolvePublicUrl) {
  const result = new Map();
  const validated = await Promise.all(urls.map(async url => {
    try {
      await validate(url);
      return url;
    } catch (error) {
      result.set(url, { error: error.message });
    }
  }));
  signal?.throwIfAborted();
  const ready = validated.filter(Boolean);
  if (!ready.length) return result;

  if (settings.scraperProvider === "tavily") {
    try {
      for (const [url, value] of await tavily(ready, settings, signal)) result.set(url, value);
    } catch (error) {
      signal?.throwIfAborted();
      for (const url of ready) result.set(url, { error: error.message });
    }
    return result;
  }

  const adapter = adapters[settings.scraperProvider];
  await Promise.all(ready.map(async url => {
    try {
      result.set(url, await adapter(url, settings, signal));
    } catch (error) {
      signal?.throwIfAborted();
      result.set(url, { error: error.message });
    }
  }));
  return result;
}
