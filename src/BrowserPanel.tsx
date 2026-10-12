import { ArrowLeft, ArrowRight, Globe, Plus, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BrowserState, BrowserUiCommand } from "../shared/browser";

export function BrowserPanel({ conversationId }: { conversationId?: string }) {
  const [state, setState] = useState<BrowserState>({ tabs: [], visible: false });
  const [address, setAddress] = useState("https://");
  const [error, setError] = useState("");
  const viewport = useRef<HTMLDivElement>(null);
  const [promptText, setPromptText] = useState("");
  const available = !window.piDesktop.webClient
    && typeof window.piDesktop.browserUi === "function"
    && typeof window.piDesktop.onBrowserChanged === "function";
  const tabs = state.tabs.filter(tab => tab.conversationId === conversationId);
  const tab = tabs.find(item => item.id === state.activeTabId);
  const command = async (value: BrowserUiCommand) => {
    setError("");
    try { setState(await window.piDesktop.browserUi(value)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  useEffect(() => {
    if (!available) return;
    const unsubscribe = window.piDesktop.onBrowserChanged(setState);
    void command({ action: "select-chat", conversationId });
    return () => { unsubscribe(); void window.piDesktop.browserUi({ action: "hide" }).catch(() => undefined); };
  }, [conversationId, available]);
  useEffect(() => { setAddress(tab?.url || "https://"); }, [tab?.id, tab?.url]);
  useEffect(() => {
    const element = viewport.current;
    if (!element || !state.visible || !available) return;
    const resize = () => {
      const r = element.getBoundingClientRect();
      void window.piDesktop.browserUi({ action: "bounds", bounds: { x: r.x, y: r.y, width: r.width, height: r.height } }).catch(cause => setError(String(cause)));
    };
    const observer = new ResizeObserver(resize); observer.observe(element);
    window.addEventListener("resize", resize); resize();
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); };
  }, [state.visible, available, conversationId, tab?.id]);
  if (!available || !conversationId) return null;
  return <>
    <button className="icon-button browser-toggle" title={state.visible ? "Скрыть браузер" : "Встроенный браузер"}
      onClick={() => void command({ action: state.visible ? "hide" : "show" })}><Globe size={18} /></button>
    {state.visible && <section className="browser-panel" aria-label="Встроенный браузер">
      <div className="browser-tabs">
        {tabs.map(item => <div className={`browser-tab${item.id === tab?.id ? " selected" : ""}`} key={item.id}>
          <button onClick={() => void command({ action: "select", tabId: item.id })} title={item.url}>{item.loading ? "Загрузка…" : item.title}</button>
          <button title="Закрыть вкладку" onClick={() => void command({ action: "close", tabId: item.id })}><X size={13} /></button>
        </div>)}
        <button className="icon-button" title="Новая вкладка" onClick={() => void command({ action: "open", conversationId, url: "https://www.google.com" })}><Plus size={16} /></button>
        <button className="icon-button" title="Скрыть без закрытия вкладок" onClick={() => void command({ action: "hide" })}><X size={17} /></button>
      </div>
      <form className="browser-address" onSubmit={event => { event.preventDefault(); const url = /^https?:\/\//i.test(address) ? address : `https://${address}`;
        void command(tab ? { action: "navigate", tabId: tab.id, url } : { action: "open", conversationId, url }); }}>
        <button type="button" className="icon-button" disabled={!tab?.canGoBack} title="Назад" onClick={() => void command({ action: "back", tabId: tab?.id })}><ArrowLeft size={16} /></button>
        <button type="button" className="icon-button" disabled={!tab?.canGoForward} title="Вперёд" onClick={() => void command({ action: "forward", tabId: tab?.id })}><ArrowRight size={16} /></button>
        <button type="button" className="icon-button" disabled={!tab} title={tab?.loading ? "Остановить загрузку" : "Обновить"} onClick={() => void command({ action: tab?.loading ? "stop-loading" : "reload", tabId: tab?.id })}>{tab?.loading ? <X size={15} /> : <RefreshCw size={15} />}</button>
        <input aria-label="Адрес страницы" value={address} onChange={event => setAddress(event.target.value)} placeholder="https://…" />
        <button type="submit">Перейти</button>
      </form>
      <div className="browser-handoff">
        <span>Общая вкладка: ты и модель можете работать с ней напрямую.</span>
        {tab?.viewport && <><span>{tab.viewport.width} × {tab.viewport.height}</span><button onClick={() => void command({ action: "viewport-reset", tabId: tab.id })}>Размер панели</button></>}
        {tab && <select aria-label="Масштаб страницы" value={tab.zoom || 1} onChange={event => void command({ action: "zoom", tabId: tab.id, zoom: Number(event.target.value) })}>
          {[0.5, 0.75, 1, 1.25, 1.5, 2, 3].map(value => <option value={value} key={value}>{Math.round(value * 100)}%</option>)}
        </select>}
      </div>
      {tab?.dialog && <div className="browser-handoff" role="dialog" aria-label="Диалог сайта"><span>{tab.dialog.message}</span>
        {tab.dialog.type === "prompt" && <input aria-label="Ответ сайту" value={promptText} onChange={event => setPromptText(event.target.value)} />}
        <button onClick={() => void command({ action: "dialog", tabId: tab.id, accept: true, promptText })}>ОК</button>
        <button onClick={() => void command({ action: "dialog", tabId: tab.id, accept: false })}>Отмена</button>
      </div>}
      {tab?.fileChooser && <div className="browser-handoff"><span>Сайт запрашивает файл. Выбери только то, что хочешь передать этому сайту.</span>
        <button onClick={() => void command({ action: "choose-files", tabId: tab.id })}>Выбрать файл…</button></div>}
      {(error || tab?.error) && <p className="browser-error" role="alert">{error || tab?.error}</p>}
      <div className="browser-viewport" ref={viewport} aria-label="Страница браузера">
        {!tab && <p>Открой страницу по адресу выше или попроси модель воспользоваться браузером.</p>}
      </div>
      {(state.downloads || []).filter(item => item.conversationId === conversationId).slice(-5).map(item => <div className="browser-handoff" key={item.id}>
        <span>{item.filename} — {item.state === "completed" ? "Скачано" : item.state === "progressing" ? `${Math.round(item.receivedBytes / 1024)} / ${Math.round(item.totalBytes / 1024)} КБ` : item.state}</span>
        {item.state === "completed" && <button onClick={() => void command({ action: "reveal-download", downloadId: item.id })}>Показать файл</button>}
      </div>)}
    </section>}
  </>;
}
