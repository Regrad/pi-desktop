import assert from "node:assert/strict";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isPublicAddress, publicUrl, requestText } from "../resources/pi-web-search/http.mjs";
import { createWebSearch } from "../resources/pi-web-search/index.mjs";
import { searchWeb } from "../resources/pi-web-search/providers.mjs";
import { extractPage, relevantExcerpt, researchWeb } from "../resources/pi-web-search/research.mjs";

test("public page fetches reject private, reserved and unsupported destinations", async () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:192.168.1.1", "fc00::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const url of ["file:///C:/Windows", "http://0x7f000001", "https://[::1]", "http://169.254.169.254", "http://localhost",
    "https://user:pass@example.org", "http://example.org:8080"]) {
    assert.throws(() => publicUrl(url), undefined, url);
  }
  await assert.rejects(requestText("http://127.0.0.1", { page: true }), /public website/);
  assert.equal(publicUrl("https://example.org/a#heading").href, "https://example.org/a");
});

test("extracts readable passages and public references from HTML", () => {
  const result = extractPage({
    url: "https://example.org/docs/page", contentType: "text/html",
    text: "<html><head><title>Руководство</title></head><body><nav>Menu</nav><main><article><h2>Веб-поиск</h2><script>throw new Error()</script><p>Читайте <a href='../sources'>документацию</a>.</p></article></main></body></html>",
  });
  assert.equal(result.title, "Руководство");
  assert.match(result.text, /документацию \(https:\/\/example.org\/sources\)/);
  assert.doesNotMatch(result.text, /Menu|Error/);
  assert.match(relevantExcerpt("irrelevant filler ".repeat(100) + "\n\nПрочитать источники и выделить фрагменты.", "найти фрагменты", 64), /выделить фрагменты/);
});

test("one search reads five unique pages concurrently and labels unread snippets", async () => {
  const progress = [], reads = [];
  const url = index => `https://example.org/${index}`;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const io = {
    async search() {
      return { provider: "fixture", results: [...[1, 1, 2, 3, 4, 5, 6].map(index => ({ url: url(index), title: String(index), snippet: "only from search" })),
        { url: "http://127.0.0.1/", title: "private" }] };
    },
    async read(address) {
      reads.push(address);
      if (reads.length === 5) ready();
      await gate;
      if (address === url(2)) throw new Error("Blocked");
      return { url: address, title: "Page title", text: "Actually extracted" };
    },
  };
  const pending = researchWeb({ query: "test" }, {}, AbortSignal.timeout(1000), event => progress.push(event), io);
  try {
    await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error("Pages did not start in parallel")), 500))]);
    assert.deepEqual(reads, [1, 2, 3, 4, 5].map(url));
  } finally {
    release();
  }
  const result = await pending;
  assert.deepEqual(progress.map(event => event.phase), ["searching", "reading"]);
  assert.deepEqual(result.sources.map(source => source.status), ["read", "snippet", "read", "read", "read"]);
  assert.equal(result.sources[1].excerpt, "only from search");
});

test("direct URLs bypass search and cancellation discards ongoing results", async () => {
  const stop = new AbortController();
  await assert.rejects(researchWeb({ url: "https://example.org" }, {}, stop.signal, () => {}, {
    search() { assert.fail("direct URL ran a search"); },
    async read() { stop.abort(); return { url: "https://example.org/", text: "Late result" }; },
  }), { name: "AbortError" });
});

test("configured SearXNG can use a local address, while provider redirects and page reads stay separate", async t => {
  let requests = 0;
  const server = createServer((req, res) => {
    requests += 1;
    if (req.url.startsWith("/redirect/")) {
      res.writeHead(302, { Location: "http://127.0.0.1/should-not-follow" }).end();
      return;
    }
    const query = new URL(req.url, "http://fixture").searchParams;
    assert.equal(query.get("q"), "LibreChat");
    assert.equal(query.get("format"), "json");
    res.end(JSON.stringify({ results: [{ title: "Search", url: "https://example.org/", content: "Snippet" }] }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const result = await searchWeb("LibreChat", { provider: "searxng", searxngBaseUrl: base });
  assert.equal(result.results[0].snippet, "Snippet");
  await assert.rejects(searchWeb("LibreChat", { provider: "searxng", searxngBaseUrl: base + "/redirect" }), /redirects/);
  await assert.rejects(requestText(base, { page: true }), /public website/);
  assert.equal(requests, 2);
});

test("the built-in registers one tool and validates input before making a request", async () => {
  const tools = [];
  createWebSearch(path.join(tmpdir(), "unused-agent"))({ registerTool: tool => tools.push(tool) });
  assert.deepEqual(tools.map(tool => tool.name), ["web_search"]);
  assert.equal((await tools[0].execute("call", {})).isError, true);
  assert.equal((await tools[0].execute("call", { url: "http://127.0.0.1" })).isError, true);
});
