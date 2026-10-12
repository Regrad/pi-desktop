import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";

const cancellationKey = Symbol.for("pi.desktop.cancel.native.analysis");

// One warm, read-only native executor per Pi process. Queue and deadlines live
// OUTSIDE the native process, so a blocked matcher cannot block cancellation.
export function createAnalysisHost({ workerUrl = new URL("./analysis-worker.mjs", import.meta.url), timeoutMs = 30_000, idleMs = 30_000, onStarted } = {}) {
  let worker, active, idleTimer, sequence = 0;
  const queue = [];
  let closing = Promise.resolve();

  function fail(error) {
    if (active) { const job = active; active = undefined; settle(job, error); }
    while (queue.length) settle(queue.shift(), error);
  }

  function settle(job, error, result) {
    clearTimeout(job.timer);
    job.signal?.removeEventListener("abort", job.onAbort);
    if (error) job.reject(error); else job.resolve(result);
  }

  async function stop(error, cancelQueue = true) {
    clearTimeout(idleTimer);
    const child = worker;
    worker = undefined;
    // Block pump before rejecting jobs; callers may immediately enqueue again.
    const prior = closing;
    let release;
    closing = new Promise(resolve => { release = resolve; });
    if (cancelQueue) fail(error);
    else if (active) { const job = active; active = undefined; settle(job, error); }
    try {
      await prior;
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise(resolve => {
          child.once("close", resolve);
          child.kill("SIGKILL");
        });
      }
    } finally { release(); if (!cancelQueue) void pump(); }
  }

  function launch() {
    const child = fork(fileURLToPath(workerUrl), [], {
      execArgv: [], windowsHide: true,
      serialization: "advanced",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    // Drain stderr without retaining potentially sensitive source/diagnostics.
    child.stderr.resume();
    child.on("error", error => { if (worker === child) void stop(error); });
    child.on("close", (code, signal) => {
      if (worker !== child) return;
      worker = undefined;
      fail(new Error(`Native analysis executor exited (${signal || code}); analysis incomplete.`));
    });
    child.on("message", message => {
      if (worker !== child || !active || message?.id !== active.id) return;
      if (message.started) { onStarted?.(message.id, child.pid); return; }
      if (!message.error && !message.result) return;
      const job = active;
      active = undefined;
      if (message.error) settle(job, new Error(`Native analysis failed: ${message.error}`));
      else settle(job, undefined, message.result);
      if (message.result?.retire) { void stop(new Error("Analysis runtime retired after an unrecoverable fault"), false); return; }
      void pump();
    });
    worker = child;
  }

  async function pump() {
    await closing;
    if (active) return;
    clearTimeout(idleTimer);
    if (!queue.length) {
      idleTimer = setTimeout(() => { if (!active && !queue.length) void stop(new Error("Native analysis executor idle"), false); }, idleMs);
      idleTimer.unref();
      return;
    }
    if (!worker) {
      try { launch(); } catch (error) { fail(error); return; }
    }
    active = queue.shift();
    const job = active;
    try {
      worker.send({ id: job.id, payload: job.payload, deadlineAt: job.deadlineAt }, error => {
        if (error && active === job) void stop(error, false);
      });
    } catch (error) { void stop(error, false); }
  }

  function analyze(payload, { signal, timeoutMs: jobTimeoutMs = timeoutMs } = {}) {
    if (signal?.aborted) return Promise.reject(new DOMException("Native analysis cancelled", "AbortError"));
    if (queue.length >= 32) return Promise.reject(new Error("Native analysis queue is full; analysis incomplete."));
    return new Promise((resolve, reject) => {
      if (!Number.isFinite(jobTimeoutMs) || jobTimeoutMs <= 0 || jobTimeoutMs > 2_147_483_647) {
        reject(new RangeError("Invalid analysis deadline")); return;
      }
      const job = { id: ++sequence, payload: structuredClone(payload), resolve, reject, signal, deadlineAt: Date.now() + jobTimeoutMs };
      const cancelJob = error => {
        if (active === job) { void stop(error, false); return; }
        const index = queue.indexOf(job);
        if (index >= 0) { queue.splice(index, 1); settle(job, error); }
      };
      job.onAbort = () => cancelJob(new DOMException("Native analysis cancelled", "AbortError"));
      signal?.addEventListener("abort", job.onAbort, { once: true });
      // Includes queue time. Never return a clean empty report on timeout.
      job.timer = setTimeout(() => cancelJob(new Error("Native analysis timed out; analysis incomplete.")), jobTimeoutMs);
      queue.push(job);
      void pump();
    });
  }

  return { analyze, cancel: () => stop(new DOMException("Native analysis cancelled", "AbortError")) };
}

const host = createAnalysisHost();
globalThis[cancellationKey] = () => host.cancel();
export async function analyzeAst(payload, options = {}) {
  const start = Date.now();
  const epochKey = Symbol.for("pi.desktop.native.analysis.epoch");
  const epoch = globalThis[epochKey] ?? 0;
  const { getRunnerTimeoutFloorMs } = await import("../clients/runtime-config.js");
  if ((globalThis[epochKey] ?? 0) !== epoch || options.signal?.aborted) throw new DOMException("Native analysis cancelled", "AbortError");
  const deadline = options.deadlineAt ?? start + Math.max(30_000, getRunnerTimeoutFloorMs());
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Native analysis timed out; analysis incomplete.");
  return host.analyze(payload, { ...options, timeoutMs: remaining });
}
