import { Worker } from "node:worker_threads";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type { ConversationSnapshot } from "../shared/types.js";
import type { ChatHistoryPage, ChatHistoryRequest } from "../shared/chat-history.js";

export interface SessionPreview {
  messages: unknown[];
  entries: ConversationSnapshot["entries"];
  historyTargets: ConversationSnapshot["historyTargets"];
  model: { provider: string; modelId: string } | null;
  thinkingLevel: string;
  sessionName?: string;
  navigationTimestamp?: string;
  history?: ChatHistoryPage;
  messageOffset?: number;
}
export type SessionReadRequest =
  | { kind: "preview"; file: string; cwd: string; sessionDir: string; tail?: boolean }
  | { kind: "history"; file: string; cwd: string; sessionDir: string; page?: ChatHistoryRequest }
  | { kind: "tail"; file: string }
  | { kind: "list"; cwd: string; sessionDir: string };

const reads = new Set<Worker>();
let idleHistory: { file: string; worker: Worker; timeout: ReturnType<typeof setTimeout> } | undefined;

function historyReaderExited() {
  void releaseHistoryReader();
}

function releaseHistoryReader() {
  if (!idleHistory) return;
  const { worker, timeout } = idleHistory;
  idleHistory = undefined;
  clearTimeout(timeout);
  reads.delete(worker);
  worker.off("exit", historyReaderExited).off("error", historyReaderExited);
  return worker.terminate().catch(() => {});
}

/** Pi's synchronous JSONL parsing must never run on Electron's main thread. */
function readSession<T>(request: SessionReadRequest, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cacheFile = request.kind === "history" || request.kind === "preview" && request.tail ? request.file : undefined;
    const reuse = idleHistory && idleHistory.file === cacheFile ? idleHistory : undefined;
    if (reuse) {
      clearTimeout(reuse.timeout);
      idleHistory = undefined;
      reuse.worker.off("exit", historyReaderExited).off("error", historyReaderExited);
    }
    const worker = reuse?.worker ?? new Worker(new URL("./session-read-worker.js", import.meta.url), {
      workerData: { request, keepAlive: Boolean(cacheFile) },
    });
    reads.add(worker);
    let finished = false;
    const finish = (error?: Error, result?: T) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", abort);
      worker.off("message", onMessage).off("error", onError).off("exit", onExit);
      if (!error && cacheFile) {
        releaseHistoryReader();
        const timeout = setTimeout(releaseHistoryReader, 45_000);
        timeout.unref();
        idleHistory = { file: cacheFile, worker, timeout };
        worker.once("exit", historyReaderExited).once("error", historyReaderExited);
        worker.unref();
      } else {
        reads.delete(worker);
        void worker.terminate().catch(() => {});
      }
      if (error) reject(error); else resolve(result!);
    };
    const abort = () => finish(new DOMException("Загрузка чата отменена.", "AbortError"));
    const onMessage = (message: { result?: T; error?: string }) => finish(message.error ? new Error(message.error) : undefined, message.result);
    const onError = (error: Error) => finish(error);
    const onExit = (code: number) => finish(new Error(`Чтение истории завершилось без результата (${code}).`));
    worker.once("message", onMessage).once("error", onError).once("exit", onExit);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    else if (reuse) {
      worker.ref();
      worker.postMessage(request);
    }
  });
}

export function readSessionPreview(file: string, cwd: string, sessionDir: string, signal?: AbortSignal, tail?: boolean) {
  return readSession<SessionPreview>({ kind: "preview", file, cwd, sessionDir, tail }, signal);
}
export function readChatHistory(file: string, cwd: string, sessionDir: string, page?: ChatHistoryRequest) {
  return readSession<ChatHistoryPage>({ kind: "history", file, cwd, sessionDir, page });
}
export function readChatTail(file: string, signal?: AbortSignal) {
  return readSession<ChatHistoryPage | undefined>({ kind: "tail", file }, signal);
}
export function listSessions(cwd: string, sessionDir: string, signal?: AbortSignal) {
  return readSession<SessionInfo[]>({ kind: "list", cwd, sessionDir }, signal);
}
export async function stopSessionReads(): Promise<void> {
  const idle = releaseHistoryReader();
  await Promise.all([idle, ...[...reads].map(worker => worker.terminate())]);
}
