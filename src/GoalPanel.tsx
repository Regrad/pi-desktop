import { t } from "./i18n";
import { Target, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ConversationRecord } from "../shared/types";

const labels = { active: "Работает", paused: "Пауза", blocked: "Нужен ваш ответ", complete: "Выполнено", budget_limited: "Лимит токенов" };

export function GoalPanel({ conversation, working }: { conversation: ConversationRecord; working: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const goal = conversation.goal;
  useEffect(() => { setEditing(false); setError(""); }, [conversation.id, goal?.id]);
  if (!goal) return null;
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <section className="goal-panel" aria-label={t("Цель чата")}>
    <>
      <div className="goal-heading"><Target size={16} /><strong>{t(labels[goal.status])}</strong>
        <span>{goal.objective}</span>
        <button disabled={busy} onClick={() => { setDraft(goal.objective); setEditing(true); setError(""); }}>{t("Изменить")}</button>
        {goal.status === "active"
          ? <button title={t("Приостановить следующие этапы цели; текущий ответ продолжится")} disabled={busy} onClick={() => void perform(() => window.piDesktop.controlGoal(conversation.id, "pause"))}>{t("Пауза")}</button>
          : goal.status !== "complete" && <button title={goal.status === "budget_limited" ? t("Возобновить цель и снять исчерпанный лимит токенов") : working ? t("Возобновить цель; следующий этап начнётся после текущего ответа") : t("Продолжить выполнение цели")} disabled={busy} onClick={() => void perform(() => window.piDesktop.controlGoal(conversation.id, "resume"))}>{goal.status === "budget_limited" ? t("Продолжить без лимита") : t("Продолжить")}</button>}
        <button title={t("Убрать цель; текущий ответ продолжится")} disabled={busy} onClick={() => void perform(() => window.piDesktop.controlGoal(conversation.id, "remove"))}><X size={14} /></button>
      </div>
      {editing && <form className="goal-editor" onSubmit={(event) => {
        event.preventDefault();
        void perform(async () => {
          await window.piDesktop.editGoal(conversation.id, draft);
          setEditing(false);
        });
      }}>
        <textarea aria-label={t("Текст цели")} autoFocus value={draft} maxLength={8000} rows={4} disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.preventDefault(); setEditing(false); } }} />
        <small>{t("Текущий ответ не прервётся. Новая формулировка применяется со следующего этапа; отчёт о прогрессе начнётся заново.")}</small>
        <div><button type="submit" disabled={busy || !draft.trim()}>{t("Сохранить")}</button>
          <button type="button" disabled={busy} onClick={() => setEditing(false)}>{t("Отмена")}</button></div>
      </form>}
      {(goal.progress || goal.evidence) && <details><summary>{t("Прогресс")}</summary>
        <p>{goal.progress || t("Отчёта о прогрессе пока нет.")}</p>
        {goal.evidence && <p>{goal.evidence}</p>}
      </details>}
      {goal.tokenBudget !== undefined && <small>{t("Токены цели:")}{" "}{goal.tokensUsed ?? 0} / {goal.tokenBudget}</small>}
      {error && <p role="alert">{error}</p>}
    </>
  </section>;
}
