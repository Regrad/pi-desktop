import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { patchPiLensEditDiagnostics } from "./edit-diagnostics-patch.mjs";
import { applyPiLensAnalysis } from "./analysis-patch.mjs";
import { applyPiLensExecutablePath } from "./executable-path-patch.mjs";

// Keep installed grammars read-only; lazy downloads belong to portable data.
export function patchPiLensGrammarCache(source) {
  const marker = "// Pi Desktop: writable portable grammar cache";
  if (source.includes(marker)) return source;
  const writeMethod = /grammarsWriteDir\(\) \{\s*const pkgDir = this\.webTreeSitterPackageDir\(\);\s*return pkgDir \? (path\d*)\.join\(pkgDir, "grammars"\) : (?:undefined|void 0);/;
  const readAnchor = "push(this.bundledGrammarsDir());";
  const fetchAnchor = /const dir = this\.grammarsDir && (fs\d*)\.existsSync\(this\.grammarsDir\)/;
  if (!writeMethod.test(source) || source.split(readAnchor).length !== 2 || !fetchAnchor.test(source))
    throw new Error("Pi Lens grammar-cache bridge is incompatible with this version; cache routing was not applied.");
  return source.replace(writeMethod, (match, pathName) => match.replace("const pkgDir", `${marker}\n        if (process.env.PI_DESKTOP_DATA_DIR)\n            return ${pathName}.join(process.env.PI_DESKTOP_DATA_DIR, "pi-lens", "grammars");\n        const pkgDir`))
    .replace(readAnchor, `${readAnchor}\n        push(this.grammarsWriteDir());`)
    .replace(fetchAnchor, "const dir = process.env.PI_DESKTOP_DATA_DIR ? this.grammarsWriteDir() : this.grammarsDir && $1.existsSync(this.grammarsDir)");
}

export async function applyPiLensGrammarCache(packageDir) {
  await applyPiLensAnalysis(packageDir);
  const files = ["dist/index.js", "dist/clients/tree-sitter-client.js", "dist/clients/read-guard-tool-lines.js"];
  // Validate both builds before changing either file; bundled index is the Pi entry point.
  const changes = await Promise.all(files.map(async name => {
    const file = path.join(packageDir, name);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file));
    let patched = name === "dist/clients/read-guard-tool-lines.js" ? source : patchPiLensGrammarCache(source);
    if (name !== "dist/clients/tree-sitter-client.js") patched = patchPiLensEditDiagnostics(patched);
    return { file, source, patched };
  }));
  for (const { file, source, patched } of changes)
    if (source !== patched) await writeFile(file, patched, "utf8");
  await applyPiLensExecutablePath(packageDir);
}
