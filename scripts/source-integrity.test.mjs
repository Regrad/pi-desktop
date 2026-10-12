import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Parser, Language } from "web-tree-sitter";
const root = fileURLToPath(new URL("..", import.meta.url));
async function sources(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.filter(entry => !["bin", "obj", "grammars", "workflows", "skills"].includes(entry.name)).map(entry => {
    const filename = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(filename) : /\.(?:[cm]?js|[cm]?ts|tsx|cs)$/.test(entry.name) ? [filename] : [];
  }));
  return files.flat();
}
const files = (await Promise.all(["electron", "shared", "src", "resources", "client-agent", "scripts"].map(dir => sources(path.join(root, dir))))).flat();
test("all owned source files remain valid UTF-8 and parse without syntax errors", async t => {
  t.diagnostic(`Checked ${files.length} source files across all six application layers; no type-check or build was run.`);
  await Parser.init();
  const parsers = new Map();
  const failures = [];
  try {
    for (const filename of files) {
      const source = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(filename));
      const grammar = filename.endsWith(".cs") ? "c_sharp" : filename.endsWith(".tsx") ? "tsx" : /\.[cm]?ts$/.test(filename) ? "typescript" : "javascript";
      let parser = parsers.get(grammar);
      if (!parser) {
        parser = new Parser();
        parser.setLanguage(await Language.load(path.join(root, "node_modules", "pi-lens", "grammars", `tree-sitter-${grammar}.wasm`)));
        parsers.set(grammar, parser);
      }
      // The bundled grammar predates TS import types; these valid type-only
      // expressions are normalised for parsing, not altered in project files.
      const parsedSource = grammar === "typescript" || grammar === "tsx"
        ? source.replace(/\btypeof\s+import\("[^"]+"\)\.\w+/g, "(() => unknown)").replace(/\btypeof\s+import\("[^"]+"\)/g, "object").replace(/\bimport\("[^"]+"\)\.([A-Za-z_]\w*)/g, "$1") : source;
      const tree = parser.parse(parsedSource);
      if (tree.rootNode.hasError) failures.push(path.relative(root, filename));
      tree.delete();
    }
    assert.deepEqual(failures, [], "Tree-sitter syntax errors");
  } finally { for (const parser of parsers.values()) parser.delete(); }
});
test("renderer preload commands all have main-process handlers", async () => {
  const preload = await readFile(path.join(root, "electron", "preload.cts"), "utf8");
  const main = await readFile(path.join(root, "electron", "main.ts"), "utf8");
  const commands = [...preload.matchAll(/ipcRenderer\.invoke\("([^"]+)"/g)].map(match => match[1]);
  const handlers = new Set([...main.matchAll(/ipcMain\.handle\(\s*"([^"]+)"/g)].map(match => match[1]));
  assert.deepEqual(commands.filter(command => !handlers.has(command)), []);
  assert.equal(new Set(commands).size, commands.length, "Duplicate exposed command");
});
test("relative source imports resolve before packaging", async () => {
  const failures = [];
  for (const filename of files.filter(file => !file.endsWith(".cs"))) {
    const source = await readFile(filename, "utf8");
    for (const match of source.matchAll(/(?:^import\s[^\n]*?\sfrom\s|^export\s[^\n]*?\sfrom\s|^import\s)["'](\.[^"']+)["']/gm)) {
      const resolved = path.resolve(path.dirname(filename), match[1]);
      // Smoke tests deliberately target the installed/compiled distribution.
      if (resolved.includes(`${path.sep}dist-electron${path.sep}`)) continue;
      const candidates = [resolved, `${resolved}.ts`, `${resolved}.tsx`, resolved.replace(/\.js$/, ".ts"), resolved.replace(/\.js$/, ".tsx"), resolved.replace(/\.cjs$/, ".cts")];
      if (filename === path.join(root, "resources", "pi-rpc-bridge", "rpc-mode.js")) {
        // This file is installed into Pi's RPC directory by apply-rpc-bridge.
        candidates.push(path.resolve(root, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "modes", "rpc", match[1]));
      }
      if (!(await Promise.all(candidates.map(candidate => access(candidate).then(() => true, () => false)))).some(Boolean)) failures.push(`${path.relative(root, filename)}: ${match[1]}`);
    }
  }
  assert.deepEqual(failures, []);
});
