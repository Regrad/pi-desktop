import { useState } from "react";
import type { InterfaceLanguage } from "../shared/interface-language";
import { setLanguage, t, useLanguage } from "./i18n";

export function LanguageSettings() {
  const language = useLanguage();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const changeLanguage = async (next: InterfaceLanguage) => {
    setSaving(true);
    setError("");
    try {
      setLanguage(await window.piDesktop.setInterfaceLanguage(next));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };
  return <>
    <h2>{t("Язык интерфейса")}</h2>
    <div className="settings-card language-settings">
      <label htmlFor="interface-language">{t("Язык")}</label>
      <select id="interface-language" value={language} disabled={saving}
        onChange={event => void changeLanguage(event.target.value as InterfaceLanguage)}>
        <option value="en">English</option>
        <option value="ru">Русский</option>
      </select>
      <p>{t("По умолчанию — English. Изменения применяются сразу и сохраняются для следующего запуска. Язык ответов модели не меняется.")}</p>
      {error && <p role="alert">{error}</p>}
    </div>
  </>;
}
