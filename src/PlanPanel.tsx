import { t } from "./i18n";
import { Check, ChevronDown, Circle, CircleDashed, CircleHelp, CircleSlash, ListChecks, LoaderCircle, X } from "lucide-react";
import { useState } from "react";
import type { ConversationPlan, PlanStep } from "../shared/types";
import { isPlanComplete } from "../shared/plan";

// With system "reduce motion" the rotation is off by CSS, and a static loader ring again looks
// broken, so the same dashed marker is used and the row highlight carries the "running" signal.
const prefersReducedMotion = () => Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

export function PlanPanel({ conversationId, plan, working }: { conversationId: string; plan?: ConversationPlan; working: boolean }) {
  const [expanded, setExpanded] = useState(true);
  const [removing, setRemoving] = useState(false);
  const [controlling, setControlling] = useState(false);
  const [error, setError] = useState("");
  if (!plan?.steps.length) return null;
  const done = plan.steps.filter(step => step.status === "completed").length;
  const skipped = plan.steps.filter(step => step.status === "skipped").length;
  const waitingIndex = plan.steps.findIndex(step => step.status === "waiting");
  const current = plan.steps.find(step => step.status === "in_progress");
  const complete = isPlanComplete(plan.steps);
  const busy = removing || controlling;
  // A step that is marked current but not executing needs its own look: an unanimated
  // loader ring reads as a broken spinner.
  const statusOf = (item: PlanStep): string => item.status === "completed" ? t("Готово")
    : item.status === "skipped" ? t("Пропущено")
    : item.status === "waiting" ? t("Ждёт твоего ответа")
    : item.status === "in_progress" ? (working ? t("Выполняется") : plan.execution === "active" ? t("Ждёт продолжения") : t("На паузе"))
    : t("Ожидает");
  async function control(action: "pause" | "resume") {
    setControlling(true); setError("");
    try { await window.piDesktop.controlPlan(conversationId, action); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setControlling(false); }
  }
  return <section className={`plan-panel${complete ? " is-complete" : ""}`} aria-label={t("Чеклист")}>
    <div className="plan-toolbar"><button className="plan-heading" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      <ListChecks size={17} /><strong>{complete ? t("Чеклист закрыт") : t("Чеклист")}</strong>
      <span className="plan-count">{done} / {plan.steps.length}</span>
      {!expanded && current && <span className="plan-current">{current.step}</span>}
      <ChevronDown size={15} className={expanded ? "plan-chevron expanded" : "plan-chevron"} />
    </button>{!complete && <button className="plan-control" disabled={busy}
      title={plan.execution === "active" ? t("Приостановить автопродолжение; текущий ответ продолжится") : t("Запустить существующий чеклист; если ответ идёт, продолжение начнётся после него")}
      onClick={() => void control(plan.execution === "active" ? "pause" : "resume")}>
      {plan.execution === "active" ? t("Пауза") : t("Продолжить")}
    </button>}<button className="plan-remove" title={t("Убрать чеклист без остановки ответа и отмены цели")} aria-label={t("Убрать чеклист")} disabled={busy}
      onClick={() => { setRemoving(true); setError(""); void window.piDesktop.removePlan(conversationId)
        .catch(cause => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setRemoving(false)); }}><X size={15} /></button></div>
    {error && <p className="plan-remove-error" role="alert">{error}</p>}
    <div className="plan-progress" role="progressbar" aria-label={t("Выполненные шаги")} aria-valuemin={0} aria-valuemax={plan.steps.length} aria-valuenow={done}>
      <span style={{ width: `${done / plan.steps.length * 100}%` }} />
    </div>
    {expanded && <div className="plan-body">
      {waitingIndex >= 0 && <p className="plan-explanation plan-frozen">{t("Чеклист заморожен: шаг {0} ждёт твоего ответа", waitingIndex + 1)}</p>}
      {complete ? <p className="plan-explanation">{t("{0} из {1} сделано", done, plan.steps.length)}{skipped ? ` · ${t("Пропущено: {0}", skipped)}` : ""}</p>
        : <p className="plan-explanation">{plan.execution === "active" ? t("Автопродолжение включено") : t("Автопродолжение на паузе")}</p>}
      <ol>{plan.steps.map((item, index) => <li key={index} className={`plan-step ${item.status}${item.status === "in_progress" && working ? " is-working" : ""}`}>
        <span className="plan-step-icon" aria-label={statusOf(item)}>
          {item.status === "completed" ? <Check size={15} /> : item.status === "skipped" ? <CircleSlash size={15} />
            : item.status === "waiting" ? <CircleHelp size={15} />
            : item.status === "in_progress" ? working && !prefersReducedMotion()
              ? <span className="plan-spinner"><LoaderCircle size={15} /></span>
              : <CircleDashed size={15} className={working ? "plan-marker-running" : ""} /> : <Circle size={12} />}
        </span><span className="plan-step-body"><span className="plan-step-text">{item.step}</span>
          {item.status === "skipped" && item.reason && <span className="plan-step-reason">{item.reason}</span>}</span>
        {/* Completed and pending rows speak for themselves; a label on each of them is noise. */}
        {item.status !== "pending" && item.status !== "completed" && <span className="plan-step-status">{statusOf(item)}</span>}
      </li>)}</ol>
      {plan.explanation && <p className="plan-explanation">{plan.explanation}</p>}
    </div>}
  </section>;
}
