import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createAstPreflight } from "./ast-preflight.mjs";
import { patchPiLensTreeIsolation, treeIsolationFiles } from "./tree-isolation-patch.mjs";
import { patchPiLensAnalysisHealth } from "./analysis-health-patch.mjs";

const marker = "// Pi Desktop: necessary-condition AST preflight";
export function patchPiLensAnalysis(source) {
  const helper = `${marker}\n${createAstPreflight.toString()}\nconst desktopAstPreflights = new WeakMap();\n`;
  if (source.includes(marker)) {
    const region = /\/\/ Pi Desktop: necessary-condition AST preflight[\s\S]*?const desktopAstPreflights = new WeakMap\(\);\r?\n/;
    if (!region.test(source)) throw new Error("Pi Lens existing analysis bridge is incompatible");
    return source.replace(region, () => helper);
  }
  const anchor = "found = scope.root.findAll(nativeConfig);";
  if (source.split(anchor).length !== 2 || !source.includes("function evaluateAstGrepRules(")) {
    throw new Error("Pi Lens analysis bridge is incompatible; native matching was not changed.");
  }
  return source.replace(/(?:export )?function evaluateAstGrepRules\(/, match => `${helper}${match}`)
    .replace(anchor, `let preflight = desktopAstPreflights.get(scope.root);
                        if (!preflight) {
                            preflight = createAstPreflight(scope.root);
                            desktopAstPreflights.set(scope.root, preflight);
                        }
                        found = preflight.findAll(nativeConfig, maxMatchesPerRule - collected.length);`);
}

export function patchPiLensIsolation(source, bundled = false) {
  const isolationMarker = "// Pi Desktop: supervised read-only native analysis";
  if (source.includes(isolationMarker)) {
    const region = /\/\/ Pi Desktop: supervised read-only native analysis\r?\n(?:export )?async function desktopEvaluateAstGrepRules\([\s\S]*?return result.diagnostics;\s*\}\r?\n/;
    if (!region.test(source)) throw new Error("Pi Lens existing isolation bridge is incompatible");
    let result = source.replace(region, () => helperForCurrentVersion());
    if (!result.includes("deadlineAt: ctx.desktopAnalysisDeadlineAt")) result = result.replace("blockingOnly: runningAsLspSubstitute ? false : ctx.blockingOnly,", "blockingOnly: runningAsLspSubstitute ? false : ctx.blockingOnly, deadlineAt: ctx.desktopAnalysisDeadlineAt,");
    return nativeHealth(result);
  }
  const runnerStart = source.indexOf(bundled ? "astGrepNapiRunner = {" : "const astGrepNapiRunner = {");
  if (runnerStart < 0) throw new Error("Pi Lens native runner isolation is incompatible");
  const before = source.slice(0, runnerStart);
  let runner = source.slice(runnerStart);
  function replaceOne(pattern, value) {
    const matches = [...runner.matchAll(new RegExp(pattern.source, "g"))];
    if (matches.length !== 1) throw new Error("Pi Lens native runner isolation anchor changed");
    runner = runner.replace(pattern, value);
  }
  replaceOne(/const sgModule = await loadSg\(\);\s*if \(!sgModule\) \{\s*return \{ status: "skipped", diagnostics: \[\], semantic: "none" \};\s*\}/, "");
  replaceOne(/const lang = getLang\(ctx.filePath, sgModule\);\s*if \(!lang\) \{\s*return \{ status: "skipped", diagnostics: \[\], semantic: "none" \};\s*\}/, "");
  replaceOne(/let root;\s*try \{\s*root = lang.parse\(content\);\s*\}\s*catch \{\s*return \{ status: "skipped", diagnostics: \[\], semantic: "none" \};\s*\}\s*let rootNode;\s*try \{\s*rootNode = root.root\(\);\s*\}\s*catch \{\s*return \{ status: "skipped", diagnostics: \[\], semantic: "none" \};\s*\}/, "");
  replaceOne(/recordNapiFallbackCoverage\(ctx.filePath\);\s*clearPendingAuxiliaryCoverage\(ctx.filePath, "ast-grep"\);/, "// Coverage is recorded only after the isolated pass completes below.");
  replaceOne(/const diagnostics = evaluateAstGrepRules\(ctx.filePath, rootNode, ctx.cwd, ctx.kind, \{/, "const diagnostics = await desktopEvaluateAstGrepRules(ctx.filePath, content, ctx.cwd, ctx.kind, {");
  replaceOne(/content,\s*sgModule,?\s*\}\);\s*if \(runningAsLspSubstitute\) \{/, `content,
        });
        if (runningAsLspSubstitute) {
            recordNapiFallbackCoverage(ctx.filePath);
            clearPendingAuxiliaryCoverage(ctx.filePath, "ast-grep");`);

  function helperForCurrentVersion() {
    const hostPath = bundled ? "./desktop-analysis/analysis-host.mjs" : "../../../desktop-analysis/analysis-host.mjs";
    const helper = `${isolationMarker}
${bundled ? "" : "export "}async function desktopEvaluateAstGrepRules(filePath, content, cwd, kind, options = {}, signal) {
    const epochKey = Symbol.for("pi.desktop.native.analysis.epoch");
    const epoch = globalThis[epochKey] ?? 0;
    const { getAnalysisScope } = await import(${JSON.stringify(bundled ? "./desktop-analysis/analysis-context.mjs" : "../../../desktop-analysis/analysis-context.mjs")});
    const scope = getAnalysisScope();
    if (scope && scope.epoch !== epoch) throw new DOMException("Native analysis cancelled", "AbortError");
    const { analyzeAst } = await import(${JSON.stringify(hostPath)});
    if ((globalThis[epochKey] ?? 0) !== epoch) throw new DOMException("Native analysis cancelled", "AbortError");
    const unsupported = options.unsupportedLanguageLog ?? defaultUnsupportedLanguageLog;
    const result = await analyzeAst({ filePath, content, cwd, kind,
        unsupportedLanguages: [...unsupported],
        options: { blockingOnly: options.blockingOnly, projectRoot: options.projectRoot,
            maxMatchesPerRule: options.maxMatchesPerRule, maxTotalDiagnostics: options.maxTotalDiagnostics }
    }, { signal: signal ?? scope?.signal, deadlineAt: options.deadlineAt ?? scope?.deadlineAt });
    if ((globalThis[epochKey] ?? 0) !== epoch) throw new DOMException("Native analysis cancelled", "AbortError");
    for (const observation of result.observations) {
        if (observation.type === "latency") logLatency(observation.record);
        else if (observation.type === "once") recordDegradationOnce(observation.record);
        else if (observation.type === "count") incrementDegradationCount(observation.record);
    }
    for (const message of result.logs) options.log?.(message);
    if (!result.evaluated) throw new Error("Native analysis unavailable; analysis incomplete.");
    for (const language of result.unsupportedLanguages) unsupported.add(language);
    return result.diagnostics;
}
`;
    return helper;
  }
  runner = runner.replace("blockingOnly: runningAsLspSubstitute ? false : ctx.blockingOnly,", "blockingOnly: runningAsLspSubstitute ? false : ctx.blockingOnly, deadlineAt: ctx.desktopAnalysisDeadlineAt,");
  return nativeHealth(before + helperForCurrentVersion() + runner);

  function nativeHealth(result) {
    const start = result.indexOf(bundled ? "astGrepNapiRunner = {" : "const astGrepNapiRunner = {");
    const next = bundled ? result.indexOf("\n// dist/", start) : -1;
    const end = next < 0 ? result.length : next;
    let section = result.slice(start, end);
    if (!section.includes("analysisIncomplete: diagnostics.analysisIncomplete")) {
      section = section.replace(/(status: hasBlocking \? "failed" : "succeeded",\n)(\s*)diagnostics,/, '$1$2analysisIncomplete: diagnostics.analysisIncomplete === true,\n$2diagnostics,');
      if (!section.includes("analysisIncomplete: diagnostics.analysisIncomplete")) throw new Error("Pi Lens native health result changed");
    }
    section = section.replace(/if \(runningAsLspSubstitute\) \{(\s*)recordNapiFallbackCoverage/, 'if (runningAsLspSubstitute && !diagnostics.analysisIncomplete) {$1recordNapiFallbackCoverage');
    return result.slice(0, start) + section + result.slice(end);
  }
}

export function patchPiLensDispatchDeadline(source) {
  const deadlineMarker = "// Pi Desktop: native executor shares the dispatch deadline";
  if (source.includes(deadlineMarker)) return source.replace('runner.run(runner.id === "ast-grep-napi" ? { ...ctx, desktopAnalysisDeadlineAt: Date.now() + timeoutMs } : ctx)', 'runner.run({ ...ctx, desktopAnalysisDeadlineAt: Date.now() + timeoutMs })');
  const call = "runner.run(ctx).finally(() => clearTimeout(timer))";
  if (source.split(call).length !== 2) throw new Error("Pi Lens dispatch deadline bridge is incompatible");
  return source.replace(call, `${deadlineMarker}\n            runner.run({ ...ctx, desktopAnalysisDeadlineAt: Date.now() + timeoutMs }).finally(() => clearTimeout(timer))`);
}

export function patchPiLensScanIsolation(source) {
  const scanMarker = "// Pi Desktop: project scans use the supervised native executor";
  if (source.includes(scanMarker)) return scanHealth(source);
  if (!source.includes("const scanAstGrepFile = (filePath, content, lang) => {") ||
      !source.includes("const rootNode = lang.parse(content).root();")) throw new Error("Pi Lens project-scan isolation is incompatible");
  let result = source;
  if (source.includes('from "../dispatch/runners/ast-grep-napi.js"')) {
    result = result.replace("evaluateAstGrepRules, loadSg,", "desktopEvaluateAstGrepRules, loadSg,");
  }
  result = result
    .replace("const scanAstGrepFile = (filePath, content, lang) => {", "const scanAstGrepFile = async (filePath, content, lang) => {")
    .replace("const rootNode = lang.parse(content).root();", "")
    .replace("const fileDiagnostics = evaluateAstGrepRules(filePath, rootNode, cwd, detectFileKind(filePath), {", "const fileDiagnostics = await desktopEvaluateAstGrepRules(filePath, content, cwd, detectFileKind(filePath), {")
    .replace(/(maxTotalDiagnostics: AST_GREP_SCAN_MAX_DIAGNOSTICS_PER_FILE,\s*content,)\s*sgModule,?\s*\}\);/, "$1}, signal);")
    .replace("scanAstGrepFile(filePath, content, astGrepLang);", "await scanAstGrepFile(filePath, content, astGrepLang);");
  const start = result.indexOf("async function scanFileMajorRules(");
  const publicStart = result.indexOf("async function scanProjectDiagnostics(", start);
  if (start < 0 || publicStart < 0) throw new Error("Pi Lens scan lifecycle anchors changed");
  // Keep failure information across the file-major/public boundary. A partial
  // scan must never overwrite the durable complete-project cache.
  let major = result.slice(start, publicStart)
    .replace("const astGrep = [];", "const astGrep = []; let astGrepFailed = false;")
    .replace("const sgModule = await loadSg();", "")
    .replace("sgModule && astGrepCanHandle(filePath)", "astGrepCanHandle(filePath)")
    .replace("astGrepGetLang(filePath, sgModule)", "true")
    .replace(/\bwasmAborted,\s*$/gm, "wasmAborted, astGrepFailed,");
  const nativeStart = major.indexOf("const scanAstGrepFile = async");
  const nativeEnd = major.indexOf("const scan = async", nativeStart);
  const native = major.slice(nativeStart, nativeEnd).replace(/\}\s*catch \{[\s\S]*?\}\s*finally \{/, `} catch (error) {
      astGrepFailed = true;
      logTreeSitter({ phase: "runner_skip", filePath, status: "failed", reason: String(error), metadata: { runner: "ast-grep-napi" } });
    } finally {`);
  major = major.slice(0, nativeStart) + native + major.slice(nativeEnd);
  let tail = result.slice(publicStart)
    .replace("let wasmAborted = false;", "let wasmAborted = false; let nativeAnalysisIncomplete = false;")
    .replace("wasmAborted = scanned.wasmAborted;", "wasmAborted = scanned.wasmAborted; nativeAnalysisIncomplete = scanned.astGrepFailed;")
    .replace("if (wasmAborted) {", 'if (nativeAnalysisIncomplete) { snapshot.scanTruncated = true; snapshot.astGrepStatus = "incomplete"; }\n    if (wasmAborted) {')
    .replace("signal?.aborted || options.files || wasmAborted", "signal?.aborted || options.files || wasmAborted || nativeAnalysisIncomplete");
  return scanHealth(scanMarker + "\n" + result.slice(0, start) + major + tail);

  function scanHealth(result) {
    if (result.includes("if (fileDiagnostics.analysisIncomplete) astGrepFailed = true;")) return result;
    const start = result.indexOf("const scanAstGrepFile = async");
    const end = result.indexOf("const scan = async", start);
    if (start < 0 || end < 0) throw new Error("Pi Lens native scan lifecycle changed");
    const section = result.slice(start, end);
    const anchor = section.match(/for \(const diagnostic\d* of fileDiagnostics\) \{/)?.[0];
    if (!anchor) throw new Error("Pi Lens native scan findings changed");
    if (section.split(anchor).length !== 2) throw new Error("Pi Lens native scan coverage changed");
    return result.slice(0, start) + section.replace(anchor, "if (fileDiagnostics.analysisIncomplete) astGrepFailed = true;\n            " + anchor) + result.slice(end);
  }
}

export async function applyPiLensAnalysis(packageDir) {
  const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
  if (manifest.version !== "4.3.0") throw new Error(`Pi Lens analysis bridge targets 4.3.0, found ${manifest.version}`);
  const files = [...new Set(["dist/index.js", "dist/clients/dispatch/runners/ast-grep-napi.js", "dist/clients/project-diagnostics/scanner.js", "dist/clients/dispatch/dispatcher.js", ...treeIsolationFiles])];
  const changes = await Promise.all(files.map(async name => {
    const file = path.join(packageDir, name);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(file));
    let patched = source;
    if (name.endsWith("dispatcher.js")) patched = patchPiLensDispatchDeadline(source);
    else if (name.endsWith("scanner.js")) patched = patchPiLensScanIsolation(source);
    else if (name === "dist/index.js" || name.endsWith("ast-grep-napi.js")) patched = patchPiLensIsolation(patchPiLensAnalysis(source), name === "dist/index.js");
    if (name === "dist/index.js") patched = patchPiLensDispatchDeadline(patchPiLensScanIsolation(patched));
    if (name === "dist/index.js" || name.endsWith("dispatch/dispatcher.js")) patched = patchPiLensAnalysisHealth(patched);
    if (name === "dist/index.js" || treeIsolationFiles.includes(name)) patched = patchPiLensTreeIsolation(patched, name);
    return { file, source, patched };
  }));
  const targetDir = path.join(packageDir, "dist", "desktop-analysis");
  await mkdir(targetDir, { recursive: true });
  for (const name of ["analysis-host.mjs", "analysis-worker.mjs", "analysis-observations.mjs", "analysis-watchdog.mjs", "tree-operations.mjs", "analysis-context.mjs"]) {
    await copyFile(new URL(name, import.meta.url), path.join(targetDir, name));
  }
  for (const { file, source, patched } of changes) {
    if (source !== patched) await writeFile(file, patched, "utf8");
  }
}
