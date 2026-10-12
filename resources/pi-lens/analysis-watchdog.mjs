import { Worker, isMainThread, workerData } from "node:worker_threads";

// Independent of the executor's native/WASM event loop. A blocked analyzer
// cannot suppress its deadline or keep running after its owning Pi process dies.
export function startAnalysisWatchdog() {
  const deadline = new BigInt64Array(new SharedArrayBuffer(8));
  const guardian = new Worker(new URL(import.meta.url), {
    workerData: { deadline: deadline.buffer, ownerPid: process.ppid, executorPid: process.pid },
  });
  guardian.unref();
  return {
    arm: value => Atomics.store(deadline, 0, BigInt(value)),
    disarm: () => Atomics.store(deadline, 0, 0n),
  };
}

if (!isMainThread && workerData?.deadline) {
  const deadline = new BigInt64Array(workerData.deadline);
  const timer = setInterval(() => {
    let ownerAlive = true;
    try { process.kill(workerData.ownerPid, 0); }
    catch (error) { if (error.code === "ESRCH") ownerAlive = false; }
    const expires = Atomics.load(deadline, 0);
    if (!ownerAlive || (expires > 0n && BigInt(Date.now()) > expires + 1000n)) {
      process.kill(workerData.executorPid, "SIGKILL");
    }
  }, 250);
  timer.unref();
  // Keep only this thread alive; the owning executor may terminate it any time.
  setInterval(() => {}, 60_000);
}
