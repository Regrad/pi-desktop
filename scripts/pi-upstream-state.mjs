import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export function isGeneratedPiPath(relative) {
  return /(^|\/)(node_modules|dist)(\/|$)/.test(relative) ||
    relative.startsWith("packages/ai/src/providers/data/") ||
    /^packages\/tui\/native\/[^/]+\/prebuilds\//.test(relative);
}

export async function inventory(root, skip = () => false) {
  const files = {};
  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (skip(path.relative(root, file).split(path.sep).join("/"))) continue;
      if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink in source inventory: ${file}`);
      if (entry.isDirectory()) await visit(file);
      else files[path.relative(root, file).split(path.sep).join("/")] = createHash("sha256").update(await readFile(file)).digest("hex");
    }
  }
  await visit(root);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

// Git's upstream .gitattributes prescribes LF/CRLF checkout conversions.
// Keep raw archive hashes for provenance, and accept only that conversion for
// valid UTF-8 text. Binary files always require the original byte hash.
export async function textInventory(root, files) {
  const hashes = {};
  for (const relative of Object.keys(files)) {
    const bytes = await readFile(path.join(root, relative));
    if (bytes.includes(0)) continue;
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { continue; }
    hashes[relative] = createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
  }
  return hashes;
}

export async function verifyUpstream(root) {
  const manifest = JSON.parse(await readFile(path.join(root, "vendor/pi.upstream.json"), "utf8"));
  const assetManifest = JSON.parse(await readFile(path.join(root, "vendor/pi-assets.json"), "utf8"));
  for (const [directory, files] of [["vendor/pi", manifest.files], ["vendor/pi-assets", assetManifest.files]]) {
    const actualFiles = await inventory(path.join(root, directory), directory === "vendor/pi" ? isGeneratedPiPath : undefined);
    const extras = Object.keys(actualFiles).filter(file => !(file in files));
    if (extras.length) throw new Error(`Unrecorded upstream files in ${directory}: ${extras.join(", ")}. Preserve local changes before synchronizing.`);
    for (const [relative, hash] of Object.entries(files)) {
      if (path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error(`Invalid upstream path: ${relative}`);
      const file = path.join(root, directory, relative);
      const actual = actualFiles[relative] ?? createHash("sha256").update(await readFile(file)).digest("hex");
      if (actual !== hash) {
        const textHash = directory === "vendor/pi" && manifest.textHashes?.[relative];
        const normalized = textHash && createHash("sha256").update(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(file)).replace(/\r\n/g, "\n")).digest("hex");
        if (normalized !== textHash || !textHash) throw new Error(`Original Pi source/asset was modified: ${file}. Keep desktop changes outside vendor/pi.`);
      }
    }
  }
  return manifest;
}
