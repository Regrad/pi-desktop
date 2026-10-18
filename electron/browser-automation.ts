import type { Browser, Page, Locator, FrameLocator, ConnectOverCDPTransport } from "playwright-core";

export interface BrowserLocator {
  selector?: string; role?: string; name?: string; text?: string; label?: string; placeholder?: string; testId?: string;
  exact?: boolean; nth?: number; frames?: string[];
}

// Playwright's public in-process CDP transport. No debugging TCP port, second
// browser, Node inspector, or access to the application's renderer is exposed.
export class BrowserAutomation {
  private browser?: Browser;
  private connection?: Promise<Page>;
  private transport?: ConnectOverCDPTransport;
  private removeListener?: () => void;
  private generation = 0;
  private wc: Electron.WebContents;
  private scale: () => number;
  constructor(wc: Electron.WebContents, scale: () => number) { this.wc = wc; this.scale = scale; }
  async page(): Promise<Page> {
    if (this.connection) return this.connection;
    const generation = this.generation;
    this.connection = this.connect().catch(error => {
      if (generation === this.generation) this.disconnect();
      throw error;
    });
    return this.connection;
  }
  private async connect(): Promise<Page> {
    const generation = this.generation;
    const api = this.wc.debugger;
    const { targetInfo } = await api.sendCommand("Target.getTargetInfo");
    if (generation !== this.generation) throw new Error("Подключение браузера отменено.");
    const info = { ...targetInfo, type: "page", browserContextId: "pi-browser-context" };
    const main = "pi-native-page";
    let closed = false, attached = false;
    const emit = (message: object) => queueMicrotask(() => { if (!closed) transport.onmessage?.(message); });
    const transport: ConnectOverCDPTransport = {
      send: (message: object) => {
        const m = message as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
        const reply = (result: unknown, error?: unknown) => emit({ id: m.id, sessionId: m.sessionId, ...(error ? { error: { code: -32000, message: String(error) } } : { result }) });
        void (async () => {
          if (closed) return;
          if (!m.sessionId && m.method === "Target.setAutoAttach") {
            reply({});
            if (!attached) { attached = true; emit({ method: "Target.attachedToTarget", params: { sessionId: main, targetInfo: info, waitingForDebugger: false } }); }
            return;
          }
          if (!m.sessionId && m.method === "Target.getTargetInfo") { reply({ targetInfo: info }); return; }
          if (!m.sessionId && m.method === "Target.getTargets") { reply({ targetInfos: [info] }); return; }
          if (!m.sessionId && m.method === "Target.attachToTarget") {
            if (m.params?.targetId !== info.targetId) throw new Error("Доступ только к этой вкладке.");
            reply({ sessionId: main }); return;
          }
          if (!m.sessionId && m.method.startsWith("Target.")) throw new Error("Создание сторонних целей через браузер запрещено.");
          if (m.method === "Browser.setDownloadBehavior") { reply({}); return; }
          if (m.method === "Browser.close") { reply({}); transport.close(); return; }
          let params = m.params || {};
          // Electron owns renderer startup; pausing an OOPIF before its first
          // commit leaves it at about:blank. Runtime.enable replays its contexts.
          if (m.method === "Target.setAutoAttach") params = { ...params, waitForDebuggerOnStart: false };
          if (m.method === "Page.captureScreenshot") params = { ...params, fromSurface: false };
          if (m.method === "Input.dispatchMouseEvent") {
            const scale = this.scale();
            params = { ...params, x: Number(params.x) * scale, y: Number(params.y) * scale };
          }
          if (m.method === "Input.dispatchKeyEvent" && (Number(params.modifiers) & 6) && (String(params.key).toLowerCase() === "v" || params.windowsVirtualKeyCode === 86)) throw new Error("Вставка из системного буфера запрещена.");
          reply(await api.sendCommand(m.method, params, m.sessionId === main ? undefined : m.sessionId));
        })().catch(error => reply(undefined, error));
      },
      close: () => {
        if (closed) return; closed = true; this.removeListener?.();
        // Release OOPIF sessions so reconnect replays their attachment events.
        // Keep Electron's main debugger and the user's live page attached.
        void api.sendCommand("Target.setAutoAttach", { autoAttach: false, waitForDebuggerOnStart: false, flatten: true }).catch(() => undefined);
        // A second Runtime.enable on the same Electron session does not replay
        // main-world contexts; disable it before a fresh Playwright connection.
        void api.sendCommand("Runtime.disable").catch(() => undefined);
        transport.onclose?.();
      },
    };
    const message = (_event: unknown, method: string, params: object, sessionId?: string) => {
      emit({ method, params, sessionId: sessionId || main });
    };
    api.on("message", message); this.removeListener = () => api.off("message", message); this.transport = transport;
    const { chromium } = await import("playwright-core");
    const browser = await chromium.connectOverCDP(transport, { noDefaults: true, timeout: 10000 });
    if (generation !== this.generation) { transport.close(); throw new Error("Подключение браузера отменено."); }
    this.browser = browser;
    const page = this.browser.contexts()[0]?.pages()[0];
    if (!page) throw new Error("Playwright не подключился к вкладке.");
    return page;
  }
  async locator(target: BrowserLocator): Promise<Locator> {
    if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("Нужен locator.");
    const fields = ["selector", "role", "text", "label", "placeholder", "testId"] as const;
    const specified = fields.filter(field => target[field] !== undefined);
    if (specified.length !== 1 || specified.some(field => typeof target[field] !== "string" || !target[field] || target[field]!.length > 1000)) throw new Error("Укажите одно условие locator: selector, role, text, label, placeholder или testId.");
    if (target.frames && (!Array.isArray(target.frames) || target.frames.length > 8 || target.frames.some(value => typeof value !== "string" || !value || value.length > 1000))) throw new Error("frames: до 8 CSS-селекторов iframe.");
    if (target.nth !== undefined && (!Number.isInteger(target.nth) || target.nth < 0 || target.nth > 10000)) throw new Error("Неверный индекс элемента.");
    let scope: Page | FrameLocator = await this.page();
    for (const frame of target.frames || []) scope = scope.frameLocator(frame);
    const options = { exact: target.exact === true };
    let locator: Locator;
    if (target.selector) locator = scope.locator(target.selector);
    else if (target.role) locator = scope.getByRole(target.role as Parameters<Page["getByRole"]>[0], { ...options, name: target.name });
    else if (target.text) locator = scope.getByText(target.text, options);
    else if (target.label) locator = scope.getByLabel(target.label, options);
    else if (target.placeholder) locator = scope.getByPlaceholder(target.placeholder, options);
    else locator = scope.getByTestId(target.testId!);
    return target.nth === undefined ? locator : locator.nth(target.nth);
  }
  disconnect(): void {
    this.generation++;
    this.transport?.close(); this.transport = undefined; this.removeListener = undefined;
    this.browser = undefined; this.connection = undefined;
  }
}
