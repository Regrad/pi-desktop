import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { SessionManager, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { sessionHistoryTargets } from "../shared/session-history.js";
import type { SessionReadRequest, SessionPreview } from "./session-read.js";

const request = workerData as SessionReadRequest;
try {
  if (request.kind === "list") {
    parentPort!.postMessage({ result: await SessionManager.list(request.cwd, request.sessionDir) });
  } else {
    // Opening a persisted Pi session can migrate/rewrite it. A cancellable
    // preview must stay read-only, including legacy or unterminated JSONL.
    const content = await readFile(request.file, "utf8");
    const fileEntries = parseSessionEntries(content);
    if (content.length && (fileEntries[0]?.type !== "session" || typeof fileEntries[0]?.id !== "string"))
      throw new Error(`Некорректный файл истории: ${request.file}`);
    const manager = SessionManager.inMemory(request.cwd, undefined, fileEntries);
    const context = manager.buildSessionContext();
    const entries = manager.getBranch();
    const navigation = [...entries].reverse().find(entry => entry.type === "custom" && entry.customType === "pi_desktop_history_position");
    const result: SessionPreview = {
      messages: context.messages, entries: entries as unknown as SessionPreview["entries"],
      model: context.model, thinkingLevel: context.thinkingLevel,
      sessionName: manager.getSessionName(), navigationTimestamp: navigation?.timestamp,
      historyTargets: sessionHistoryTargets(context.messages, manager.buildContextEntries()),
    };
    parentPort!.postMessage({ result });
  }
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
