import { parentPort, workerData } from "node:worker_threads";
import { readFile, stat } from "node:fs/promises";
import type { SessionManager as PiSession } from "@earendil-works/pi-coding-agent";
import { sessionHistoryTargets } from "../shared/session-history.js";
import type { SessionReadRequest, SessionPreview } from "./session-read.js";

const options = workerData as { request: SessionReadRequest; keepAlive: boolean };
let cached: { file: string; cwd: string; size: number; mtimeMs: number; manager: PiSession } | undefined;

async function read(request: SessionReadRequest) {
  if (request.kind === "tail") {
    const { readSessionTail } = await import("./session-tail.js");
    return readSessionTail(request.file);
  }
  const { SessionManager, parseSessionEntries } = await import("@earendil-works/pi-coding-agent");
  if (request.kind === "list") return SessionManager.list(request.cwd, request.sessionDir);

  // A cancellable preview must stay read-only, including legacy or unterminated JSONL.
  const { size, mtimeMs } = await stat(request.file);
  let manager = cached?.file === request.file && cached.cwd === request.cwd && cached.size === size && cached.mtimeMs === mtimeMs ? cached.manager : undefined;
  if (!manager) {
    const content = await readFile(request.file, "utf8");
    const fileEntries = parseSessionEntries(content);
    if (content.length && (fileEntries[0]?.type !== "session" || typeof fileEntries[0]?.id !== "string"))
      throw new Error(`Некорректный файл истории: ${request.file}`);
    manager = SessionManager.inMemory(request.cwd, undefined, fileEntries);
    if (options.keepAlive) cached = { file: request.file, cwd: request.cwd, size, mtimeMs, manager };
  }
  const entries = manager.getBranch();
  const { sessionTranscript } = await import("./session-transcript.js");
  if (request.kind === "history") return sessionTranscript(entries, request.page);

  const context = manager.buildSessionContext();
  const navigation = [...entries].reverse().find(entry => entry.type === "custom" && entry.customType === "pi_desktop_history_position");
  const messageOffset = request.tail ? context.messages.length : 0;
  const messages = context.messages.slice(messageOffset);
  return {
    messages, messageOffset, entries: request.tail ? [] : entries as unknown as SessionPreview["entries"],
    model: context.model, thinkingLevel: context.thinkingLevel,
    sessionName: manager.getSessionName(), navigationTimestamp: navigation?.timestamp,
    historyTargets: request.tail ? [] : sessionHistoryTargets(messages, manager.buildContextEntries()),
    history: request.tail ? sessionTranscript(entries) : undefined,
  } satisfies SessionPreview;
}

async function respond(request: SessionReadRequest) {
  try {
    parentPort!.postMessage({ result: await read(request) });
  } catch (error) {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
}

if (options.keepAlive) parentPort!.on("message", request => void respond(request));
await respond(options.request);
