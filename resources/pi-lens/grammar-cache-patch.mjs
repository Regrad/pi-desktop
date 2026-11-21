import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { patchPiLensEditDiagnostics } from "./edit-diagnostics-patch.mjs";
import { patchPiLensAnalysis, patchPiLensDispatchDeadline, patchPiLensIsolation, patchPiLensScanIsolation } from "./analysis-patch.mjs";
import { patchPiLensAnalysisHealth } from "./analysis-health-patch.mjs";
import { patchPiLensTreeIsolation } from "./tree-isolation-patch.mjs";
import { patchPiLensAnalysisBindings } from "./analysis-bindings-patch.mjs";
import { patchPiLensExecutablePath } from "./executable-path-patch.mjs";

const analysisHelpers = ["analysis-host.mjs", "analysis-worker.mjs", "analysis-observations.mjs", "analysis-watchdog.mjs",
  "tree-operations.mjs", "analysis-context.mjs", "executable-path.mjs"];
export const piLensBridgeFiles = ["dist/index.js", ...analysisHelpers.map(file => `dist/desktop-analysis/${file}`)];

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
  const { version } = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  if (version !== "4.5.1") throw new Error(`Pi Lens bridge targets 4.5.1, found ${version}`);

  const entry = path.join(packageDir, "dist", "index.js");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(entry));
  let patched = source;
  for (const patch of [patchPiLensAnalysis, patchPiLensIsolation, patchPiLensDispatchDeadline, patchPiLensScanIsolation,
    patchPiLensAnalysisHealth, patchPiLensTreeIsolation, patchPiLensGrammarCache, patchPiLensEditDiagnostics,
    patchPiLensExecutablePath, patchPiLensAnalysisBindings]) {
    patched = patch(patched);
  }
  // Validate patch anchors before modifying the installed bundle.
  const targetDir = path.join(packageDir, "dist", "desktop-analysis");
  await mkdir(targetDir, { recursive: true });
  for (const file of analysisHelpers) {
    await copyFile(new URL(file, import.meta.url), path.join(targetDir, file));
  }
  if (patched !== source) await writeFile(entry, patched, "utf8");
}
