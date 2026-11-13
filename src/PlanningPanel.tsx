import { Check, ListChecks, LoaderCircle, Pencil, Play, X } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ConversationPlanning } from "../shared/types";

export function PlanningPanel({ planning, working, onAction, onClose }: {
  planning: ConversationPlanning; working: boolean;
  onAction: (action: "revise" | "approve" | "cancel", revision: number) => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const completed = planning.phase === "completed";
  const phase = { working: "План задачи · обычный режим", draft: "Планирование · только чтение", review: "Ожидает согласования", implementation: "Реализация согласована", completed: "Реализация завершена", inactive: "Сохранённый план" }[planning.phase];
  async function action(value: "revise" | "approve" | "cancel") {
    if (busy || working) return;
    setBusy(true); setError("");
    try { await onAction(value, planning.revision); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <section className="notebook-panel planning-panel" aria-label="План реализации">
    <header className="notebook-heading">{completed ? <Check size={20} /> : <ListChecks size={20} />}<div><strong>{completed ? "План выполнен" : "План реализации"}</strong><small>{phase}</small></div>
      <button className="icon-button" aria-label="Закрыть панель плана" onClick={onClose}><X size={17} /></button></header>
    <div className="notebook-meta"><span>Версия {planning.revision}</span><span>{completed ? "Документ сохранён" : planning.phase === "working" ? "Обновляется по ходу работы" : planning.phase === "implementation" ? "Согласовано вами" : "Документ для согласования"}</span></div>
    <div className="notebook-content">
      {planning.content ? <div className="notebook-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null }}>{planning.content}</ReactMarkdown></div>
        : <div className="notebook-empty"><ListChecks size={32} /><strong>Сначала разберёмся в задаче</strong><p>Опишите, что нужно сделать. Здесь появится план; реализация начнётся только после вашего согласования.</p></div>}
    </div>
    <footer className="notebook-footer">
      {error && <p className="planning-error" role="alert">{error}</p>}
      {planning.phase === "review" ? <div className="planning-actions">
        <button className="planning-approve" disabled={busy || working} onClick={() => void action("approve")}><Play size={15} />Начать реализацию</button>
        <button disabled={busy || working} onClick={() => void action("revise")}><Pencil size={15} />Внести правки</button>
      </div> : planning.phase === "draft" ? <p className="planning-status">{working && <LoaderCircle size={14} className="planning-spinner" />}{working ? "Модель изучает задачу и готовит план" : "Напишите задачу или уточнения в чат"}</p>
        : <div className="planning-actions"><button disabled={busy || working} onClick={() => void action("revise")}><Pencil size={15} />{planning.phase === "working" ? "Открыть режим «План»" : "Пересмотреть план"}</button></div>}
      {["draft", "review"].includes(planning.phase) && <button className="planning-exit" disabled={busy || working} onClick={() => void action("cancel")}>Выйти из режима без реализации</button>}
    </footer>
  </section>;
}
