import { publicUrl } from "./http.mjs";
import { searchWeb } from "./providers.mjs";
import { scrapePages } from "./scrapers.mjs";
import { excerpts } from "./ranking.mjs";

function pageKey(url) {
  const parsed = publicUrl(url);
  for (const name of [...parsed.searchParams.keys()]) {
    if (/^(?:utm_.+|fbclid|gclid)$/i.test(name)) parsed.searchParams.delete(name);
  }
  return parsed.href;
}

export function createResearchSession() {
  const searches = new Map();
  const pages = new Map();

  return {
    search(input, settings, signal) {
      const key = JSON.stringify([input.query.trim().replace(/\s+/g, " "), input.country?.toLowerCase(), input.date,
        Boolean(input.news), Boolean(input.images), Boolean(input.videos)]);
      if (!searches.has(key)) {
        searches.set(key, searchWeb(input, settings, signal).catch(error => {
          searches.delete(key);
          throw error;
        }));
      }
      return searches.get(key);
    },

    async scrape(urls, settings, signal, onPage) {
      const missing = new Map();
      const pending = urls.map(url => {
        const key = pageKey(url);
        if (!pages.has(key)) {
          pages.set(key, new Promise((resolve, reject) => missing.set(url, { key, resolve, reject })));
        }
        return [url, pages.get(key)];
      });
      if (missing.size) {
        const receive = (url, page) => {
          const entry = missing.get(url);
          if (!entry) return;
          if (page.text) {
            const finalKey = pageKey(page.url);
            if (!pages.has(finalKey)) pages.set(finalKey, pages.get(entry.key));
          } else pages.delete(entry.key);
          missing.delete(url);
          entry.resolve(page);
        };
        void scrapePages([...missing.keys()], settings, signal, receive).then(results => {
          for (const url of missing.keys()) receive(url, results.get(url) ?? { error: "Page unavailable" });
        }).catch(error => {
          for (const entry of missing.values()) {
            pages.delete(entry.key);
            entry.reject(error);
          }
        });
      }
      return new Map(await Promise.all(pending.map(async ([url, promise]) => {
        const page = await promise;
        signal?.throwIfAborted();
        onPage?.(url, page);
        return [url, page];
      })));
    },
    excerpts,
  };
}
