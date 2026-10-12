import { useEffect, useState } from "react";
import { notebookLimit, validateNotebookLimit } from "../shared/notebook";

export function NotebookSettings() {
  const [value, setValue] = useState(String(notebookLimit));
  const [saved, setSaved] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let cancelled = false;
    window.piDesktop.getNotebookCharacterLimit().then(limit => {
      if (!cancelled) { setValue(String(limit)); setSaved(limit); }
    }).catch(error => { if (!cancelled) setMessage(String(error)); });
    return () => { cancelled = true; };
  }, []);
  const save = async () => {
    setBusy(true); setMessage("");
    try {
      const limit = await window.piDesktop.setNotebookCharacterLimit(validateNotebookLimit(Number(value)));
      setSaved(limit); setValue(String(limit)); setMessage("Сохранено. Применяется ко всем чатам без перезапуска.");
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <>
    <h2>Блокнот</h2>
    <div className="settings-card server-discovery-card">
      <label className="server-port-field"><span>Максимум символов в блокноте каждого чата</span>
        <input type="number" min={1} step={1} value={value} disabled={busy || saved === undefined}
          onChange={event => { setValue(event.target.value); setMessage(""); }} />
      </label>
      <p>По умолчанию — 12 000. Большие записи занимают больше контекста модели. При уменьшении лимита существующие записи не обрезаются.</p>
      <button disabled={busy || saved === undefined || Number(value) === saved} onClick={() => void save()}>{busy ? "Сохраняю…" : "Сохранить лимит"}</button>
      {message && <p role="status">{message}</p>}
    </div>
  </>;
}
