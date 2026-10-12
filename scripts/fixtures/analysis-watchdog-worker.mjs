import { startAnalysisWatchdog } from "../../resources/pi-lens/analysis-watchdog.mjs";
const guard = startAnalysisWatchdog();
process.on("message", ({ id, payload, deadlineAt }) => {
  guard.arm(payload.expire ? Date.now() : deadlineAt);
  process.send({ id, started: true });
  const until = Date.now() + 10_000;
  while (Date.now() < until) { /* main loop cannot run its own timers or IPC */ }
});
