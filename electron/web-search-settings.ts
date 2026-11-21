import path from "node:path";
import { pathToFileURL } from "node:url";
import { atomicStateWrite } from "./atomic-state.js";
import type { SaveWebSearchSettings, WebSearchKey, WebSearchSettings } from "../shared/web-search.js";

export function createWebSearchSettings(appRoot: string, agentDir: string) {
  const moduleUrl = pathToFileURL(path.join(appRoot, "resources", "pi-web-search", "settings.mjs")).href;
  const helpers = () => import(moduleUrl) as Promise<typeof import("../resources/pi-web-search/settings.mjs")>;
  const file = path.join(agentDir, "web-search.json");
  let pending = Promise.resolve();

  async function get(): Promise<WebSearchSettings> {
    const module = await helpers();
    const data = await module.loadWebSettings(agentDir);
    const legacy = module.searchProviders.find(name => name === data.provider);
    return {
      searchProvider: module.searchProviders.find(name => name === data.searchProvider) ?? legacy ?? "auto",
      scraperProvider: module.scraperProviders.find(name => name === data.scraperProvider) ?? "auto",
      rerankerType: module.rerankers.find(name => name === data.rerankerType) ?? "auto",
      searxngInstanceUrl: String(data.searxngInstanceUrl ?? data.searxngBaseUrl ?? ""),
      firecrawlApiUrl: String(data.firecrawlApiUrl ?? data.firecrawlBaseUrl ?? ""),
      configuredKeys: Object.fromEntries((Object.keys(module.keyEnvironment) as WebSearchKey[])
        .map(key => [key, Boolean(module.credential(data, key))])) as Record<WebSearchKey, boolean>,
      savedKeys: Object.fromEntries((Object.keys(module.keyEnvironment) as WebSearchKey[])
        .map(key => [key, typeof data[key] === "string" && data[key].trim().length > 0])) as Record<WebSearchKey, boolean>,
    };
  }

  async function update(input: SaveWebSearchSettings): Promise<WebSearchSettings> {
    const module = await helpers();
    if (!input || !["auto", ...module.searchProviders].includes(input.searchProvider) ||
        !["auto", ...module.scraperProviders].includes(input.scraperProvider) ||
        !["auto", ...module.rerankers].includes(input.rerankerType)) {
      throw new Error("Invalid web search settings");
    }
    const data = await module.loadWebSettings(agentDir);
    const next = { ...data, searchProvider: input.searchProvider, scraperProvider: input.scraperProvider, rerankerType: input.rerankerType };
    delete (next as Record<string, unknown>).provider;
    const record: Record<string, unknown> = next;
    const allowed = new Set(Array.isArray(data.allowedAddresses) ? data.allowedAddresses.filter((item): item is string => typeof item === "string") : []);
    for (const [field, legacy, key] of [
      ["searxngInstanceUrl", "searxngBaseUrl", "searxngApiKey"],
      ["firecrawlApiUrl", "firecrawlBaseUrl", "firecrawlApiKey"],
    ] as const) {
      const value = input[field]?.trim() ?? "";
      if (value.length > 2048) throw new Error("Provider URL is too long");
      const previous = record[field] ?? record[legacy] ?? "";
      if (value && !/^\$(?:\{[A-Za-z_]\w*\}|[A-Za-z_]\w*)$/.test(value)) {
        const url = new URL(value);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
          throw new Error("Provider URL must be HTTP or HTTPS without embedded credentials");
        }
        // These are administrator-supplied service addresses, not model inputs.
        allowed.add(url.host.toLowerCase());
      }
      if (value !== previous) delete record[key];
      if (value) record[field] = value;
      else delete record[field];
      delete record[legacy];
    }
    record.allowedAddresses = [...allowed];
    for (const key of Object.keys(module.keyEnvironment) as WebSearchKey[]) {
      const value = input.keys?.[key];
      if (value === null) delete record[key];
      else if (typeof value === "string" && value.trim()) {
        if (value.length > 4096 || /[\r\n]/.test(value)) throw new Error("Invalid API key");
        record[key] = value.trim();
      }
    }
    await atomicStateWrite(file, JSON.stringify(record, null, 2) + "\n");
    return get();
  }

  return {
    get,
    save(input: SaveWebSearchSettings) {
      const result = pending.then(() => update(input));
      pending = result.then(() => undefined, () => undefined);
      return result;
    },
  };
}
