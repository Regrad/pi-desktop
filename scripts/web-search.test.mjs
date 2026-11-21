import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isPublicAddress, publicUrl, requestText } from "../resources/pi-web-search/http.mjs";
import { createWebSearch } from "../resources/pi-web-search/index.mjs";
import { searchWeb } from "../resources/pi-web-search/providers.mjs";
import { excerpts } from "../resources/pi-web-search/ranking.mjs";
import { researchWeb } from "../resources/pi-web-search/research.mjs";
import { scrapePages } from "../resources/pi-web-search/scrapers.mjs";
import { resolveWebSettings, service } from "../resources/pi-web-search/settings.mjs";
import { remarkWebCitations } from "../src/web-citations.ts";
import { createWebSearchSettings } from "../dist-electron/electron/web-search-settings.js";
import ReactMarkdown from "react-markdown";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

async function server(t, routes) {
  const requests = [];
  const instance = createServer(async (req, res) => {
    try {
      const data = [];
      for await (const chunk of req) data.push(chunk);
      const url = new URL(req.url, "http://fixture");
      const request = { url, body: data.length ? JSON.parse(Buffer.concat(data)) : undefined, headers: req.headers };
      requests.push(request);
      const handler = routes[url.pathname];
      if (!handler) { res.writeHead(404).end(); return; }
      const output = handler(request);
      if (output?.redirect) { res.writeHead(302, { Location: output.redirect }).end(); return; }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(output));
    } catch (error) {
      res.writeHead(500).end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => instance.listen(0, "127.0.0.1", resolve));
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  const address = "127.0.0.1:" + instance.address().port;
  return { base: "http://" + address, allowedAddresses: [address], requests };
}

const firstPage = "https://93.184.215.14/first";
const secondPage = "https://93.184.215.14/second";

test("only public page URLs can be submitted to extraction", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:192.168.1.1", "fc00::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const url of ["file:///C:/Windows", "http://0x7f000001", "https://[::1]", "http://169.254.169.254", "http://localhost",
    "https://user:pass@example.org", "http://example.org:8080"]) {
    assert.throws(() => publicUrl(url), undefined, url);
  }
  const pages = await scrapePages(["http://127.0.0.1"], { scraperProvider: "keenable" });
  assert.match(pages.get("http://127.0.0.1").error, /public website/);
  await assert.rejects(requestText("http://127.0.0.1"), /public website/);
});

test("automatic settings migrate old provider fields and separate the three stages", t => {
  for (const name of ["SEARXNG_BASE_URL", "SEARXNG_INSTANCE_URL", "SERPER_API_KEY", "TAVILY_API_KEY", "FIRECRAWL_BASE_URL", "FIRECRAWL_API_URL", "FIRECRAWL_API_KEY", "JINA_API_KEY", "COHERE_API_KEY"]) {
    const old = process.env[name];
    delete process.env[name];
    t.after(() => { if (old !== undefined) process.env[name] = old; });
  }
  for (const config of [{}, { provider: "exa" }, { provider: "duckduckgo" }]) {
    const settings = resolveWebSettings(config);
    assert.deepEqual([settings.searchProvider, settings.scraperProvider, settings.rerankerType], ["keenable", "keenable", "none"]);
  }
  const settings = resolveWebSettings({ provider: "searxng", searxngBaseUrl: "http://localhost:8080",
    scraperProvider: "tavily", rerankerType: "cohere" });
  assert.equal(settings.searchProvider, "searxng");
  assert.equal(settings.searxngInstanceUrl, "http://localhost:8080");
  assert.equal(settings.scraperProvider, "tavily");
  assert.equal(settings.rerankerType, "cohere");
});

test("an environment key for the public service is not sent to a literal custom URL", t => {
  const old = process.env.JINA_API_KEY;
  process.env.JINA_API_KEY = "environment-key";
  t.after(() => { if (old === undefined) delete process.env.JINA_API_KEY; else process.env.JINA_API_KEY = old; });
  const endpoint = "https://api.jina.ai/v1/rerank";
  assert.equal(service({}, "jinaApiKey", "jinaApiUrl", "PI_TEST_JINA_URL", endpoint).key, "environment-key");
  assert.equal(service({ jinaApiUrl: "https://example.org/rank" }, "jinaApiKey", "jinaApiUrl", "PI_TEST_JINA_URL", endpoint).key, undefined);
  assert.equal(service({ jinaApiUrl: "https://example.org/rank", jinaApiKey: "local-key" }, "jinaApiKey", "jinaApiUrl", "PI_TEST_JINA_URL", endpoint).key, "local-key");
});

test("SearXNG and Tavily search pass options and preserve categories", async t => {
  const mock = await server(t, {
    "/search": ({ url }) => ({ results: [{ title: url.searchParams.get("categories"), url: firstPage, content: "Snippet" }] }),
    "/tavily": ({ body }) => ({ results: [{ url: firstPage, title: body.topic, content: "Snippet" }], images: [{ url: secondPage, description: "Image" }] }),
    "/redirect/search": () => ({ redirect: "http://127.0.0.1/forbidden" }),
  });
  const result = await searchWeb({ query: "LibreChat", news: true }, {
    searchProvider: "searxng", searxngInstanceUrl: mock.base, ...mock,
    searxngSearchOptions: { language: "ru", engines: ["google", "bing"], timeRange: "year" },
  });
  assert.deepEqual(result.batches.map(item => [item.kind, item.results[0].title]), [["search", "general"], ["news", "news"]]);
  const first = mock.requests[0].url.searchParams;
  assert.equal(first.get("format"), "json");
  assert.equal(first.get("language"), "ru");
  assert.equal(first.get("engines"), "google,bing");
  assert.equal(first.get("time_range"), "year");

  const tavily = await searchWeb({ query: "a", country: "GB", images: true, date: "m" },
    { searchProvider: "tavily", tavilyApiKey: "fixture", tavilySearchUrl: mock.base + "/tavily", ...mock });
  assert.deepEqual(tavily.batches.map(item => item.kind), ["search", "image"]);
  const request = mock.requests.find(item => item.url.pathname === "/tavily");
  assert.equal(request.body.country, "united kingdom");
  assert.equal(request.body.time_range, "month");
  assert.equal(request.headers.authorization, "Bearer fixture");
  await assert.rejects(searchWeb({ query: "a" }, { searchProvider: "searxng", searxngInstanceUrl: mock.base + "/redirect",
    allowedAddresses: mock.allowedAddresses }), /provider redirect/);
});

test("all four extraction providers work separately and Tavily reads a batch once", async t => {
  const mock = await server(t, {
    "/v2/scrape": ({ body }) => ({ success: true, data: { markdown: "Firecrawl text", metadata: { sourceURL: body.url } } }),
    "/serper": () => ({ markdown: "Serper text" }),
    "/keenable": ({ url }) => ({ url: url.searchParams.get("url"), title: "Keenable", content: "Keenable text" }),
    "/tavily": ({ body }) => ({ results: body.urls.slice(0, 1).map(url => ({ url, raw_content: "Tavily text" })) }),
  });
  for (const [scraperProvider, config, expected] of [
    ["firecrawl", { firecrawlApiUrl: mock.base }, "Firecrawl text"],
    ["serper", { serperScrapeUrl: mock.base + "/serper", serperApiKey: "fixture" }, "Serper text"],
    ["keenable", { keenableFetchUrl: mock.base + "/keenable" }, "Keenable text"],
    ["tavily", { tavilyExtractUrl: mock.base + "/tavily", tavilyApiKey: "fixture" }, "Tavily text"],
  ]) {
    const pages = await scrapePages([firstPage, secondPage], { scraperProvider, allowedAddresses: mock.allowedAddresses, ...config });
    assert.equal(pages.get(firstPage).text, expected);
    if (scraperProvider === "tavily") assert.match(pages.get(secondPage).error, /could not read/);
    else assert.equal(pages.get(secondPage).text, expected);
  }
  const batch = mock.requests.filter(item => item.url.pathname === "/tavily");
  assert.deepEqual(batch.map(item => item.body.urls), [[firstPage, secondPage]]);
});

test("Jina and Cohere use LibreChat models with an original-order fallback", async t => {
  const mock = await server(t, {
    "/jina": ({ body }) => ({ results: [{ index: body.documents.length - 1 }] }),
    "/cohere": ({ body }) => ({ results: [{ index: body.documents.length - 1 }] }),
  });
  const raw = Array.from({ length: 35 }, (_, index) => "Beginning of the ordinary page paragraph " + index + ". ".repeat(10))
    .join("\n") + "\nSelected evidence in the final paragraph";
  const original = await excerpts(raw, "query", { rerankerType: "none" }, undefined, 1200);
  assert.match(original.excerpt, /paragraph 0/);
  assert.doesNotMatch(original.excerpt, /Selected evidence/);
  for (const rerankerType of ["jina", "cohere"]) {
    const key = rerankerType + "ApiKey";
    const url = rerankerType + "ApiUrl";
    const ranked = await excerpts(raw, "query", {
      rerankerType, [key]: "fixture", [url]: mock.base + "/" + rerankerType, allowedAddresses: mock.allowedAddresses,
    }, undefined, 1200);
    assert.match(ranked.excerpt, /Selected evidence/);
    assert.equal(ranked.fallback, undefined);
    const fallback = await excerpts(raw, "query", { rerankerType, [url]: mock.base + "/missing" }, undefined, 1200);
    assert.equal(fallback.excerpt, original.excerpt);
    assert.match(fallback.fallback, /requires an API key/);
  }
  assert.deepEqual(mock.requests.map(item => item.body.model), ["jina-reranker-v2-base-multilingual", "rerank-v3.5"]);
});

test("one search reads five unique results, keeps snippets and reports ranking", async () => {
  const url = index => "https://example.org/" + index;
  const progress = [];
  const input = { query: "test" };
  const result = await researchWeb(input, { rerankerType: "jina" }, AbortSignal.timeout(1000), event => progress.push(event), {
    async search() {
      return { provider: "fixture", errors: [], batches: [{ kind: "search", results: [1, 1, 2, 3, 4, 5, 6].map(value => ({
        url: url(value), title: String(value), snippet: "only from search",
      })) }] };
    },
    async scrape(urls, _settings, _signal, onPage) {
      assert.deepEqual(urls, [1, 2, 3, 4, 5].map(url));
      const pages = new Map(urls.map(value => [value, value === url(2) ? { error: "Blocked" } : { url: value, title: "Page title", text: "Actually extracted" }]));
      for (const [url, page] of pages) onPage(url, page);
      return pages;
    },
    async excerpts(text) { return { excerpt: text }; },
  });
  assert.deepEqual(progress.map(event => event.phase), ["searching", ...Array(6).fill("reading"), "ranking"]);
  assert.deepEqual(progress.slice(1, -1).map(event => event.completed), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(progress[1].sources.map(source => source.status), [...Array(5).fill("reading"), "snippet"]);
  assert.equal(progress[2].sources[0].status, "read");
  assert.equal(progress[3].sources[1].status, "snippet");
  assert.equal(progress.some(event => JSON.stringify(event).includes("Actually extracted")), false);
  assert.deepEqual(result.sources.map(source => source.status), ["read", "snippet", "read", "read", "read", "snippet"]);
  assert.equal(result.sources[1].excerpt, "only from search");
});

test("direct URLs bypass search and cancellation discards ongoing results", async () => {
  const stop = new AbortController();
  await assert.rejects(researchWeb({ url: "https://example.org" }, { rerankerType: "none" }, stop.signal, () => {}, {
    search() { assert.fail("direct URL ran a search"); },
    async scrape() { stop.abort(); return new Map(); },
  }), { name: "AbortError" });
});

test("citation IDs survive reopening and the renderer resolves only known anchors", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-web-citation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const mock = await server(t, { "/extract": ({ url }) => ({ url: url.searchParams.get("url"), title: "Report", content: "Verified page text" }) });
  await writeFile(path.join(dir, "web-search.json"), JSON.stringify({ scraperProvider: "keenable", keenableFetchUrl: mock.base + "/extract",
    allowedAddresses: mock.allowedAddresses, rerankerType: "none" }));
  const tools = [];
  createWebSearch(dir)({ registerTool: tool => tools.push(tool) });
  assert.equal(tools.length, 1);
  const [tool] = tools;
  const previous = { type: "message", message: { role: "toolResult", details: { webResearch: { turn: 6 } } } };
  const progress = [];
  const result = await tool.execute("call", { url: firstPage }, undefined, event => progress.push(event.details.webResearch), { sessionManager: { getEntries: () => [previous] } });
  assert.deepEqual(progress.map(event => [event.completed, event.sources[0].status]), [[0, "reading"], [1, "read"]]);
  assert.equal(result.isError, false, result.content[0].text);
  const [source] = result.details.webResearch.sources;
  assert.equal(source.anchor, "turn7search0");
  assert.match(result.content[0].text, /Anchor: \\ue202turn7search0/);
  assert.equal(source.url, firstPage);
  const reserved = new Map([[source.anchor, { url: source.url, title: source.title, number: 1 }]]);
  const tree = { type: "root", children: [{ type: "paragraph", children: [
    { type: "text", value: "Verified.\\ue202turn7search0 " + String.fromCharCode(0xe202) + "turn7search0 unknown \\ue202turn999search0" },
    { type: "inlineCode", value: "\\ue202turn7search0" },
  ] }] };
  remarkWebCitations(reserved)(tree);
  const nodes = tree.children[0].children;
  assert.deepEqual(nodes.filter(node => node.type === "link").map(node => node.url), [firstPage, firstPage]);
  assert.ok(nodes.some(node => node.type === "text" && node.value === "\\ue202turn999search0"));
  assert.ok(nodes.some(node => node.type === "inlineCode" && node.value === "\\ue202turn7search0"));
  const html = renderToStaticMarkup(createElement(ReactMarkdown, {
    remarkPlugins: [[remarkWebCitations, reserved]], children: "Verified.\\ue202turn7search0",
  }));
  assert.match(html, /class="web-citation"/);
  assert.match(html, /href="https:\/\/93\.184\.215\.14\/first"/);
  assert.match(html, />\[1\]<\/a>/);
});

test("desktop settings persist independent selections while keeping API keys out of IPC reads", async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "pi-web-settings-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const settings = createWebSearchSettings(process.cwd(), dir);
  const initial = await settings.get();
  assert.equal(initial.searchProvider, "auto");
  const saved = await settings.save({ searchProvider: "searxng", scraperProvider: "firecrawl", rerankerType: "cohere",
    searxngInstanceUrl: "http://localhost:8080", firecrawlApiUrl: "https://api.firecrawl.dev", keys: { firecrawlApiKey: "fixture-only-key" } });
  assert.deepEqual([saved.searchProvider, saved.scraperProvider, saved.rerankerType], ["searxng", "firecrawl", "cohere"]);
  assert.equal(saved.savedKeys.firecrawlApiKey, true);
  assert.doesNotMatch(JSON.stringify(saved), /fixture-only-key/);
  await settings.save({ ...saved, firecrawlApiUrl: "http://localhost:3002", keys: {} });
  const data = JSON.parse(await readFile(path.join(dir, "web-search.json"), "utf8"));
  assert.equal(data.firecrawlApiKey, undefined);
  assert.ok(data.allowedAddresses.includes("localhost:8080"));
  assert.ok(data.allowedAddresses.includes("localhost:3002"));
});
