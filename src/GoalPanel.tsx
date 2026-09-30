import { Target, X } from "lucide-react";
import type { ConversationRecord } from "../shared/types";

const labels = { active: "Работает", paused: "Пауза", blocked: "Нужен ваш ответ", complete: "Выполнено" };

export function GoalPanel({ conversation, working }: { conversation: ConversationRecord; working: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const goal = conversation.goal;
  if (!goal) return null;
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <section className="goal-panel" aria-label="Цель чата">
    <>
      <div className="goal-heading"><Target size={16} /><strong>{labels[goal.status]}</strong>
        <span>{goal.objective}</span>
        {goal.status === "active"
          ? <button disabled={busy} onClick={() => void perform(() => window.piDesktop.controlGoal(conversation.id, "pause"))}>Пауза</button>
          : goal.status !== "complete" && <button disabled={busy || working} onClick={() => void perform(() => window.piDesktop.controlGoal(conversation.id, "resume"))}>Продолжить</button>}
        <button title="Убрать цель и остановить её работу" disabled={busy} onClick={() => void perform(() => window.piDesktop.controlGoal(conversation.id, "remove"))}><X size={14} /></button>
      </div>
      {(goal.progress || goal.evidence) && <details><summary>Прогресс</summary>
        <p>{goal.progress || "Отчёта о прогрессе пока нет."}</p>
        {goal.evidence && <p>{goal.evidence}</p>}
      </details>}
      {error && <p role="alert">{error}</p>}
    </>
  </section>;
}
import { useState } from "react";
