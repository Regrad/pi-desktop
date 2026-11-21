export type SearchProvider = "serper" | "searxng" | "tavily" | "keenable";
export type ScraperProvider = "firecrawl" | "serper" | "tavily" | "keenable";
export type SearchReranker = "jina" | "cohere" | "none";
export type WebSearchKey = "serperApiKey" | "searxngApiKey" | "tavilyApiKey" | "keenableApiKey" | "firecrawlApiKey" | "jinaApiKey" | "cohereApiKey";

export interface WebSearchOptions {
  searchProvider: SearchProvider | "auto";
  scraperProvider: ScraperProvider | "auto";
  rerankerType: SearchReranker | "auto";
  searxngInstanceUrl: string;
  firecrawlApiUrl: string;
}

export interface WebSearchSettings extends WebSearchOptions {
  configuredKeys: Record<WebSearchKey, boolean>;
  savedKeys: Record<WebSearchKey, boolean>;
}

export interface SaveWebSearchSettings extends WebSearchOptions {
  keys: Partial<Record<WebSearchKey, string | null>>;
}
