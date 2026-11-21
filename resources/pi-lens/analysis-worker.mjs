import { readFile } from "node:fs/promises";
import { takeObservations } from "./analysis-observations.mjs";
import { startAnalysisWatchdog } from "./analysis-watchdog.mjs";
const watchdog = startAnalysisWatchdog();
globalThis[Symbol.for("pi.desktop.analysis.worker")] = true;
// Install the observation sinks before any original analyzer imports them.
const { getAnalysisBindings, runTreeOperation } = await import("./tree-operations.mjs");

process.on("message", async message => {
  const { id, payload } = message;
  watchdog.arm(message.deadlineAt);
  process.send({ id, started: true });
  try {
    if (payload.engine === "tree") {
      const result = await runTreeOperation(payload);
      process.send({ id, result });
      return;
    }
    const { loadSg, getLang, evaluateAstGrepRules } = await getAnalysisBindings();
    const sgModule = await loadSg();
    const lang = sgModule && getLang(payload.filePath, sgModule);
    if (!lang) {
      process.send({ id, result: { evaluated: false, diagnostics: [], observations: takeObservations(), logs: [] } });
      return;
    }
    const rootNode = lang.parse(payload.content).root();
    const logs = [];
    const unsupportedLanguageLog = new Set(payload.unsupportedLanguages);
    const outOfEditScope = [];
    const options = { ...payload.options, outOfEditScope, content: payload.content, sgModule, unsupportedLanguageLog, log: message => logs.push(message) };
    const diagnostics = evaluateAstGrepRules(payload.filePath, rootNode, payload.cwd, payload.kind, options);
    // Native rejection is partial coverage, not proof of a clean file. Retain
    // other rules' genuine findings and carry the health flag separately.
    if (logs.some(message => message.includes("rejected by native engine"))) diagnostics.analysisIncomplete = true;
    // Even verification IO belongs in the supervised executor: an unavailable
    // network share must not strand the parent in an uncancellable read.
    if (await readFile(payload.filePath, "utf8") !== payload.content) throw new Error("Native analysis source changed; stale findings discarded.");
    process.send({ id, result: { evaluated: true, diagnostics, outOfEditScope, observations: takeObservations(), logs, unsupportedLanguages: [...unsupportedLanguageLog] } });
  } catch (error) {
    takeObservations();
    process.send({ id, error: error instanceof Error ? error.message : String(error) });
  } finally { watchdog.disarm(); }
});
process.on("disconnect", () => process.exit(0));
