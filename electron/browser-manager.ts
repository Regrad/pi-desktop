import { BrowserWindow, WebContentsView, session, dialog, shell } from "electron";
import path from "node:path";
import { chatDirectory } from "../resources/pi-comfyui/lib/chat-storage.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { BrowserAutomation, type BrowserLocator } from "./browser-automation.js";
import { BrowserSiteTools, webMcpBootstrap } from "./browser-site-tools.js";
import type { BrowserState, BrowserUiCommand, BrowserTab, BrowserDownload } from "../shared/browser.js";

type Tab = { record: BrowserTab; view: WebContentsView; queue: Promise<unknown>; initialized: Promise<void>; started: boolean; epoch: number; fileNode?: number; requests: Set<string>; activity: number; automation?: BrowserAutomation; siteTools?: BrowserSiteTools; logs: { level: string; message: string; source?: string; line?: number; timestamp: number }[] };
function inputOptions(params: Record<string, unknown>): { button: "left" | "right" | "middle"; modifiers: number; clickCount: number } {
  const button = params.button ?? "left", modifiers = params.modifiers ?? 0, clickCount = params.clickCount ?? 1;
  if (!["left", "right", "middle"].includes(String(button)) || !Number.isInteger(modifiers) || Number(modifiers) < 0 || Number(modifiers) > 15 || !Number.isInteger(clickCount) || Number(clickCount) < 1 || Number(clickCount) > 3) throw new Error("Неверная кнопка или модификаторы ввода.");
  return { button: button as "left" | "right" | "middle", modifiers: Number(modifiers), clickCount: Number(clickCount) };
}
function browserKey(key: unknown): { key: string; windowsVirtualKeyCode: number } {
  const keys: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowRight: 39, ArrowUp: 38, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, Insert: 45, Space: 32, Control: 17, Shift: 16, Alt: 18, Meta: 91 };
  if (typeof key !== "string") throw new Error("Поддерживаются клавиши и сочетания с modifiers.");
  if (Object.hasOwn(keys, key)) return { key: key === "Space" ? " " : key, windowsVirtualKeyCode: keys[key] };
  if (/^F([1-9]|1[0-2])$/.test(key)) return { key, windowsVirtualKeyCode: 111 + Number(key.slice(1)) };
  if (key.length === 1) {
    const punctuation: Record<string, number> = { ";": 186, ":": 186, "=": 187, "+": 187, ",": 188, "<": 188, "-": 189, "_": 189, ".": 190, ">": 190, "/": 191, "?": 191, "`": 192, "~": 192, "[": 219, "{": 219, "\\": 220, "|": 220, "]": 221, "}": 221, "'": 222, '"': 222, " ": 32 };
    return { key, windowsVirtualKeyCode: /^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : punctuation[key] || 0 };
  }
  throw new Error("Поддерживаются клавиши и сочетания с modifiers.");
}
export function browserUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 8192) throw new Error("Нужен адрес HTTP или HTTPS.");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Разрешены только HTTP/HTTPS без пароля в адресе.");
  return url.href;
}

// Fixed observation script, never supplied by the model. No form values, cookies or storage.
const pageDescription = `(() => {
  const visible = el => { const r=el.getBoundingClientRect(), s=getComputedStyle(el); return r.width>0 && r.height>0 && r.bottom>0 && r.right>0 && r.top<innerHeight && r.left<innerWidth && s.visibility!=='hidden' && s.display!=='none'; };
  const text=[]; const walk=document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n; while((n=walk.nextNode()) && text.join(' ').length<12000) { const el=n.parentElement; if(el && !el.closest('script,style,noscript,input,textarea,[contenteditable]') && visible(el)) { const t=n.textContent.trim(); if(t) text.push(t); } }
  const controls=[...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]')].filter(visible).slice(0,150).map(el=>{const r=el.getBoundingClientRect();return {tag:el.tagName.toLowerCase(),type:el.getAttribute('type'),role:el.getAttribute('role'),disabled:el.disabled===true,label:(el.getAttribute('aria-label')||[...(el.labels||[])].map(l=>l.textContent).join(' ')||el.getAttribute('placeholder')||((el.matches('input,textarea,[contenteditable]'))?'':el.textContent)||'').trim().slice(0,160),x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};});
  return {text:text.join(' ').slice(0,12000),controls};
})()`;

export class BrowserManager {
  private tabs = new Map<string, Tab>();
  private activeTabId?: string;
  private conversationId?: string;
  private visible = false;
  private viewportReady = false;
  private bounds = { x: 0, y: 0, width: 1000, height: 700 };
  private getWindow: () => BrowserWindow | null;
  private changed: (state: BrowserState) => void;
  private browserSession: Electron.Session;
  private downloads = new Map<string, BrowserDownload>();

  constructor(dataDir: string, getWindow: () => BrowserWindow | null, changed: (state: BrowserState) => void) {
    this.getWindow = getWindow; this.changed = changed;
    const directory = path.join(dataDir, "browser"); mkdirSync(directory, { recursive: true });
    this.browserSession = session.fromPath(directory);
    this.browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    this.browserSession.setPermissionCheckHandler(() => false);
    // Cookies stay shared; downloaded files belong to the initiating chat.
    this.browserSession.on("will-download", (event, item, contents) => {
      const tab = [...this.tabs.values()].find(tab => tab.view.webContents === contents);
      if (!tab) { event.preventDefault(); return; }
      const filename = path.basename(item.getFilename()).replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 150).replace(/[. ]+$/, "");
      const ownedDownloads = path.join(chatDirectory(dataDir, tab.record.conversationId), "downloads");
      mkdirSync(ownedDownloads, { recursive: true });
      const id = randomUUID(), destination = path.join(ownedDownloads, `${id}-${filename || "download"}`);
      item.setSavePath(destination);
      const record: BrowserDownload = { id, tabId: tab.record.id, conversationId: tab.record.conversationId, filename: filename || "download", path: destination, receivedBytes: 0, totalBytes: item.getTotalBytes(), state: "progressing" };
      this.downloads.set(id, record);
      const refresh = (state: string) => { record.state = state; record.receivedBytes = item.getReceivedBytes(); record.totalBytes = item.getTotalBytes(); this.publish(); };
      item.on("updated", (_event, state) => refresh(state)); item.once("done", (_event, state) => refresh(state)); this.publish();
    });
  }
  state(): BrowserState {
    return { tabs: [...this.tabs.values()].map(tab => ({ ...tab.record })), visible: this.visible,
      activeTabId: this.activeTabId, conversationId: this.conversationId,
      downloads: [...this.downloads.values()].map(item => ({ ...item })) };
  }
  private publish(): void { this.changed(this.state()); }
  private metadata(tab: Tab): BrowserTab {
    let url = tab.record.url;
    try {
      const parsed = new URL(url);
      for (const key of [...parsed.searchParams.keys()]) if (/^(code|access_token|id_token|refresh_token|token|password|secret|client_secret)$/i.test(key)) parsed.searchParams.set(key, "[redacted]");
      if (/token|secret|password|code=/i.test(parsed.hash)) parsed.hash = "";
      url = parsed.href;
    } catch { url = ""; }
    return { ...tab.record, url };
  }
  private layout(): void {
    const win = this.getWindow();
    if (!win || win.isDestroyed()) return;
    for (const tab of this.tabs.values()) {
      const displayed = this.visible && this.viewportReady && tab.record.id === this.activeTabId && tab.record.conversationId === this.conversationId;
      if (!win.contentView.children.includes(tab.view)) win.contentView.addChildView(tab.view);
      // Keep hidden tabs rendered outside the window's clipped content area.
      // setVisible(false) discards a never-shown view's capture surface.
      const size = this.pageSize(tab), scale = displayed ? this.presentationScale(tab) : 1;
      const width = Math.round(size.width * scale), height = Math.round(size.height * scale);
      tab.view.setBounds(displayed ? { ...this.bounds, width, height } : { x: -width - 1, y: -height - 1, width, height });
      if (displayed || tab.record.viewport) void this.applyViewport(tab).catch(() => undefined);
      void tab.view.webContents.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: !this.visible || tab.record.id !== this.activeTabId }).catch(() => undefined);
      tab.view.setVisible(true);
    }
  }
  private tab(id: unknown, owner?: string): Tab {
    const tab = typeof id === "string" ? this.tabs.get(id) : undefined;
    if (!tab || (owner && tab.record.conversationId !== owner)) throw new Error("Вкладка не найдена в этом чате. Используйте browser list.");
    return tab;
  }
  private open(owner: string, url: string): Tab {
    if (this.tabs.size >= 20) throw new Error("Закройте лишние вкладки (максимум 20).");
    const view = new WebContentsView({ webPreferences: { session: this.browserSession, sandbox: true,
      nodeIntegration: false, contextIsolation: true, webSecurity: true, enableBlinkFeatures: "WebMCP" } });
    view.setVisible(false);
    const tab: Tab = { record: { id: randomUUID(), conversationId: owner, title: "Новая вкладка", url, loading: true }, view, queue: Promise.resolve(), initialized: Promise.resolve(), started: false, epoch: 0, requests: new Set(), activity: Date.now(), logs: [] };
    this.tabs.set(tab.record.id, tab);
    if (owner === this.conversationId) this.activeTabId = tab.record.id;
    const wc = view.webContents;
    const refresh = () => {
      if (wc.isDestroyed()) return;
      tab.record.title = wc.getTitle() || "Новая вкладка"; tab.record.url = wc.getURL() || url;
      tab.record.loading = wc.isLoading();
      tab.record.canGoBack = wc.navigationHistory.canGoBack(); tab.record.canGoForward = wc.navigationHistory.canGoForward();
      this.publish();
    };
    wc.on("did-start-loading", refresh); wc.on("did-stop-loading", refresh); wc.on("page-title-updated", refresh); wc.on("did-navigate-in-page", refresh);
    const navigation = (event: Electron.Event, target: string) => { try { browserUrl(target); } catch { event.preventDefault(); } };
    wc.on("will-navigate", navigation); wc.on("will-redirect", navigation);
    wc.setWindowOpenHandler(({ url: target }) => {
      try { this.open(owner, browserUrl(target)); } catch { /* Do not launch external protocols or executables. */ }
      return { action: "deny" };
    });
    wc.on("did-fail-load", (_event, code, description, _url, main) => {
      if (main && code !== -3) { tab.record.error = description; this.publish(); }
    });
    wc.on("render-process-gone", () => { tab.record.error = "Процесс вкладки завершился. Перезагрузите страницу."; this.publish(); });
    wc.on("console-message", details => {
      tab.logs.push({ level: details.level, message: details.message.slice(0, 4000), source: details.sourceId, line: details.lineNumber, timestamp: Date.now() });
      if (tab.logs.length > 200) tab.logs.shift();
    });
    wc.debugger.on("message", (_event, method, params) => {
      if (method === "Runtime.exceptionThrown") {
        const exception = params.exceptionDetails;
        tab.logs.push({ level: "error", message: String(exception?.exception?.description || exception?.text || "JavaScript error").slice(0, 4000), source: exception?.url, line: exception?.lineNumber, timestamp: Date.now() });
        if (tab.logs.length > 200) tab.logs.shift();
      }
      if (method === "Network.requestWillBeSent") { tab.requests.add(params.requestId); tab.activity = Date.now(); }
      else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") { tab.requests.delete(params.requestId); tab.activity = Date.now(); }
      if (method === "Page.javascriptDialogOpening") { tab.record.dialog = { type: params.type, message: String(params.message).slice(0, 4000), defaultPrompt: params.defaultPrompt }; this.publish(); }
      else if (method === "Page.javascriptDialogClosed") { tab.record.dialog = undefined; this.publish(); }
      else if (method === "Page.fileChooserOpened") { tab.fileNode = params.backendNodeId; tab.record.fileChooser = { multiple: params.mode === "selectMultiple" }; this.publish(); }
    });
    wc.debugger.attach("1.3");
    void wc.debugger.sendCommand("Network.enable").catch(error => { tab.record.error = String(error); this.publish(); });
    wc.setBackgroundThrottling(false);
    tab.initialized = wc.loadURL("about:blank")
      .then(() => wc.debugger.sendCommand("Page.enable"))
      .then(() => wc.debugger.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true }))
      .then(() => wc.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: webMcpBootstrap }))
      .then(() => { tab.started = true; void wc.loadURL(url).catch(error => { tab.record.error = String(error); this.publish(); }); this.layout(); })
      .catch(error => { tab.record.error = String(error); this.publish(); throw error; });
    void tab.initialized.catch(() => undefined);
    this.layout(); this.publish();
    return tab;
  }
  private close(tab: Tab): void {
    tab.automation?.disconnect();
    tab.siteTools?.cancel();
    this.tabs.delete(tab.record.id);
    this.getWindow()?.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    if (this.activeTabId === tab.record.id) this.activeTabId = [...this.tabs.values()].find(item => item.record.conversationId === this.conversationId)?.record.id;
    this.layout(); this.publish();
  }
  async ui(command: BrowserUiCommand): Promise<BrowserState> {
    if (command.action === "select-chat") {
      if (this.conversationId !== command.conversationId) this.viewportReady = false;
      this.conversationId = command.conversationId;
      this.activeTabId = [...this.tabs.values()].find(tab => tab.record.conversationId === this.conversationId)?.record.id;
    } else if (command.action === "show" || command.action === "hide") this.visible = command.action === "show";
    else if (command.action === "bounds") {
      const b = command.bounds, win = this.getWindow();
      if (!b || !win || !Object.values(b).every(Number.isFinite)) throw new Error("Неверные размеры браузера.");
      const [width, height] = win.getContentSize();
      this.viewportReady = b.width > 0 && b.height > 0;
      this.bounds = { x: Math.max(0, Math.round(b.x)), y: Math.max(0, Math.round(b.y)),
        width: Math.max(1, Math.min(Math.round(b.width), width - Math.max(0, Math.round(b.x)))),
        height: Math.max(1, Math.min(Math.round(b.height), height - Math.max(0, Math.round(b.y)))) };
    } else if (command.action === "open") {
      if (!command.conversationId) throw new Error("Сначала откройте чат.");
      this.open(command.conversationId, browserUrl(command.url));
    } else if (command.action === "reveal-download") {
      const item = command.downloadId ? this.downloads.get(command.downloadId) : undefined;
      if (!item || item.conversationId !== this.conversationId || item.state !== "completed") throw new Error("Загрузка не завершена или принадлежит другому чату.");
      shell.showItemInFolder(item.path);
    } else {
      const tab = this.tab(command.tabId);
      if (command.action === "select") this.activeTabId = tab.record.id;
      else if (command.action === "choose-files") {
        const win = this.getWindow(); if (!win) throw new Error("Окно приложения закрыто.");
        const epoch = tab.epoch;
        const selected = await dialog.showOpenDialog(win, { properties: tab.record.fileChooser?.multiple ? ["openFile", "multiSelections"] : ["openFile"] });
        if (tab.epoch !== epoch) throw new Error("Управление изменилось.");
        if (!selected.canceled) await this.upload(tab, selected.filePaths);
      } else if (command.action === "dialog") {
        await this.answerDialog(tab, command.accept, command.promptText);
      } else if (command.action === "zoom") {
        this.cancelTab(tab);
        this.zoom(tab, command.zoom);
      } else if (command.action === "viewport-reset") {
        this.cancelTab(tab); tab.record.viewport = undefined; await this.applyViewport(tab);
      } else if (command.action === "stop-loading") {
        tab.view.webContents.stop();
      } else if (command.action === "close") this.close(tab);
      else if (command.action === "navigate") { const url = browserUrl(command.url); this.cancelTab(tab); tab.record.error = undefined; void tab.view.webContents.loadURL(url).catch(error => { tab.record.error = error.message; this.publish(); }); }
      else if (command.action === "reload") { this.cancelTab(tab); tab.view.webContents.reload(); }
      else if (command.action === "back" && tab.view.webContents.navigationHistory.canGoBack()) { this.cancelTab(tab); tab.view.webContents.navigationHistory.goBack(); }
      else if (command.action === "forward" && tab.view.webContents.navigationHistory.canGoForward()) { this.cancelTab(tab); tab.view.webContents.navigationHistory.goForward(); }
      else if (!["back", "forward"].includes(command.action)) throw new Error("Неизвестное действие браузера.");
    }
    this.layout(); this.publish(); return this.state();
  }
  async request(owner: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const action = params.action;
    if (action === "list") return { tabs: [...this.tabs.values()].filter(tab => tab.record.conversationId === owner).map(tab => this.metadata(tab)) };
    if (action === "open") return { tab: this.metadata(this.open(owner, browserUrl(params.url))) };
    if (action === "downloads") return { downloads: [...this.downloads.values()].filter(item => item.conversationId === owner).map(item => ({ ...item })) };
    const tab = this.tab(params.tabId, owner);
    const epoch = tab.epoch;
    if (action === "show" || action === "hide" || action === "select" || action === "handoff") {
      if (action === "handoff") this.cancelTab(tab, true);
      if (this.conversationId === owner) { this.visible = action !== "hide"; this.activeTabId = tab.record.id; this.layout(); this.publish(); }
      return { tab: this.metadata(tab), visible: this.visible && this.conversationId === owner };
    }
    const check = () => {
      if (!this.tabs.has(tab.record.id) || tab.view.webContents.isDestroyed()) throw new Error("Вкладка закрыта.");
      if (tab.epoch !== epoch) throw new Error("Действие браузера отменено. Получите актуальное состояние перед продолжением.");
    };
    const work = tab.queue.catch(() => undefined).then(async () => {
      await tab.initialized;
      check(); const wc = tab.view.webContents;
      await this.applyViewport(tab);
      if (action === "close") { this.close(tab); return { closed: true }; }
      if (action === "webmcp-list" || action === "webmcp-call" || action === "webmcp-result") {
        tab.siteTools ||= new BrowserSiteTools(wc);
        if (action === "webmcp-list") { const tools = await tab.siteTools.list(); check(); return { tab: this.metadata(tab), tools, untrusted: true }; }
        if (action === "webmcp-result") { const result = await tab.siteTools.result(params.callId); check(); return { tab: this.metadata(tab), result, untrusted: true }; }
        if (params.approved !== true) throw new Error("Нужно подтверждение пользователя для вызова инструмента сайта.");
        const timeout = params.timeoutMs ?? 10000;
        if (!Number.isInteger(timeout) || Number(timeout) < 1 || Number(timeout) > 30000) throw new Error("Таймаут: 1–30000 мс.");
        if (tab.siteTools.describe(params.toolId)?.kind === "form" && this.conversationId === owner) {
          this.visible = true; this.activeTabId = tab.record.id; this.layout(); this.publish();
        }
        const result = await tab.siteTools.call(params.toolId, params.arguments ?? {}, Number(timeout));
        check(); return { tab: this.metadata(tab), result, untrusted: true };
      }
      if (action === "logs") {
        const limit = params.limit ?? 50;
        if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 200 || (params.filter !== undefined && typeof params.filter !== "string")) throw new Error("Неверный фильтр журнала.");
        return { tab: this.metadata(tab), logs: tab.logs.filter(item => (!params.filter || item.message.includes(String(params.filter))) && (!params.levels || Array.isArray(params.levels) && params.levels.includes(item.level))).slice(-Number(limit)), untrusted: true };
      }
      if (action === "screenshot" && params.vision === true && (params.fullPage === true || params.clip !== undefined)) {
        if (params.fullPage === true && params.clip !== undefined) throw new Error("Выберите fullPage или clip, не оба сразу.");
        const clip = params.clip as { x: number; y: number; width: number; height: number } | undefined;
        if (params.clip !== undefined && (!clip || typeof clip !== "object" || ![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite) || clip.x < 0 || clip.y < 0 || clip.width <= 0 || clip.height <= 0)) throw new Error("Неверная область снимка.");
        const timeout = params.timeoutMs ?? 10000;
        if (!Number.isInteger(timeout) || Number(timeout) < 1 || Number(timeout) > 30000) throw new Error("Таймаут снимка: 1–30000 мс.");
        tab.automation ||= new BrowserAutomation(wc, () => this.visible && this.viewportReady && tab.record.id === this.activeTabId ? this.presentationScale(tab) : 1);
        const page = await tab.automation.page(); check();
        const size = clip || (params.fullPage ? await page.evaluate(() => ({ width: Math.max(document.documentElement.scrollWidth, innerWidth), height: Math.max(document.documentElement.scrollHeight, innerHeight) })) : this.pageSize(tab));
        if (size.width > 3840 || size.height > 16000 || size.width * size.height > 16000000) throw new Error("Снимок слишком большой: используйте clip (до 16 млн пикселей).");
        const captureSize = { width: Math.ceil(Math.max(this.pageSize(tab).width, clip ? clip.x + clip.width : size.width)), height: Math.ceil(Math.max(this.pageSize(tab).height, clip ? clip.y + clip.height : size.height)) };
        if (captureSize.width * captureSize.height > 16000000 || captureSize.width > 3840 || captureSize.height > 16000) throw new Error("Область снимка слишком большая.");
        const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY })); check();
        try {
          // Electron's native capture works for clipped-out hidden views. Render
          // the requested extent, then restore the same live view immediately.
          tab.view.setBounds({ x: -captureSize.width - 1, y: -captureSize.height - 1, ...captureSize });
          await wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride", { ...captureSize, deviceScaleFactor: 1, mobile: false, scale: 1 });
          await page.evaluate(() => window.scrollTo(0, 0)); check();
          const image = await this.untilDialog(tab, wc.capturePage(), Number(timeout)); check();
          if (!image) return { tab: this.metadata(tab), dialog: tab.record.dialog };
          if (image.isEmpty()) throw new Error("Chromium ещё не отрисовал страницу. Повторите снимок после wait.");
          const normalized = image.resize(captureSize);
          const cropped = clip ? normalized.crop({ x: Math.floor(clip.x), y: Math.floor(clip.y), width: Math.ceil(clip.x + clip.width) - Math.floor(clip.x), height: Math.ceil(clip.y + clip.height) - Math.floor(clip.y) }) : normalized;
          return { tab: this.metadata(tab), viewport: this.pageSize(tab), image: cropped.toPNG().toString("base64"), screenshot: { fullPage: params.fullPage === true, clip, coordinateSpace: "Use viewport state before coordinate actions" } };
        } finally {
          if (!wc.isDestroyed()) {
            this.layout(); await this.applyViewport(tab);
            if (tab.epoch === epoch) await page.evaluate(position => window.scrollTo(position.x, position.y), scroll).catch(() => undefined);
          }
        }
      }
      if (params.locator !== undefined || action === "snapshot") {
        tab.automation ||= new BrowserAutomation(wc, () => this.visible && this.viewportReady && tab.record.id === this.activeTabId ? this.presentationScale(tab) : 1);
        const timeout = params.timeoutMs ?? 10000;
        if (!Number.isInteger(timeout) || Number(timeout) < 1 || Number(timeout) > 30000) throw new Error("Таймаут действия: 1–30000 мс.");
        if (action === "snapshot") {
          const page = await tab.automation.page();
          // Explicit DOM inspection only, including each accessible frame.
          const frames = [];
          for (const frame of page.frames()) {
            const document = await frame.evaluate<{ url: string; name: string }>("({url:location.href,name:window.name})");
            frames.push({ ...document, snapshot: await frame.evaluate(pageDescription) });
          }
          check(); return { tab: this.metadata(tab), frames, untrusted: true };
        }
        const locator = await tab.automation.locator(params.locator as BrowserLocator); check();
        const options = { timeout: Number(timeout) };
        if (action === "wait") {
          const state = params.elementState ?? "visible";
          if (!["attached", "detached", "visible", "hidden"].includes(String(state))) throw new Error("Неверное состояние элемента.");
          try { await locator.waitFor({ ...options, state: state as "visible" }); }
          catch (error) { check(); if ((error as Error).name === "TimeoutError") return { tab: this.metadata(tab), ready: false, timedOut: true }; throw error; }
          check(); return { tab: this.metadata(tab), ready: true, timedOut: false };
        }
        if (action === "click") {
          const input = inputOptions(params), modifiers = ["Alt", "Control", "Meta", "Shift"].filter((_name, index) => input.modifiers & (1 << index)) as ("Alt" | "Control" | "Meta" | "Shift")[];
          await locator.click({ ...options, button: input.button, clickCount: input.clickCount, modifiers });
        } else if (action === "move") await locator.hover(options);
        else if (action === "fill" || action === "type") {
          if (typeof params.text !== "string" || params.text.length > 10000) throw new Error("Нужен текст до 10000 символов.");
          if (action === "fill" || params.replace === true) await locator.fill(params.text, options);
          else await locator.pressSequentially(params.text, options);
        } else if (action === "check" || action === "uncheck") await locator.setChecked(action === "check", options);
        else if (action === "select-option") {
          if (!Array.isArray(params.values) || params.values.some(value => typeof value !== "string") || params.values.length > 100) throw new Error("Нужны значения option (до 100).");
          await locator.selectOption(params.values, options);
        } else if (action === "key") {
          const input = inputOptions(params);
          if (typeof params.key !== "string" || !params.key || params.key.length > 100 || /(?:Control|Meta|ControlOrMeta)(?:\+[^+]+)*\+v$/i.test(params.key) || ((input.modifiers & 6) && params.key.toLowerCase() === "v")) throw new Error("Неверная клавиша или запрещённая вставка из буфера.");
          const modifiers = ["Alt", "Control", "Meta", "Shift"].filter((_name, index) => input.modifiers & (1 << index));
          await locator.press([...modifiers, params.key].join("+"), options);
        } else throw new Error("Это действие не поддерживает locator.");
        check(); return { tab: this.metadata(tab), viewport: this.pageSize(tab), loading: wc.isLoading() };
      }
      if (action === "viewport" || action === "viewport-reset") {
        if (action === "viewport") {
          if (!Number.isInteger(params.width) || !Number.isInteger(params.height) || Number(params.width) < 200 || Number(params.width) > 3840 || Number(params.height) < 200 || Number(params.height) > 2160) throw new Error("Размер страницы: ширина 200–3840, высота 200–2160.");
          tab.record.viewport = { width: Number(params.width), height: Number(params.height) };
        } else tab.record.viewport = undefined;
        this.layout(); await this.applyViewport(tab); check(); this.publish();
        return { tab: this.metadata(tab), viewport: this.pageSize(tab) };
      }
      if (action === "navigate") { tab.record.error = undefined; void wc.loadURL(browserUrl(params.url)).catch(error => { tab.record.error = String(error); this.publish(); }); }
      if (action === "stop-loading") wc.stop();
      if (action === "dialog") { await this.answerDialog(tab, params.accept, params.promptText); check(); }
      if (action === "upload") { await this.upload(tab, params.files); check(); }
      if (action === "wait") return this.wait(tab, params, check);
      if (tab.record.dialog) return { tab: this.metadata(tab), dialog: tab.record.dialog, note: "Ответьте на диалог через dialog или передайте управление пользователю через handoff." };
      if (wc.isLoading() && action !== "state" && action !== "screenshot") return { tab: this.metadata(tab), loading: true, note: "Страница загружается. Используйте wait перед следующим действием." };
      check();
      if (action === "reload") wc.reload();
      else if (action === "zoom") this.zoom(tab, params.zoom);
      else if (action === "back" && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      else if (action === "forward" && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      const cdp = async (method: string, args: Record<string, unknown> = {}) => {
        check(); if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
        if (method.startsWith("Input.") && (!this.visible || tab.record.id !== this.activeTabId)) await wc.debugger.sendCommand("Emulation.setFocusEmulationEnabled", { enabled: true });
        if (method === "Input.dispatchMouseEvent" && this.visible && this.viewportReady && tab.record.id === this.activeTabId && tab.record.viewport) {
          const scale = this.presentationScale(tab);
          args = { ...args, x: Number(args.x) * scale, y: Number(args.y) * scale,
            ...(args.type === "mouseWheel" ? { deltaX: Number(args.deltaX) * scale, deltaY: Number(args.deltaY) * scale } : {}) };
        }
        check();
        return this.untilDialog(tab, wc.debugger.sendCommand(method, args));
      };
      if (["click", "move", "drag", "scroll"].includes(String(action))) {
        const options = inputOptions(params);
        const x = params.x, y = params.y;
        const size = this.pageSize(tab);
        if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= size.width || y >= size.height) throw new Error("Координаты должны находиться внутри снимка страницы.");
        if (action === "click" || action === "drag") {
          if (action === "drag" && (typeof params.endX !== "number" || typeof params.endY !== "number" || !Number.isFinite(params.endX) || !Number.isFinite(params.endY) || params.endX < 0 || params.endY < 0 || params.endX >= size.width || params.endY >= size.height)) throw new Error("Неверная конечная точка перетаскивания.");
          for (let count = 1; count <= options.clickCount; count++) {
          await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, ...options, clickCount: count });
          try {
          if (action === "drag") for (let step = 1; step <= 8; step++) await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + (Number(params.endX) - x) * step / 8, y: y + (Number(params.endY) - y) * step / 8, button: options.button, buttons: options.button === "left" ? 1 : options.button === "right" ? 2 : 4, modifiers: options.modifiers });
          await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: action === "drag" ? params.endX : x, y: action === "drag" ? params.endY : y, ...options, clickCount: count });
          } catch (error) {
            // A Stop during a drag must not leave Chromium's button held.
            const scale = this.visible && this.viewportReady && tab.record.id === this.activeTabId ? this.presentationScale(tab) : 1;
            if (!wc.isDestroyed()) await wc.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: x * scale, y: y * scale, ...options, clickCount: count }).catch(() => undefined);
            throw error;
          }
          }
        } else if (action === "move") {
          await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        } else {
          const dx = params.deltaX ?? 0, dy = params.deltaY ?? 0;
          if (typeof dx !== "number" || typeof dy !== "number" || !Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 10000 || Math.abs(dy) > 10000) throw new Error("Неверная прокрутка.");
          await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: dx, deltaY: dy });
        }
      } else if (action === "type") {
        if (typeof params.text !== "string" || params.text.length > 10000) throw new Error("Нужен текст до 10000 символов.");
        if (params.replace === true) {
          await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
          await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
        }
        await cdp("Input.insertText", { text: params.text });
      } else if (action === "key") {
        const key = browserKey(params.key), { modifiers } = inputOptions(params);
        if (key.key.toLowerCase() === "v" && (modifiers & 6)) throw new Error("Вставка из системного буфера доступна только пользователю.");
        await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...key, modifiers, ...(key.key.length === 1 && !(modifiers & 6) ? { text: key.key } : {}) });
        await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...key, modifiers });
      } else if (!["state", "screenshot", "navigate", "stop-loading", "zoom", "dialog", "upload", "reload", "back", "forward"].includes(String(action))) throw new Error("Неизвестное действие браузера.");
      if (tab.record.dialog) { check(); return { tab: this.metadata(tab), dialog: tab.record.dialog }; }
      if (action !== "state" && action !== "screenshot") { check(); return { tab: this.metadata(tab), viewport: this.pageSize(tab), loading: wc.isLoading() }; }
      // Explicit observations can also inspect a partially loaded page.
      let observation: Record<string, unknown>;
      if (params.vision === true) {
        // Loading may finish before Chromium submits its first display surface.
        const capture = async () => {
          const deadline = Date.now() + 2000;
          while (true) {
            check();
            try {
              const image = await wc.capturePage();
              if (!image.isEmpty()) return tab.record.viewport ? image.resize(this.pageSize(tab)) : image;
              throw new Error("UnknownVizError: Chromium has not rendered the page yet");
            }
            catch (error) {
              if (!String(error).includes("UnknownVizError") || Date.now() >= deadline) throw error;
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          }
        };
        const image = await this.untilDialog(tab, capture());
        if (!image) { check(); return { tab: this.metadata(tab), dialog: tab.record.dialog }; }
        observation = { image: image.toPNG().toString("base64") };
      } else {
        observation = { page: await wc.executeJavaScript(pageDescription) };
      }
      check(); return { tab: this.metadata(tab), viewport: this.pageSize(tab), ...observation };
    });
    tab.queue = work; return work;
  }
  private pageSize(tab: Tab): { width: number; height: number } {
    return tab.record.viewport || { width: this.bounds.width, height: this.bounds.height };
  }
  private presentationScale(tab: Tab): number {
    const size = this.pageSize(tab);
    return Math.min(1, this.bounds.width / size.width, this.bounds.height / size.height);
  }
  private async applyViewport(tab: Tab): Promise<void> {
    if (!tab.started) return;
    const displayed = this.visible && this.viewportReady && tab.record.id === this.activeTabId && tab.record.conversationId === this.conversationId;
    if (displayed && !tab.record.viewport) {
      await tab.view.webContents.debugger.sendCommand("Emulation.clearDeviceMetricsOverride"); return;
    }
    const size = this.pageSize(tab);
    // Scale only the presentation to fit the native panel. CSS layout and model
    // coordinates remain in the chosen viewport; no screenshot/input proxy.
    await tab.view.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      ...size, deviceScaleFactor: 1, mobile: false,
      scale: displayed ? this.presentationScale(tab) : 1,
    });
  }
  private async wait(tab: Tab, params: Record<string, unknown>, check: () => void): Promise<Record<string, unknown>> {
    const timeout = params.timeoutMs ?? 10000, until = params.waitUntil ?? "load";
    if (!Number.isInteger(timeout) || Number(timeout) < 0 || Number(timeout) > 30000) throw new Error("Ожидание: 0–30000 мс.");
    if (!["load", "domcontentloaded", "networkidle"].includes(String(until))) throw new Error("Неизвестное условие ожидания.");
    for (const field of ["selector", "waitForText"]) if (params[field] !== undefined && (typeof params[field] !== "string" || !String(params[field]).trim() || String(params[field]).length > 1000)) throw new Error("Условие ожидания должно содержать 1–1000 символов.");
    const wc = tab.view.webContents, started = Date.now(), deadline = started + Number(timeout);
    let settled = 0;
    // Fixed, read-only predicate: neither arbitrary model JS nor input values.
    const expression = `(() => {
      const ready = document.readyState;
      const selector = ${JSON.stringify(params.selector ?? null)};
      const text = ${JSON.stringify(params.waitForText ?? null)};
      const visible = el => { const r=el.getBoundingClientRect(), s=getComputedStyle(el); return r.width>0 && r.height>0 && s.visibility!=='hidden' && s.display!=='none'; };
      let found=true;
      if(selector) found=[...document.querySelectorAll(selector)].some(visible);
      if(text) found=found && (${pageDescription}).text.includes(text);
      return {ready,found};
    })()`;
    while (true) {
      check();
      if (tab.record.dialog) return { tab: this.metadata(tab), ready: false, timedOut: false, blocked: "dialog", dialog: tab.record.dialog };
      const remaining = Math.max(1, deadline - Date.now());
      let probe: { ready?: string; found?: boolean } = {};
      try {
        // Runtime timeout is enforced inside Chromium even during navigation.
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            wc.debugger.sendCommand("Runtime.evaluate", { expression, returnByValue: true, timeout: Math.min(500, remaining) }),
            new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), Math.min(500, remaining)); }),
          ]);
          if (result?.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "Неверное условие ожидания.");
          probe = result?.result?.value || {};
        } finally { clearTimeout(timer); }
      } catch (error) {
        check();
        if (String(error).includes("SyntaxError")) throw error;
        if (!wc.isLoading() && Date.now() < deadline && !/context|navigat|timed out/i.test(String(error))) throw error;
      }
      check();
      const loaded = until === "domcontentloaded" ? probe.ready === "interactive" || probe.ready === "complete" : probe.ready === "complete" && !wc.isLoading();
      const idle = until !== "networkidle" || (tab.requests.size === 0 && Date.now() - tab.activity >= 500);
      if (loaded && idle && probe.found) {
        if (!settled) settled = Date.now();
        // Allow an action's deferred navigation to start before declaring load.
        if (Number(timeout) === 0 || Date.now() - settled >= 200) return { tab: this.metadata(tab), ready: true, timedOut: false, waitUntil: until, elapsedMs: Date.now() - started };
      } else settled = 0;
      if (Date.now() >= deadline) return { tab: this.metadata(tab), ready: false, timedOut: true, waitUntil: until, elapsedMs: Date.now() - started, loading: wc.isLoading() };
      await new Promise(resolve => setTimeout(resolve, Math.min(50, deadline - Date.now())));
    }
  }
  // A JS dialog can suspend an Input command or capture. Return control to the
  // caller so it can answer the dialog, rather than deadlocking the tab queue.
  private async untilDialog<T>(tab: Tab, operation: Promise<T>, timeout = 10000): Promise<T | undefined> {
    if (tab.record.dialog) { void operation.catch(() => undefined); return undefined; }
    const debuggerApi = tab.view.webContents.debugger;
    let opened: (_event: unknown, method: string) => void;
    let timer: ReturnType<typeof setTimeout>;
    const interrupted = new Promise<undefined>((resolve, reject) => {
      opened = (_event, method) => { if (method === "Page.javascriptDialogOpening") resolve(undefined); };
      debuggerApi.on("message", opened);
      timer = setTimeout(() => reject(new Error("Браузер не ответил за отведённое время. Повторите state или передайте управление пользователю.")), timeout);
    });
    try { return await Promise.race([operation, interrupted]); }
    finally { clearTimeout(timer!); debuggerApi.off("message", opened!); }
  }
  private zoom(tab: Tab, value: unknown): void {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0.25 || value > 3) throw new Error("Масштаб должен быть от 0.25 до 3.");
    tab.view.webContents.setZoomFactor(value); tab.record.zoom = value; this.publish();
  }
  private async answerDialog(tab: Tab, accept: unknown, promptText: unknown): Promise<void> {
    if (!tab.record.dialog || typeof accept !== "boolean" || (promptText !== undefined && (typeof promptText !== "string" || promptText.length > 10000))) throw new Error("Нужен открытый диалог и accept=true/false.");
    await tab.view.webContents.debugger.sendCommand("Page.handleJavaScriptDialog", { accept, ...(typeof promptText === "string" ? { promptText } : {}) });
    tab.record.dialog = undefined; this.publish();
  }
  private async upload(tab: Tab, files: unknown): Promise<void> {
    if (!tab.fileNode || !Array.isArray(files) || files.length > 20 || files.some(file => typeof file !== "string" || !path.isAbsolute(file) || !statSync(file).isFile())) throw new Error("Сначала откройте выбор файла на странице; нужны абсолютные пути к файлам (до 20).");
    if (!tab.record.fileChooser?.multiple && files.length > 1) throw new Error("Это поле принимает только один файл.");
    await tab.view.webContents.debugger.sendCommand("DOM.setFileInputFiles", { files, backendNodeId: tab.fileNode });
    tab.fileNode = undefined; tab.record.fileChooser = undefined; this.publish();
  }
  private cancelTab(tab: Tab, keepManual = false): void { tab.epoch++; tab.automation?.disconnect(); tab.automation = undefined; tab.siteTools?.cancel(keepManual); }
  cancel(owner: string): void { for (const tab of this.tabs.values()) if (tab.record.conversationId === owner) this.cancelTab(tab); }
  closeConversation(owner: string): void { for (const tab of [...this.tabs.values()]) if (tab.record.conversationId === owner) this.close(tab); }
  async dispose(): Promise<void> {
    this.browserSession.flushStorageData();
    await this.browserSession.cookies.flushStore();
    for (const tab of [...this.tabs.values()]) this.close(tab);
  }
}
