import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
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
  const { GRAMMARS, loadManifest, downloadGrammar, sidecarPathFor } = await import(pathToFileURL(path.join(packageDir, "scripts", "download-grammars.js")).href);
  const manifest = loadManifest();
  const grammarDir = path.join(packageDir, "grammars");
  await mkdir(grammarDir, { recursive: true });
  let totalBytes = 0;
  // The upstream downloader tolerates failures; distribution preparation must not.
  for (const name of GRAMMARS) {
    const file = path.join(grammarDir, name);
    const hash = manifest.grammars[name];
    if (!await verifyGrammar(file, hash)) {
      // Upstream checks the stamp to skip downloads. A corrupt file can still
      // have its original stamp, so invalidate it after our byte-level check.
      await rm(sidecarPathFor(file), { force: true });
      await downloadGrammar(grammarDir, name, manifest);
      if (!await verifyGrammar(file, hash)) throw new Error(`Pi Lens grammar ${name} failed verification after downloading`);
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
