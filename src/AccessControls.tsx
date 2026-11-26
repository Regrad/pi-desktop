import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ShieldCheck } from "lucide-react";
import type { ConversationAccess } from "../shared/types";
import { t } from "./i18n";

type Action = "confirm" | "full" | "approve" | "cancel";
type Props = { access?: ConversationAccess; disabled: boolean; onAction: (action: Action, revision: number) => Promise<void> };

export function AccessSelector({ access, disabled, onAction }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const mode = access?.mode ?? "confirm";
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, []);
  return <div className="access-selector" ref={ref}>
    <button type="button" className="access-chip" style={{ color: mode === "confirm" ? "var(--tool-success)" : "var(--orange)" }} disabled={disabled} aria-haspopup="menu" aria-expanded={open}
      title={access?.phase === "approved" && mode === "confirm" ? t("Изменения разрешены для согласованной задачи") : t("Режим доступа")}
      onClick={() => setOpen(value => !value)}>
      <ShieldCheck size={13} />{mode === "full" ? t("Полный доступ") : t("Сначала согласовать")}<ChevronDown size={12} />
      {mode === "confirm" && access?.phase === "approved" && <span className="access-approved-dot" aria-label={t("Изменения разрешены")} />}
    </button>
    {open && <div className="access-menu" role="menu" aria-label={t("Режим доступа")}>
      {(["confirm", "full"] as const).map(value => <button type="button" role="menuitemradio" aria-checked={mode === value} disabled={disabled} key={value}
        onClick={() => { setOpen(false); void onAction(value, access?.revision ?? 0); }}>
        <span><strong>{value === "confirm" ? t("Сначала согласовать") : t("Полный доступ")}</strong>
          <small>{value === "confirm" ? t("Чтение и поиск сразу, изменения после подтверждения.") : t("Работа без обязательного согласования изменений.")}</small></span>
        {mode === value && <Check size={15} />}
      </button>)}
    </div>}
  </div>;
}

export function AccessApprovalCard({ access, disabled, onAction }: Props) {
  const [revoking, setRevoking] = useState(false);
  if (access?.mode === "confirm" && access.phase === "approved") return <section className="access-permission" aria-label={t("Изменения разрешены")}>
    <ShieldCheck size={17} />
    <div><strong>{t("Изменения разрешены")}</strong><small>{access.started ? t("Для согласованной задачи") : t("Напишите сообщение, чтобы начать.")}</small></div>
    <button type="button" disabled={revoking} aria-label={t("Отозвать разрешение")} title={t("Отозвать разрешение")}
      onClick={() => { setRevoking(true); void onAction("cancel", access.revision).finally(() => setRevoking(false)); }}>×</button>
  </section>;
  if (access?.mode !== "confirm" || access.phase !== "review" || !access.proposal) return null;
  return <section className="access-approval" aria-label={t("Согласование изменений")}>
    <strong className="access-approval-label"><ShieldCheck size={15} />{t("Согласование изменений")}</strong>
    <div className="access-approval-actions">
      <button type="button" disabled={disabled} onClick={() => void onAction("cancel", access.revision)}>{t("Отменить")}</button>
      <button type="button" className="primary" disabled={disabled} onClick={() => void onAction("approve", access.revision)}>{t("Разрешить изменения")}</button>
    </div>
  </section>;
}
