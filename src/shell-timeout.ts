import { t, getLocale } from "./i18n";
import { defaultShellTimeout } from "../resources/pi-rpc-bridge/shell-timeout-policy.js";

export interface ShellTiming {
  timeoutSeconds: number;
  startedAt: number;
}

export function shellTiming(name: string, args: Record<string, unknown>, result: unknown,
  startedAt: number, preparing = false): ShellTiming | undefined {
  if (name !== "bash" && name !== "powershell") return;
  const saved = (result as { details?: { shellTiming?: ShellTiming } } | undefined)?.details?.shellTiming;
  if (saved && Number.isFinite(saved.timeoutSeconds) && saved.timeoutSeconds > 0 &&
      Number.isFinite(saved.startedAt) && saved.startedAt > 0) return saved;
  const seconds = args.timeout ?? (startedAt > 0 || preparing ? defaultShellTimeout() : undefined);
  // Do not relabel historical commands whose original default is unknown.
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return;
  return { timeoutSeconds: seconds, startedAt };
}

export function remainingShellSeconds(timing: ShellTiming, now: number): number {
  return Math.max(0, Math.ceil(timing.timeoutSeconds - Math.max(0, now - timing.startedAt) / 1000));
}

export function formatShellSeconds(seconds: number): string {
  if (seconds > 0 && seconds < 1) return t("{0} с", seconds.toLocaleString(getLocale()));
  const whole = Math.ceil(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor(whole / 60) % 60;
  const tail = String(whole % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${tail}` : `${minutes}:${tail}`;
}
