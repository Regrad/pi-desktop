import { useEffect, useState } from "react";
import type { SaveWebSearchSettings, WebSearchKey, WebSearchSettings } from "../shared/web-search";
import { t } from "./i18n";

const providers = { auto: "Автоматически", serper: "Serper", searxng: "SearXNG", tavily: "Tavily",
  keenable: "Keenable", firecrawl: "Firecrawl", jina: "Jina", cohere: "Cohere", none: "Выключено" };
const keys: Record<WebSearchKey, keyof typeof providers> = {
  serperApiKey: "serper", searxngApiKey: "searxng", tavilyApiKey: "tavily", keenableApiKey: "keenable",
  firecrawlApiKey: "firecrawl", jinaApiKey: "jina", cohereApiKey: "cohere",
};

export function WebSearchSettingsPanel() {
  const [settings, setSettings] = useState<WebSearchSettings>();
  const [edits, setEdits] = useState<SaveWebSearchSettings["keys"]>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (!window.piDesktop.webClient) void window.piDesktop.getWebSearchSettings().then(setSettings).catch(error => setMessage(String(error)));
  }, []);
  if (window.piDesktop.webClient) return <>
    <h1>{t("Веб-поиск")}</h1><p>{t("Провайдеры веб-поиска настраиваются в настольном приложении.")}</p>
  </>;
  if (!settings) return <><h1>{t("Веб-поиск")}</h1><p role="status">{message || t("Загрузка…")}</p></>;

  const select = <Field extends "searchProvider" | "scraperProvider" | "rerankerType">(
    field: Field, label: string, options: readonly WebSearchSettings[Field][],
  ) => <label>
    {t(label)}
    <select value={settings[field]} disabled={busy} onChange={event => setSettings({ ...settings, [field]: event.target.value })}>
      {options.map(option => <option key={option} value={option}>{t(providers[option])}</option>)}
    </select>
  </label>;

  const save = async () => {
    setMessage("");
    setBusy(true);
    try {
      setSettings(await window.piDesktop.saveWebSearchSettings({ ...settings, keys: edits }));
      setEdits({});
      setMessage(t("Настройки веб-поиска сохранены."));
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  return <>
    <h1>{t("Веб-поиск")}</h1>
    <div className="settings-card web-search-settings">
      {select("searchProvider", "Поисковик", ["auto", "serper", "searxng", "tavily", "keenable"])}
      {select("scraperProvider", "Чтение страниц", ["auto", "firecrawl", "serper", "tavily", "keenable"])}
      {select("rerankerType", "Ранжирование выдержек", ["auto", "jina", "cohere", "none"])}
      {["auto", "searxng"].includes(settings.searchProvider) && <label>
        {t("Адрес SearXNG")}
        <input value={settings.searxngInstanceUrl} placeholder="https://search.example.org" disabled={busy}
          onChange={event => setSettings({ ...settings, searxngInstanceUrl: event.target.value })} />
      </label>}
      {["auto", "firecrawl"].includes(settings.scraperProvider) && <label>
        {t("Адрес Firecrawl")}
        <input value={settings.firecrawlApiUrl} placeholder="https://api.firecrawl.dev" disabled={busy}
          onChange={event => setSettings({ ...settings, firecrawlApiUrl: event.target.value })} />
      </label>}
      <details className="web-search-keys">
        <summary>{t("Ключи API")}</summary>
        {(Object.keys(keys) as WebSearchKey[]).map(key => <label key={key}>
          {providers[keys[key]]}
          <span>
            <input type="password" autoComplete="off" value={edits[key] ?? ""} disabled={busy}
              placeholder={edits[key] === null ? t("Будет удалён") : settings.savedKeys[key] ? t("Ключ настроен") :
                settings.configuredKeys[key] ? t("Из переменной окружения") : t("Нет ключа")}
              onChange={event => setEdits({ ...edits, [key]: event.target.value })} />
            {settings.savedKeys[key] && edits[key] !== null && <button type="button" disabled={busy}
              onClick={() => setEdits({ ...edits, [key]: null })}>{t("Удалить ключ")}</button>}
          </span>
        </label>)}
      </details>
      <button type="button" disabled={busy} onClick={() => void save()}>{t("Сохранить")}</button>
      {message && <p role="status">{message}</p>}
    </div>
  </>;
}
