import { Worker } from "node:worker_threads";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type { ConversationSnapshot } from "../shared/types.js";

export interface SessionPreview {
  messages: unknown[];
  entries: ConversationSnapshot["entries"];
  historyTargets: ConversationSnapshot["historyTargets"];
  model: { provider: string; modelId: string } | null;
  thinkingLevel: string;
  sessionName?: string;
  navigationTimestamp?: string;
}
export type SessionReadRequest =
  | { kind: "preview"; file: string; cwd: string; sessionDir: string }
  | { kind: "list"; cwd: string; sessionDir: string };

const reads = new Set<Worker>();

/** Pi's synchronous JSONL parsing must never run on Electron's main thread. */
function readSession<T>(request: SessionReadRequest, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./session-read-worker.js", import.meta.url), { workerData: request });
    reads.add(worker);
    let finished = false;
    const finish = (error?: Error, result?: T) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", abort);
      reads.delete(worker);
      void worker.terminate().catch(() => {});
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new DOMException("Загрузка чата отменена.", "AbortError"));
    worker.once("message", (message: { result?: T; error?: string }) =>
      finish(message.error ? new Error(message.error) : undefined, message.result));
    worker.once("error", error => finish(error));
    worker.once("exit", code => finish(new Error(`Чтение истории завершилось без результата (${code}).`)));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function readSessionPreview(file: string, cwd: string, sessionDir: string, signal?: AbortSignal) {
  return readSession<SessionPreview>({ kind: "preview", file, cwd, sessionDir }, signal);
}
export function listSessions(cwd: string, sessionDir: string, signal?: AbortSignal) {
  return readSession<SessionInfo[]>({ kind: "list", cwd, sessionDir }, signal);
}
export async function stopSessionReads(): Promise<void> {
  await Promise.all([...reads].map(worker => worker.terminate()));
}
