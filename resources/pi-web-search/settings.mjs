import { readFile } from "node:fs/promises";
import path from "node:path";

export const searchProviders = ["serper", "searxng", "tavily", "keenable"];
export const scraperProviders = ["firecrawl", "serper", "tavily", "keenable"];
export const rerankers = ["jina", "cohere", "none"];
export const keyEnvironment = {
  serperApiKey: "SERPER_API_KEY", searxngApiKey: "SEARXNG_API_KEY",
  tavilyApiKey: "TAVILY_API_KEY", keenableApiKey: "KEENABLE_API_KEY",
  firecrawlApiKey: "FIRECRAWL_API_KEY", jinaApiKey: "JINA_API_KEY", cohereApiKey: "COHERE_API_KEY",
};

function envName(value) {
  const match = typeof value === "string" && value.match(/^\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))$/);
  return match ? match[1] ?? match[2] : undefined;
}

function setting(value, environment) {
  const name = envName(value);
  if (name) return process.env[name]?.trim();
  if (typeof value === "string" && value.startsWith("!")) return;
  return typeof value === "string" && value.trim() ? value.trim() : process.env[environment]?.trim();
}

export function credential(settings, field) {
  return setting(settings[field], keyEnvironment[field]);
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

function selected(value, allowed, fallback) {
  if (value === undefined || value === "" || value === "auto") return fallback;
  if (!allowed.includes(value)) throw new Error("Unknown web search provider selection");
  return value;
}

export function resolveWebSettings(config) {
  const settings = {
    ...config,
    searxngInstanceUrl: config.searxngInstanceUrl ?? config.searxngBaseUrl,
    firecrawlApiUrl: config.firecrawlApiUrl ?? config.firecrawlBaseUrl,
    firecrawlVersion: setting(config.firecrawlVersion ?? config.firecrawlApiVersion, "FIRECRAWL_VERSION") || "v2",
  };
  const has = field => Boolean(credential(settings, field));
  // Keep existing LibreChat-compatible providers. Retired Exa/DDG and "auto"
  // profiles use the same credential discovery as a fresh Desktop profile.
  const legacy = searchProviders.includes(config.provider) ? config.provider : undefined;
  const searchProvider = selected(config.searchProvider ?? legacy, searchProviders,
    setting(settings.searxngInstanceUrl, "SEARXNG_INSTANCE_URL") || process.env.SEARXNG_BASE_URL ? "searxng" :
      has("serperApiKey") ? "serper" : has("tavilyApiKey") ? "tavily" : "keenable");
  const scraperProvider = selected(config.scraperProvider, scraperProviders,
    has("firecrawlApiKey") || setting(settings.firecrawlApiUrl, "FIRECRAWL_API_URL") || process.env.FIRECRAWL_BASE_URL ? "firecrawl" :
      searchProvider === "serper" || searchProvider === "tavily" ? searchProvider : "keenable");
  const rerankerType = selected(config.rerankerType, rerankers, has("jinaApiKey") ? "jina" : has("cohereApiKey") ? "cohere" : "none");
  return { ...settings, searchProvider, scraperProvider, rerankerType };
}

// Endpoint and key are selected together. An environment key for the hosted
// service must not go to a different origin specified as a literal in JSON.
export function service(settings, keyField, urlField, urlEnv, defaultUrl, legacyUrlEnv) {
  const raw = settings[urlField];
  const fromEnvironment = envName(raw);
  const literal = typeof raw === "string" && raw.trim() && !fromEnvironment;
  const configured = setting(raw, urlEnv) || (legacyUrlEnv && process.env[legacyUrlEnv]);
  const url = new URL(configured || defaultUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Provider URL must be HTTP or HTTPS without embedded credentials");
  const key = literal && (envName(settings[keyField]) || !settings[keyField]) ? undefined
    : !literal && configured && !envName(settings[keyField]) && settings[keyField] ? undefined : credential(settings, keyField);
  const allowed = Array.isArray(settings.allowedAddresses) && settings.allowedAddresses.some(address => typeof address === "string" && address.toLowerCase() === url.host.toLowerCase());
  const legacyLocal = (keyField === "searxngApiKey" && settings.searxngBaseUrl === raw || keyField === "firecrawlApiKey" && settings.firecrawlBaseUrl === raw) &&
    Boolean(raw) && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return { url, key, configuredProvider: Boolean(configured && (allowed || legacyLocal)) };
}
