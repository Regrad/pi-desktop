import { useEffect, useState } from "react";
import { Clock3 } from "lucide-react";
import { formatShellSeconds, remainingShellSeconds, type ShellTiming } from "./shell-timeout";

export function ShellTimeout({ timing, running }: { timing: ShellTiming; running: boolean }) {
  const [now, setNow] = useState(Date.now);
  const counting = running && timing.startedAt > 0;
  useEffect(() => {
    if (!counting) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [counting, timing.startedAt, timing.timeoutSeconds]);
  const remaining = remainingShellSeconds(timing, now);
  const limit = formatShellSeconds(timing.timeoutSeconds);
  const label = counting
    ? remaining > 0 ? `Осталось ${formatShellSeconds(remaining)}` : "Завершается…"
    : `Лимит ${limit}`;
  return (
    <span className={`shell-timeout${counting ? " ticking" : ""}${counting && remaining <= 30 ? " urgent" : ""}`}
      title={`Таймаут команды: ${limit}`} aria-label={`${label}. Таймаут команды: ${limit}`}>
      <span className="shell-timeout-label"><Clock3 size={12} /><span>{label}</span>
        {counting && <span className="shell-timeout-limit">/ {limit}</span>}
      </span>
      {counting && <span className="shell-timeout-track" aria-hidden="true">
        <span style={{ transform: `scaleX(${Math.min(1, remaining / timing.timeoutSeconds)})` }} />
      </span>}
    </span>
  );
}
