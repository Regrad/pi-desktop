import { t, getLocale } from "./i18n";
import { BookOpen, Check, Pencil, Save, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ConversationNotebook } from "../shared/types";
import { notebookLimit } from "../shared/notebook";

// Unsaved drafts survive switching chats, but never leave process memory.
const drafts = new Map<string, { content: string; revision: number }>();

export function NotebookPanel({ conversationId, notebook, open, onClose }: {
  conversationId: string; notebook?: ConversationNotebook; open: boolean; onClose: () => void;
}) {
  const initial = drafts.get(conversationId) ?? { content: notebook?.content ?? "", revision: notebook?.revision ?? 0 };
  const [draft, setDraft] = useState(initial);
  const [editing, setEditing] = useState(drafts.has(conversationId) || !initial.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(notebookLimit);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    window.piDesktop.getNotebookCharacterLimit().then(value => { if (!cancelled) setLimit(value); })
      .catch(cause => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [open]);
  const revision = notebook?.revision ?? 0;
  const dirty = draft.content !== (notebook?.content ?? "");
  const conflict = dirty && draft.revision !== revision;
  useEffect(() => {
    if (!drafts.has(conversationId)) setDraft({ content: notebook?.content ?? "", revision });
  }, [conversationId, notebook?.content, revision]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [open, onClose]);
  const change = (content: string) => {
    const value = { ...draft, content };
    setDraft(value);
    if (content === (notebook?.content ?? "")) {
      drafts.delete(conversationId);
      setDraft({ content, revision });
    } else drafts.set(conversationId, value);
    setError("");
  };
  const reload = () => {
    if (dirty && !window.confirm(t("Отбросить несохранённые правки и открыть актуальный блокнот?"))) return;
    drafts.delete(conversationId);
    setDraft({ content: notebook?.content ?? "", revision });
    setError("");
  };
  const save = async (content = draft.content) => {
    setSaving(true); setError("");
    try {
      const next = await window.piDesktop.saveNotebook(conversationId, content, draft.revision);
      drafts.delete(conversationId);
      setDraft({ content: next.content, revision: next.revision });
      setEditing(!next.content);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  if (!open) return null;
  return <section className="notebook-panel" aria-label={t("Блокнот текущего чата")}>
    <header className="notebook-heading"><BookOpen size={19} /><div><strong>{t("Блокнот")}</strong><small>{t("Память этого чата")}</small></div>
      <button className="icon-button" aria-label={t("Закрыть блокнот")} title={t("Закрыть блокнот")} onClick={onClose}><X size={17} /></button>
    </header>
    <div className="notebook-meta"><span><Check size={13} /> {dirty ? t("Есть несохранённые правки") : t("Сохранённые записи доступны модели")}</span><span>v{revision}</span></div>
    {conflict && <div className="notebook-warning" role="alert">{t("Блокнот изменён моделью или в другом окне. Скопируйте нужные правки и откройте актуальную версию перед сохранением.")}<button onClick={reload}>{t("Открыть актуальную версию")}</button></div>}
    {error && <p className="notebook-warning" role="alert">{error}</p>}
    {draft.content.length > limit && <p className="notebook-warning" role="alert">{t("Записи превышают текущий лимит. Они сохранены целиком; для сохранения правок сократите текст или увеличьте лимит в настройках.")}</p>}
    <div className="notebook-content">
      {editing ? <textarea aria-label={t("Записи блокнота")} value={draft.content} disabled={saving}
        placeholder={t("Папка проекта: …\nСайт: …\nУчётная запись: …\n\nКороткие проверенные факты и их источники.")}
        onChange={event => change(event.target.value)} spellCheck={false} />
        : draft.content ? <div className="notebook-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null }}>{draft.content}</ReactMarkdown></div>
        : <div className="notebook-empty"><BookOpen size={32} /><strong>{t("Важное — под рукой")}</strong><p>{t("Сохраняйте точные пути, адреса и полезные сведения. Модель тоже может обновлять записи.")}</p><button onClick={() => setEditing(true)}>{t("Добавить записи")}</button></div>}
    </div>
    <footer className="notebook-footer"><div className="notebook-actions">
      <button onClick={() => setEditing(value => !value)} disabled={saving}><Pencil size={14} />{editing ? t("Просмотр") : t("Изменить")}</button>
      <button className="notebook-save" disabled={!dirty || saving || conflict || draft.content.length > limit} onClick={() => void save()}><Save size={14} />{saving ? t("Сохраняю…") : t("Сохранить")}</button>
      <button className="icon-button" aria-label={t("Очистить блокнот")} title={t("Очистить блокнот")} disabled={saving || conflict || (!draft.content && !notebook?.content)}
        onClick={() => { if (window.confirm(t("Очистить блокнот этого чата? История переписки и старые записи в ней останутся."))) void save(""); }}><Trash2 size={15} /></button>
    </div><small>{draft.content.length.toLocaleString(getLocale())} / {limit.toLocaleString(getLocale())}{t(" символов · Пароли хранятся открыто")}</small></footer>
  </section>;
}
