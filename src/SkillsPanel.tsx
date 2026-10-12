import { BookOpen, Check, FileText, Folder, LockKeyhole, Plus, RefreshCw, Save, Sparkles, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DesktopSkill, SkillDocument, SkillsCatalog, SkillsCommand } from "../shared/skills";

const scopeLabels = { user: "Все проекты", project: "Этот проект", bundled: "Встроенный", external: "Дополнение / внешний" };
type Draft = { name: string; scope: "user" | "project"; content: string; expectedRevision: string; original: string; id?: string };
const drafts = new Map<string, Draft>();

export function SkillsPanel({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [catalog, setCatalog] = useState<SkillsCatalog>();
  const [selected, setSelected] = useState<DesktopSkill>();
  const [draft, setDraft] = useState<Draft | undefined>(() => drafts.get(conversationId));
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const dirty = draft !== undefined && (draft.content !== draft.original || !draft.id);
  const conflict = draft?.id && catalog && catalog.skills.find(skill => skill.id === draft.id)?.revision !== draft.expectedRevision;
  const close = () => { if (!busy && (!dirty || window.confirm("Закрыть навыки? Несохранённый текст останется в черновике этого чата до закрытия приложения."))) onClose(); };
  const updateDraft = (next: Draft) => { setDraft(next); drafts.set(conversationId, next); };
  const changeName = (name: string) => {
    if (!draft) return;
    // The new-skill form starts with a name-first template. Keep that field in
    // sync without rewriting the rest of the user's YAML or instructions.
    const content = draft.content.replace(/^(---\r?\n)name:[^\r\n]*(\r?\n)/,
      (_match, start: string, end: string) => `${start}name: ${JSON.stringify(name)}${end}`);
    updateDraft({ ...draft, name, content });
  };
  const request = async (command: SkillsCommand) => {
    setBusy(true); setError("");
    try { return await window.piDesktop.manageSkills(conversationId, command); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const refresh = async () => {
    const value = await request({ action: "refresh" });
    if (value && "skills" in value && mounted.current) setCatalog(value);
  };
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    void refresh();
    return () => { mounted.current = false; dialog.current?.close(); };
  }, [conversationId]);
  const canLeave = () => !dirty || window.confirm("Отбросить несохранённые изменения этого навыка?");
  const open = async (skill: DesktopSkill) => {
    if (!canLeave()) return;
    const value = await request({ action: "read", id: skill.id });
    if (!value || !("content" in value) || !mounted.current) return;
    const doc = value as SkillDocument;
    setSelected(doc.skill); setPreview(!doc.skill.editable);
    drafts.delete(conversationId);
    setDraft({ id: doc.skill.id, name: doc.skill.name, scope: doc.skill.scope === "project" ? "project" : "user",
      content: doc.content, original: doc.content, expectedRevision: doc.skill.revision });
  };
  const create = () => {
    if (!canLeave()) return;
    setSelected(undefined); setPreview(false); setError("");
    updateDraft({ name: "my-skill", scope: catalog?.roots.project ? "project" : "user", content: "---\nname: my-skill\ndescription: Когда нужен этот навык и что он помогает сделать.\n---\n\n", expectedRevision: "", original: "" });
  };
  const save = async () => {
    if (!draft) return;
    const value = await request({ action: "save", scope: draft.scope, name: draft.name, content: draft.content, expectedRevision: draft.expectedRevision });
    if (!value || !("skills" in value) || !mounted.current) return;
    setCatalog(value); drafts.delete(conversationId);
    const saved = value.skills.find(skill => skill.name === draft.name && skill.scope === draft.scope);
    if (saved) { setSelected(saved); setDraft({ ...draft, id: saved.id, expectedRevision: saved.revision, original: draft.content }); }
  };
  const toggle = async (skill: DesktopSkill) => {
    const value = await request({ action: "enable", id: skill.id, enabled: !skill.enabled, expectedRevision: skill.revision });
    if (value && "skills" in value && mounted.current) { setCatalog(value); setSelected(value.skills.find(item => item.id === skill.id)); }
  };
  const remove = async (skill: DesktopSkill) => {
    if (!window.confirm(`Удалить навык «${skill.name}» вместе с его скриптами, ссылочными файлами и ресурсами?\n\n${skill.filePath}\n\nОтменить удаление из приложения нельзя. Старые инструкции останутся в истории, но будут отозваны из каталога.`)) return;
    const value = await request({ action: "delete", id: skill.id, expectedRevision: skill.revision, confirm: true });
    if (value && "skills" in value && mounted.current) { setCatalog(value); setSelected(undefined); setDraft(undefined); drafts.delete(conversationId); }
  };
  const current = catalog?.skills.find(skill => skill.id === (selected?.id ?? draft?.id));
  const editable = !draft?.id || Boolean(current?.editable);
  return <dialog ref={dialog} className="skills-dialog" aria-labelledby="skills-title" onCancel={event => { event.preventDefault(); close(); }}>
    <header className="skills-heading"><Sparkles size={21} /><div><h2 id="skills-title">Навыки</h2><p>Полезные инструкции — только когда нужны</p></div>
      <button className="icon-button" aria-label="Закрыть навыки" disabled={busy} onClick={close}><X size={18} /></button></header>
    {error && <p className="skills-alert" role="alert">{error}</p>}
    <div className="skills-workspace">
      <nav className="skills-list" aria-label="Список навыков"><div className="skills-list-toolbar"><span>{catalog?.skills.length ?? "…"} навыков</span>
        <button className="icon-button" title="Обновить список" aria-label="Обновить список" disabled={busy} onClick={() => void refresh()}><RefreshCw size={16} /></button>
        <button disabled={busy || !catalog} onClick={create}><Plus size={15} />Создать</button></div>
        <div className="skills-list-items">{catalog?.skills.map(skill => <button key={skill.id} className={`skill-item${(selected?.id ?? draft?.id) === skill.id ? " selected" : ""}${skill.enabled ? "" : " disabled"}`}
          disabled={busy} onClick={() => void open(skill)}><span><FileText size={16} /><strong>{skill.name}</strong>{!skill.editable && <LockKeyhole size={13} />}</span>
          <small>{skill.description}</small><em>{scopeLabels[skill.scope]} · {skill.enabled ? skill.automatic ? "Доступен модели" : "По явному вызову" : "Отключён"}</em></button>)}</div>
        <p className="skills-note">В контекст попадают названия и описания. Полный текст модель читает при использовании навыка.</p>
      </nav>
      <section className="skills-editor" aria-label="Содержание навыка">{draft ? <>
        <div className="skills-fields"><label>Имя<input aria-label="Имя навыка" placeholder="my-skill" disabled={busy || Boolean(draft.id)} value={draft.name} onChange={event => changeName(event.target.value)} /></label>
          <label>Область{current && !current.editable ? <input aria-label="Область навыка" value={scopeLabels[current.scope]} readOnly /> : <select aria-label="Область навыка" disabled={busy || Boolean(draft.id)} value={draft.scope} onChange={event => updateDraft({ ...draft, scope: event.target.value as Draft["scope"] })}><option value="user">Все проекты</option>{catalog?.roots.project && <option value="project">Этот проект</option>}</select>}</label></div>
        {current && <div className="skills-file"><Folder size={13} /><span>{current.filePath}</span></div>}
        {conflict && <p className="skills-alert">Файл изменился или был удалён. Скопируйте нужные правки и откройте актуальную версию; старый черновик не перезапишет её.</p>}
        {current?.warnings.map((warning, index) => <p className="skills-alert" key={index}>{warning}</p>)}
        <div className="skills-document">{preview ? <div className="notebook-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: () => null }}>{draft.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")}</ReactMarkdown></div>
          : <textarea autoFocus aria-label="Инструкции SKILL.md" spellCheck={false} disabled={busy || !editable} value={draft.content} onChange={event => updateDraft({ ...draft, content: event.target.value })} />}</div>
        <footer className="skills-actions"><button onClick={() => setPreview(value => !value)}><BookOpen size={15} />{preview ? "Исходный текст" : "Просмотр"}</button>
          <button className="skills-primary" disabled={!editable || !dirty || busy || Boolean(conflict)} onClick={() => void save()}><Save size={15} />Сохранить</button>
          {current && <><button disabled={busy} onClick={() => void toggle(current)}><Check size={15} />{current.enabled ? "Отключить" : "Включить"}</button>
            <button className="icon-button" title="Удалить навык" aria-label="Удалить навык" disabled={busy || !current.editable} onClick={() => void remove(current)}><Trash2 size={16} /></button></>}
          <small>{!editable ? "Защищён от изменения" : dirty ? "Есть несохранённые изменения" : "Сохранено"}</small></footer>
      </> : <div className="skills-empty"><Sparkles size={38} /><h3>Опыт, который можно использовать снова</h3><p>Выберите навык или создайте новый. Модель тоже умеет создавать и обновлять навыки по вашему запросу.</p><button className="skills-primary" disabled={!catalog || busy} onClick={create}><Plus size={16} />Создать навык</button></div>}</section>
    </div>
    {Boolean(catalog?.diagnostics.length) && <details className="skills-diagnostics"><summary>Замечания каталога ({catalog!.diagnostics.length})</summary>{catalog!.diagnostics.map((message, index) => <p key={index}>{message}</p>)}</details>}
  </dialog>;
}
