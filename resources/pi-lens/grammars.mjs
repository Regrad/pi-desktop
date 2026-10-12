import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function verifyGrammar(file, expectedHash) {
  if (typeof expectedHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(expectedHash))
    throw new Error(`Missing pinned grammar hash: ${path.basename(file)}`);
  try {
    const bytes = await readFile(file);
    return bytes.subarray(0, 4).equals(Buffer.from([0, 97, 115, 109]))
      && `sha256:${createHash("sha256").update(bytes).digest("hex")}` === expectedHash;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function ensurePiLensGrammars(packageDir) {
  const { GRAMMARS, loadManifest } = await import(pathToFileURL(path.join(packageDir, "scripts", "download-grammars.js")).href);
  const { downloadGrammarDetailed } = await import(pathToFileURL(path.join(packageDir, "dist", "clients", "grammar-source.js")).href);
  const manifest = loadManifest();
  let totalBytes = 0;
  // The upstream downloader tolerates failures; distribution preparation must not.
  for (const name of GRAMMARS) {
    const file = path.join(packageDir, "grammars", name);
    const hash = manifest.grammars[name];
    if (!await verifyGrammar(file, hash)) {
      const result = await downloadGrammarDetailed(path.dirname(file), name);
      if (!result.ok || !await verifyGrammar(file, hash))
        throw new Error(`Pi Lens grammar ${name} could not be downloaded and verified: ${result.reason ?? "download or integrity failure"}`);
    }
    totalBytes += (await readFile(file)).length;
  }
  // Vendored grammars must ship with Pi Lens; never substitute an unpinned download.
  for (const [name, metadata] of Object.entries(manifest.vendored ?? {})) {
    const file = path.join(packageDir, "vendor", "grammars", name);
    if (!await verifyGrammar(file, metadata.sha256)) throw new Error(`Missing or corrupt vendored grammar: ${name}`);
    totalBytes += (await readFile(file)).length;
  }
  return { count: GRAMMARS.length + Object.keys(manifest.vendored ?? {}).length, totalBytes };
}
