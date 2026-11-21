import type { SearchProvider, ScraperProvider, SearchReranker, WebSearchKey } from "../../shared/web-search.js";

export const searchProviders: readonly SearchProvider[];
export const scraperProviders: readonly ScraperProvider[];
export const rerankers: readonly SearchReranker[];
export const keyEnvironment: Record<WebSearchKey, string>;
export function credential(settings: Record<string, unknown>, field: WebSearchKey): string | undefined;
export function loadWebSettings(agentDir: string): Promise<Record<string, unknown>>;
export function resolveWebSettings(settings: Record<string, unknown>): Record<string, unknown> & {
  searchProvider: SearchProvider;
  scraperProvider: ScraperProvider;
  rerankerType: SearchReranker;
};
