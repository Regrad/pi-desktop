import { createAstPreflight } from "./ast-preflight.mjs";

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
                        // Edited ranges are filtered after matching. A match outside
                        // the edit must not use up the limit for an edited line.
                        found = preflight.findAll(nativeConfig, editScoped ? Infinity : maxMatchesPerRule - collected.length);`);
}

function replaceOne(source, anchor, replacement) {
  const count = typeof anchor === "string" ? source.split(anchor).length - 1 : [...source.matchAll(new RegExp(anchor.source, "g"))].length;
  if (count !== 1) {
    throw new Error(`Pi Lens analysis bridge anchor changed: ${anchor}`);
  }
  return source.replace(anchor, replacement);
}

export function patchPiLensIsolation(source) {
  const marker = "// Pi Desktop: supervised read-only native analysis";
  if (source.includes(marker)) return source;
  const start = source.indexOf("astGrepNapiRunner = {");
  const end = source.indexOf("ast_grep_napi_default = astGrepNapiRunner;", start);
  if (start < 0 || end < 0) throw new Error("Pi Lens native runner changed");

  let runner = source.slice(start, end);
  runner = replaceOne(runner, /const sgModule = await loadSg\(\);\s*if \(!sgModule\) \{\s*return \{ status: "skipped", diagnostics: \[\], semantic: "none" \};\s*\}/, "");
  runner = replaceOne(runner, /const lang = getLang\(ctx.filePath, sgModule\);\s*if \(!lang\) \{\s*return \{ status: "skipped", diagnostics: \[\], semantic: "none" \};\s*\}/, "");
  runner = replaceOne(runner, /let root;\s*try \{\s*root = lang.parse\(content\);[\s\S]*?rootNode = root.root\(\);\s*\} catch \{\s*return \{ status: "skipped", diagnostics: \[\], semantic: "none" \};\s*\}/, "");
  runner = replaceOne(runner, /if \(runningAsLspSubstitute\) \{\s*recordNapiFallbackCoverage\(ctx.filePath\);\s*clearPendingAuxiliaryCoverage\(ctx.filePath, "ast-grep"\);\s*\}/, "");
  runner = replaceOne(runner, "const diagnostics = evaluateAstGrepRules(ctx.filePath, rootNode, ctx.cwd, ctx.kind, {", "const diagnostics = await desktopEvaluateAstGrepRules(ctx.filePath, content, ctx.cwd, ctx.kind, {");
  runner = replaceOne(runner, /content,\s*sgModule\s*\}\);/, "deadlineAt: ctx.desktopAnalysisDeadlineAt\n        });");
  runner = replaceOne(runner, /if \(runningAsLspSubstitute\) \{\s*const bySeverity = \{\};/, `if (runningAsLspSubstitute && !diagnostics.analysisIncomplete) {
          recordNapiFallbackCoverage(ctx.filePath);
          clearPendingAuxiliaryCoverage(ctx.filePath, "ast-grep");
          const bySeverity = {};`);
  runner = replaceOne(runner, "...outOfEditScope.length > 0 && { outOfEditScope },", `...outOfEditScope.length > 0 && { outOfEditScope },
          analysisIncomplete: diagnostics.analysisIncomplete === true,`);

  const helper = `
${marker}
async function desktopEvaluateAstGrepRules(filePath, content, cwd, kind, options = {}, signal) {
    const epochKey = Symbol.for("pi.desktop.native.analysis.epoch");
    const epoch = globalThis[epochKey] ?? 0;
    const defaultDeadline = Date.now() + Math.max(30_000, getRunnerTimeoutFloorMs());
    const { getAnalysisScope } = await import("./desktop-analysis/analysis-context.mjs");
    const scope = getAnalysisScope();
    if (scope && scope.epoch !== epoch) throw new DOMException("Native analysis cancelled", "AbortError");
    const { analyzeAst } = await import("./desktop-analysis/analysis-host.mjs");
    if ((globalThis[epochKey] ?? 0) !== epoch) throw new DOMException("Native analysis cancelled", "AbortError");
    const unsupported = options.unsupportedLanguageLog ?? defaultUnsupportedLanguageLog;
    const { blockingOnly, projectRoot, rulePolicy, modifiedRanges, maxMatchesPerRule, maxTotalDiagnostics } = options;
    const result = await analyzeAst({ filePath, content, cwd, kind,
        unsupportedLanguages: [...unsupported],
        options: { blockingOnly, projectRoot, rulePolicy, modifiedRanges, maxMatchesPerRule, maxTotalDiagnostics }
    }, { signal: signal ?? scope?.signal, deadlineAt: options.deadlineAt ?? scope?.deadlineAt ?? defaultDeadline });
    if ((globalThis[epochKey] ?? 0) !== epoch) throw new DOMException("Native analysis cancelled", "AbortError");
    for (const observation of result.observations) {
        if (observation.type === "latency") logLatency(observation.record);
        else if (observation.type === "once") recordDegradationOnce(observation.record);
        else if (observation.type === "count") incrementDegradationCount(observation.record);
        else if (observation.type === "degradation") recordDegradation(observation.record);
    }
    for (const message of result.logs) options.log?.(message);
    if (!result.evaluated) throw new Error("Native analysis unavailable; analysis incomplete.");
    for (const language of result.unsupportedLanguages) unsupported.add(language);
    if (options.outOfEditScope) options.outOfEditScope.push(...result.outOfEditScope);
    return result.diagnostics;
}
`;
  const runnerSection = "// dist/clients/dispatch/runners/ast-grep-napi.js";
  return replaceOne(source.slice(0, start) + runner + source.slice(end), runnerSection, helper + runnerSection);
}

export function patchPiLensDispatchDeadline(source) {
  const marker = "// Pi Desktop: native executor shares the dispatch deadline";
  if (source.includes(marker)) return source;
  const anchor = 'const runnerPromise = spawnCooldownScope.run({ tool: runner.id, subject: runner.id, phase: "lint" }, () => runner.run(ctx)).then((value) => ({ value }));';
  return replaceOne(source, anchor, marker + "\n    " +
    anchor.replace("runner.run(ctx)", "runner.run({ ...ctx, desktopAnalysisDeadlineAt: Date.now() + timeoutMs })"));
}

export function patchPiLensScanIsolation(source) {
  const marker = "// Pi Desktop: project scans use the supervised native executor";
  if (source.includes(marker)) return source;
  const start = source.indexOf("async function scanFileMajorRules(");
  const end = source.indexOf("var AST_GREP_MAX_FILE_BYTES", start);
  if (start < 0 || end < 0) throw new Error("Pi Lens project scan changed");
  let scan = source.slice(start, end);
  scan = replaceOne(scan, "const astGrep = [];", "const astGrep = []; let astGrepFailed = false;");
  scan = replaceOne(scan, "const sgModule = await loadSg();", "");
  scan = replaceOne(scan, "sgModule && canHandle(filePath)", "canHandle(filePath)");
  scan = replaceOne(scan, "astGrepLang = getLang(filePath, sgModule);", "astGrepLang = true;");
  scan = replaceOne(scan, "const scanAstGrepFile = (filePath, content, lang) => {", "const scanAstGrepFile = async (filePath, content) => {");
  scan = replaceOne(scan, "scanAstGrepFile(filePath, content, astGrepLang);", "await scanAstGrepFile(filePath, content);");
  scan = replaceOne(scan, "const rootNode = lang.parse(content).root();", "");
  scan = replaceOne(scan, "const fileDiagnostics = evaluateAstGrepRules(filePath, rootNode, cwd, detectFileKind(filePath), {",
    "const fileDiagnostics = await desktopEvaluateAstGrepRules(filePath, content, cwd, detectFileKind(filePath), {");
  scan = replaceOne(scan, /maxTotalDiagnostics: AST_GREP_SCAN_MAX_DIAGNOSTICS_PER_FILE,\s*content,\s*sgModule\s*\}\);/,
    "maxTotalDiagnostics: AST_GREP_SCAN_MAX_DIAGNOSTICS_PER_FILE\n      }, signal);\n      if (fileDiagnostics.analysisIncomplete) astGrepFailed = true;");
  scan = replaceOne(scan, /astGrep.push\(fromDispatchDiagnostic\(diagnostic, "ast-grep-napi"\)\);\s*\}\s*\} catch \{/, `astGrep.push(fromDispatchDiagnostic(diagnostic, "ast-grep-napi"));
      }
    } catch (error) {
      astGrepFailed = true;
      logTreeSitter({ phase: "runner_skip", filePath, status: "failed", reason: String(error), metadata: { runner: "ast-grep-napi" } });`);
  scan = scan.replace(/^([ \t]*)wasmAborted,$/gm, "$1wasmAborted, astGrepFailed,");
  scan = replaceOne(scan, "let wasmAborted = false;", "let wasmAborted = false; let nativeAnalysisIncomplete = false;");
  scan = replaceOne(scan, "wasmAborted = scanned.wasmAborted;", "wasmAborted = scanned.wasmAborted; nativeAnalysisIncomplete = scanned.astGrepFailed;");
  scan = replaceOne(scan, "if (signal?.aborted || options.files || wasmAborted)",
    'if (nativeAnalysisIncomplete) { snapshot.scanTruncated = true; snapshot.astGrepStatus = "incomplete"; }\n  if (signal?.aborted || options.files || wasmAborted || nativeAnalysisIncomplete)');
  return source.slice(0, start) + marker + "\n" + scan + source.slice(end);
}
