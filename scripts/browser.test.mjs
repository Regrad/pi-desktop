import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes, registerHooks } from "node:module";
import { EventEmitter } from "node:events";
import path from "node:path";

const source = readFileSync(new URL("../electron/browser-manager.ts", import.meta.url), "utf8");
const code = stripTypeScriptTypes(source).replace(/^import .*;\s*$/gm, "").replace(/^export /gm, "");
function fixture() {
  let id = 0, captures = 0, descriptions = 0;
  const commands = [], views = [];
  class View {
    constructor(options) {
      this.options = options; views.push(this);
      this.webContents = Object.assign(new EventEmitter(), {
        debugger: Object.assign(new EventEmitter(), { isAttached: () => true, attach() {}, async sendCommand(...args) { commands.push(args); if (args[0] === "Runtime.evaluate") return { result: { value: { ready: "complete", found: true } } }; if (args[0] === "Page.captureScreenshot") return { data: Buffer.from("viewport image").toString("base64") }; } }),
        isDestroyed: () => false, getTitle: () => "Page", getURL: () => "https://example.com/", isLoading: () => false,
        setWindowOpenHandler(handler) { this.popup = handler; }, async loadURL(url) { this.url = url; this.emit("paint", {}, {}, { toPNG: () => Buffer.from("frame") }); },
        async capturePage() { captures++; const image = { isEmpty: () => false, toPNG: () => Buffer.from("screenshot"), resize: () => image }; return image; },
        async executeJavaScript(script) { descriptions++; assert.doesNotMatch(script, /\.value\b|cookie|localStorage/); return { text: "Page", controls: [] }; },
        navigationHistory: { canGoBack: () => false, canGoForward: () => false }, close() { this.closed = true; }, reload() {}, stop() {}, setBackgroundThrottling() {}, setFrameRate() {}, setZoomFactor(value) { this.zoom = value; },
      });
    }
    setBounds(bounds) { this.bounds = bounds; }
    setVisible(visible) { this.visible = visible; }
    setContentSize(width, height) { this.size = [width, height]; }
    destroy() { this.destroyed = true; }
  }
  const sessionEvents = new EventEmitter();
  const session = { fromPath(directory) { this.directory = directory; return Object.assign(sessionEvents, { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, flushStorageData() {}, cookies: { async flushStore() {} } }); } };
  const { BrowserManager, browserUrl } = new Function("BrowserWindow", "WebContentsView", "session", "dialog", "shell", "path", "randomUUID", "mkdirSync", "statSync", "webMcpBootstrap", `${code};return {BrowserManager,browserUrl};`)(View, View, session, { async showOpenDialog() { return { canceled: true, filePaths: [] }; } }, { showItemInFolder() {} }, path, () => `tab-${++id}`, () => {}, () => ({ isFile: () => true }), "/* site tools bootstrap */");
  const children = [], win = { isDestroyed: () => false, getContentSize: () => [1400, 1000], contentView: { children,
    addChildView(view) { children.push(view); }, removeChildView(view) { const i = children.indexOf(view); if (i >= 0) children.splice(i, 1); } } };
  const manager = new BrowserManager("C:/test-data", () => win, () => {});
  return { manager, browserUrl, views, commands, session, sessionEvents, win, counts: () => ({ captures, descriptions }) };
}
test("image models get screenshots only; text models get descriptions only, with no raw form values", async () => {
  const f = fixture(), tab = (await f.manager.request("chat", { action: "open", url: "https://example.com" })).tab;
  const visual = await f.manager.request("chat", { action: "state", tabId: tab.id, vision: true });
  assert.ok(visual.image); assert.equal(visual.page, undefined); assert.deepEqual(f.counts(), { captures: 1, descriptions: 0 });
  const textual = await f.manager.request("chat", { action: "state", tabId: tab.id, vision: false });
  assert.ok(textual.page); assert.equal(textual.image, undefined); assert.deepEqual(f.counts(), { captures: 1, descriptions: 1 });
  assert.equal(f.views[0].options.webPreferences.sandbox, true);
  assert.equal(f.views[0].options.webPreferences.nodeIntegration, false);
  assert.match(f.session.directory, /browser$/);
});
test("native views share a live page, follow bounds, visibility and chat selection", async () => {
  const f = fixture(); await f.manager.ui({ action: "select-chat", conversationId: "one" });
  const tab = (await f.manager.request("one", { action: "open", url: "https://example.com" })).tab;
  await f.manager.ui({ action: "show" });
  assert.ok(f.views[0].bounds.x + f.views[0].bounds.width < 0, "No overlay before renderer reports its viewport");
  await f.manager.ui({ action: "bounds", bounds: { x: 200, y: 100, width: 600, height: 500 } });
  assert.equal(f.views[0].visible, true); assert.deepEqual(f.views[0].bounds, { x: 200, y: 100, width: 600, height: 500 });
  assert.equal(f.win.contentView.children[0], f.views[0]);
  assert.equal(f.manager.state().frame, undefined);
  await f.manager.request("one", { action: "type", tabId: tab.id, text: "Shared input", vision: true });
  await f.manager.ui({ action: "hide" }); assert.ok(f.views[0].bounds.x + f.views[0].bounds.width < 0);
  assert.ok((await f.manager.request("one", { action: "state", tabId: tab.id, vision: true })).image);
  await f.manager.ui({ action: "select-chat", conversationId: "two" }); await f.manager.ui({ action: "show" });
  assert.ok(f.views[0].bounds.x + f.views[0].bounds.width < 0);
  await f.manager.ui({ action: "close", tabId: tab.id });
  assert.equal(f.win.contentView.children.length, 0); assert.equal(f.views[0].webContents.closed, true);
});
test("chat isolation, safe URLs and hidden input without the system cursor", async () => {
  const f = fixture();
  for (const url of ["file:///C:/secret", "javascript:alert(1)", "https://user:pass@example.com", "pi-generated://file"]) assert.throws(() => f.browserUrl(url));
  const tab = (await f.manager.request("one", { action: "open", url: "https://example.com" })).tab;
  assert.deepEqual((await f.manager.request("two", { action: "list" })).tabs, []);
  await assert.rejects(f.manager.request("two", { action: "state", tabId: tab.id }), /Вкладка/);
  await f.manager.request("one", { action: "click", tabId: tab.id, x: 5, y: 5, vision: true });
  assert.ok(f.views[0].bounds.x + f.views[0].bounds.width < 0); assert.equal(f.views[0].options.webPreferences.offscreen, undefined);
  assert.deepEqual(f.commands.filter(item => item[0].startsWith("Input.")).map(item => item[0]), ["Input.dispatchMouseEvent", "Input.dispatchMouseEvent"]);
  await assert.rejects(f.manager.request("one", { action: "click", tabId: tab.id, x: Infinity, y: 5 }), /Координаты/);
  let prevented = false;
  f.views[0].webContents.emit("will-navigate", { preventDefault() { prevented = true; } }, "file:///C:/secret");
  assert.equal(prevented, true);
  assert.deepEqual(f.views[0].webContents.popup({ url: "file:///C:/secret" }), { action: "deny" });
  assert.equal(f.views.length, 1);
});
test("Stop cancels in-flight and queued model actions; obsolete input forwarding is rejected", async () => {
  const f = fixture(), tab = (await f.manager.request("chat", { action: "open", url: "https://example.com" })).tab;
  await assert.rejects(f.manager.ui({ action: "input", tabId: tab.id, input: { type: "text", text: "private" } }), /Неизвестное/);
  let release;
  f.views[0].webContents.capturePage = () => new Promise(resolve => { release = resolve; });
  const first = f.manager.request("chat", { action: "state", tabId: tab.id, vision: true });
  const second = f.manager.request("chat", { action: "click", tabId: tab.id, vision: true, x: 1, y: 1 });
  await new Promise(resolve => setImmediate(resolve)); f.manager.cancel("chat");
  release({ isEmpty: () => false, toPNG: () => Buffer.from("frame") });
  await assert.rejects(first, /отменено/); await assert.rejects(second, /отменено/);
  assert.equal(f.commands.filter(item => item[0] === "Input.dispatchMouseEvent").length, 0);
});
test("hover, bounded dragging, replacing text and closing only deleted chat tabs", async () => {
  const f = fixture(), tab = (await f.manager.request("one", { action: "open", url: "https://example.com" })).tab;
  await f.manager.request("one", { action: "move", tabId: tab.id, x: 4, y: 5, vision: true });
  assert.equal(f.commands.at(-1)[1].type, "mouseMoved");
  await f.manager.request("one", { action: "drag", tabId: tab.id, x: 4, y: 5, endX: 40, endY: 50, vision: true });
  assert.deepEqual(f.commands.at(-1)[1], { type: "mouseReleased", x: 40, y: 50, button: "left", clickCount: 1, modifiers: 0 });
  await assert.rejects(f.manager.request("one", { action: "drag", tabId: tab.id, x: 4, y: 5, endX: -1, endY: 50 }), /конечная точка/);
  await f.manager.request("one", { action: "type", tabId: tab.id, text: "replacement", replace: true, vision: true });
  assert.equal(f.commands.at(-1)[0], "Input.insertText");
  assert.ok(f.commands.some(item => item[0] === "Input.dispatchKeyEvent" && item[1].modifiers === 2));
  await assert.rejects(f.manager.request("one", { action: "key", tabId: tab.id, key: "toString" }), /Поддерживаются/);
  await f.manager.request("two", { action: "open", url: "https://example.com" });
  f.manager.closeConversation("one"); assert.equal(f.views[0].webContents.closed, true); assert.equal(f.views[1].webContents.closed, undefined);
  assert.equal((await f.manager.request("two", { action: "list" })).tabs.length, 1);
  await f.manager.dispose(); assert.equal(f.views[1].webContents.closed, true);
});
test("extension selects vision from the actual current model on every call", async () => {
  const hooks = registerHooks({ resolve(specifier, context, next) { return next(["./goal-extension.js", "./state-context.js", "../shared/goal.js", "../shared/browser.js"].includes(specifier) ? specifier.replace(/\.js$/, ".ts") : specifier, context); } });
  const { default: extension } = await import("../electron/browser-extension.ts"); hooks.deregister();
  let tool; const modes = [];
  extension({ registerTool(value) { tool = value; } }, async (_action, params) => { modes.push(params.vision); return params.vision ? { image: "png", tab: { id: "t" } } : { page: { text: "text" } }; });
  const image = await tool.execute("id", { action: "state" }, undefined, undefined, { model: { input: ["text", "image"] } });
  assert.equal(image.content[1].type, "image"); assert.doesNotMatch(image.content[0].text, /page|png/);
  const text = await tool.execute("id", { action: "state" }, undefined, undefined, { model: { input: ["text"] } });
  assert.equal(text.content.length, 1); assert.deepEqual(modes, [true, false]);
});
test("site tool execution requires actual user confirmation, not model-supplied approval", async () => {
  const hooks = registerHooks({ resolve(specifier, context, next) { return next(["./goal-extension.js", "./state-context.js", "../shared/goal.js", "../shared/browser.js"].includes(specifier) ? specifier.replace(/\.js$/, ".ts") : specifier, context); } });
  const { default: extension } = await import("../electron/browser-extension.ts"); hooks.deregister();
  let tool, allow = false; const calls = [], confirmations = [];
  extension({ registerTool(value) { tool = value; } }, async (_action, params) => {
    calls.push(params);
    return params.action === "webmcp-list" ? { tab: { url: "https://example.com" }, tools: [{ id: "registered", name: "test", description: "Site description" }] } : { result: "done" };
  });
  const ctx = { model: { input: ["text"] }, ui: { async confirm(title, description) { confirmations.push({title,description}); return allow; } } };
  const params = { action: "webmcp-call", tabId: "t", toolId: "registered", arguments: { text: "hello" }, approved: true };
  assert.match((await tool.execute("id", params, undefined, undefined, ctx)).content[0].text, /отменён/);
  assert.equal(calls.filter(p => p.action === "webmcp-call").length, 0);
  allow = true;
  await tool.execute("id", params, undefined, undefined, ctx);
  assert.equal(calls.at(-1).approved, true); assert.match(confirmations[1].description, /https:\/\/example.com/);
  assert.match(tool.description, /auto-waits/); assert.match(tool.description, /never field values/);
  const controller = new AbortController(); controller.abort();
  const before = calls.filter(p => p.action === "webmcp-call").length;
  await tool.execute("id", params, controller.signal, undefined, ctx);
  assert.equal(calls.filter(p => p.action === "webmcp-call").length, before);
});

test("browser is wired through the real chat controller and desktop-only preload, without a new network endpoint", async () => {
  const manager = readFileSync(new URL("../electron/pi-manager.ts", import.meta.url), "utf8");
  const start = manager.indexOf("  private async handleGoalRequest(");
  const begin = manager.indexOf("): Promise<unknown> {", start) + "): Promise<unknown> {".length;
  const end = manager.indexOf("\n  }", begin);
  const body = stripTypeScriptTypes(`async function handle(conversationId, request) {${manager.slice(begin, end)}\n}`);
  const handle = new Function(`${body};return handle;`)();
  const calls = [];
  const host = { store: { getConversation(id) { assert.equal(id, "owner"); } }, async browserRequest(id, params) { calls.push({ id, params }); return { ok: true }; } };
  assert.deepEqual(await handle.call(host, "owner", { action: "browser", params: { action: "list", conversationId: "spoofed" } }), { ok: true });
  assert.equal(calls[0].id, "owner");
  await assert.rejects(handle.call(host, "owner", { action: "browser" }), /параметры/);
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  assert.match(main, /event.sender !== mainWindow\?\.webContents/);
  assert.match(main, /browserManager\.request\(id, params\)/);
  assert.match(manager, /browserExtensionPath: !remote && this.browserRequest/);
  const rpc = readFileSync(new URL("../electron/pi-rpc-process.ts", import.meta.url), "utf8");
  assert.match(rpc, /args.push\("--extension", this.options.browserExtensionPath\)/);
  const panel = readFileSync(new URL("../src/BrowserPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /!window.piDesktop.webClient/);
  assert.doesNotMatch(panel, /onKeyDown=|onPointerDown=|Управляю я|state.frame/); assert.match(panel, /ResizeObserver/);
});

test("handoff shows the existing live tab without an exclusive control mode", async () => {
  const f = fixture(); await f.manager.ui({ action: "select-chat", conversationId: "chat" });
  const tab = (await f.manager.request("chat", { action: "open", url: "https://example.com" })).tab;
  await f.manager.ui({ action: "bounds", bounds: { x: 20, y: 80, width: 600, height: 500 } });
  const handed = await f.manager.request("chat", { action: "handoff", tabId: tab.id });
  assert.equal(handed.visible, true); assert.equal(handed.tab.manual, undefined);
  assert.equal(f.manager.state().activeTabId, tab.id); assert.equal(f.views.length, 1); assert.equal(f.views[0].visible, true);
  assert.ok((await f.manager.request("chat", { action: "state", tabId: tab.id, vision: true })).image);
});

test("handoff preserves manual form review while Stop cancels it", async () => {
  const f = fixture(), tab = (await f.manager.request("chat", { action: "open", url: "https://example.com" })).tab;
  const calls = []; let disconnected = 0;
  const internal = f.manager.tabs.get(tab.id);
  internal.siteTools = { cancel(keepManual) { calls.push(keepManual); } };
  internal.automation = { disconnect() { disconnected++; } };
  await f.manager.request("chat", { action: "handoff", tabId: tab.id });
  assert.deepEqual(calls, [true]); assert.equal(disconnected, 1);
  f.manager.cancel("chat"); assert.deepEqual(calls, [true, false]);
});

test("all mouse buttons, double clicks, key chords and bounded zoom", async () => {
  const f = fixture(), tab = (await f.manager.request("chat", { action: "open", url: "https://example.com" })).tab;
  await f.manager.request("chat", { action: "click", tabId: tab.id, x: 3, y: 4, button: "middle", clickCount: 2, modifiers: 8, vision: true });
  const mouse = f.commands.filter(item => item[0] === "Input.dispatchMouseEvent");
  assert.equal(mouse.length, 4); assert.equal(mouse.at(-1)[1].clickCount, 2); assert.equal(mouse.at(-1)[1].button, "middle");
  await f.manager.request("chat", { action: "key", tabId: tab.id, key: "a", modifiers: 2, vision: true });
  assert.equal(f.commands.at(-1)[1].windowsVirtualKeyCode, 65);
  await assert.rejects(f.manager.request("chat", { action: "key", tabId: tab.id, key: "v", modifiers: 2 }), /буфера/);
  await assert.rejects(f.manager.request("chat", { action: "click", tabId: tab.id, x: 1, y: 1, modifiers: 16 }), /модификаторы/);
  await f.manager.request("chat", { action: "zoom", tabId: tab.id, zoom: 1.5, vision: true }); assert.equal(f.views[0].webContents.zoom, 1.5);
  await assert.rejects(f.manager.request("chat", { action: "zoom", tabId: tab.id, zoom: 10 }), /Масштаб/);
});

test("dialog and upload are explicit, typed operations rather than arbitrary page JavaScript", async () => {
  const f = fixture(), tab = (await f.manager.request("chat", { action: "open", url: "https://example.com" })).tab;
  const debuggerApi = f.views[0].webContents.debugger;
  debuggerApi.emit("message", {}, "Page.javascriptDialogOpening", { type: "prompt", message: "Name?" });
  const blocked = await f.manager.request("chat", { action: "state", tabId: tab.id, vision: true });
  assert.equal(blocked.dialog.message, "Name?"); assert.equal(blocked.image, undefined);
  await f.manager.request("chat", { action: "dialog", tabId: tab.id, accept: true, promptText: "test", vision: true });
  assert.ok(f.commands.some(([name, args]) => name === "Page.handleJavaScriptDialog" && args.promptText === "test"));
  await assert.rejects(f.manager.request("chat", { action: "upload", tabId: tab.id, files: ["/authorized.txt"] }), /Сначала/);
  debuggerApi.emit("message", {}, "Page.fileChooserOpened", { backendNodeId: 42, mode: "selectMultiple" });
  await assert.rejects(f.manager.request("chat", { action: "upload", tabId: tab.id, files: ["relative.txt"] }), /абсолютные/);
  await f.manager.request("chat", { action: "upload", tabId: tab.id, files: [path.resolve("authorized.txt")], vision: true });
  assert.ok(f.commands.some(([name, args]) => name === "DOM.setFileInputFiles" && args.backendNodeId === 42));
  assert.equal(f.manager.state().tabs[0].fileChooser, undefined);
});

test("downloads are attributed to a chat, report progress and never auto-launch files", async () => {
  const f = fixture(), tab = (await f.manager.request("one", { action: "open", url: "https://example.com" })).tab;
  const item = Object.assign(new EventEmitter(), { getFilename: () => "../test.exe", getTotalBytes: () => 1024, getReceivedBytes: () => 512, setSavePath(value) { this.path = value; } });
  f.sessionEvents.emit("will-download", {}, item, f.views[0].webContents);
  item.emit("updated", {}, "progressing");
  const downloads = (await f.manager.request("one", { action: "downloads" })).downloads;
  assert.equal(downloads.length, 1); assert.equal(downloads[0].tabId, tab.id); assert.equal(downloads[0].receivedBytes, 512);
  assert.deepEqual((await f.manager.request("two", { action: "downloads" })).downloads, []);
  item.emit("done", {}, "completed"); assert.equal((await f.manager.request("one", { action: "downloads" })).downloads[0].state, "completed");
  let blocked = false; f.sessionEvents.emit("will-download", { preventDefault() { blocked = true; } }, item, {}); assert.equal(blocked, true);
});

test("model punctuation does not alias editing keys", async () => {
  const f = fixture(), tab = (await f.manager.request("chat", { action: "open", url: "https://example.com" })).tab;
  for (const [key, vk] of [[".",190],[",",188],["/",191],["ж",0]]) {
    await f.manager.request("chat", { action: "key", tabId: tab.id, key, vision: true });
    const events = f.commands.filter(([name]) => name === "Input.dispatchKeyEvent").slice(-2);
    assert.equal(events[0][1].windowsVirtualKeyCode, vk); assert.equal(events[0][1].text, key);
  }
});

test("a first screenshot waits for the initial Chromium surface instead of returning an empty image", async () => {
  const f = fixture(), tab = (await f.manager.request("chat", { action: "open", url: "https://example.com" })).tab;
  let attempts = 0;
  f.views[0].webContents.capturePage = async () => ({ isEmpty: () => ++attempts === 1, toPNG: () => Buffer.from("ready") });
  assert.equal((await f.manager.request("chat", { action: "state", tabId: tab.id, vision: true })).image, Buffer.from("ready").toString("base64"));
  assert.equal(attempts, 2);
});

test("actions and waits never send automatic observations", async () => {
  const f = fixture(), tab = (await f.manager.request("chat", { action: "open", url: "https://example.com" })).tab;
  for (const action of ["click", "type", "key", "navigate", "reload", "wait"]) {
    const result = await f.manager.request("chat", { action, tabId: tab.id, x: 1, y: 1, text: "text", key: ".", url: "https://example.com", timeoutMs: 1000, vision: true });
    assert.equal(result.image, undefined); assert.equal(result.page, undefined);
    if (action === "wait") { assert.equal(result.ready, true); assert.equal(result.timedOut, false); }
  }
  assert.deepEqual(f.counts(), { captures: 0, descriptions: 0 });
  assert.ok((await f.manager.request("chat", { action: "screenshot", tabId: tab.id, vision: true })).image);
});

test("wait checks asynchronous conditions, reports timeout and validates inputs", async () => {
  const f = fixture(), tab = (await f.manager.request("chat", { action: "open", url: "https://example.com" })).tab;
  f.views[0].webContents.debugger.sendCommand = async (name, args) => {
    if (name === "Runtime.evaluate") {
      assert.match(args.expression, /querySelectorAll/); assert.doesNotMatch(args.expression, /\.value\b|cookie|localStorage/);
      return { result: { value: { ready: "complete", found: false } } };
    }
  };
  const result = await f.manager.request("chat", { action: "wait", tabId: tab.id, selector: "#later", timeoutMs: 30 });
  assert.equal(result.timedOut, true); assert.equal(result.ready, false);
  for (const params of [{timeoutMs: -1}, {timeoutMs: 30001}, {waitUntil: "unknown"}, {selector: ""}]) await assert.rejects(f.manager.request("chat", {action: "wait", tabId: tab.id, ...params}));
});

test("wait does not hang on a paused renderer and Stop cancels it", async () => {
  const f = fixture(), tab = (await f.manager.request("chat", { action: "open", url: "https://example.com" })).tab;
  f.views[0].webContents.debugger.sendCommand = async name => name === "Runtime.evaluate" ? new Promise(() => {}) : undefined;
  assert.equal((await f.manager.request("chat", { action: "wait", tabId: tab.id, timeoutMs: 30 })).timedOut, true);
  const work = f.manager.request("chat", { action: "wait", tabId: tab.id, timeoutMs: 1000 });
  await new Promise(resolve => setImmediate(resolve)); f.manager.cancel("chat");
  await assert.rejects(work, /отменено/);
});

test("viewport is per tab, fits the panel, maps model mouse coordinates and resets", async () => {
  const f = fixture(); await f.manager.ui({ action: "select-chat", conversationId: "chat" });
  const tab = (await f.manager.request("chat", { action: "open", url: "https://example.com" })).tab;
  await f.manager.ui({ action: "bounds", bounds: { x: 20, y: 80, width: 600, height: 500 } });
  await f.manager.request("chat", { action: "viewport", tabId: tab.id, width: 1200, height: 1000 });
  assert.deepEqual(f.views[0].bounds, { x: -1201, y: -1001, width: 1200, height: 1000 });
  await f.manager.request("chat", { action: "show", tabId: tab.id });
  assert.deepEqual(f.views[0].bounds, { x: 20, y: 80, width: 600, height: 500 });
  await f.manager.request("chat", { action: "click", tabId: tab.id, x: 1100, y: 900 });
  const mouse = f.commands.filter(([name]) => name === "Input.dispatchMouseEvent").at(-1)[1];
  assert.equal(mouse.x, 550); assert.equal(mouse.y, 450);
  assert.deepEqual((await f.manager.request("chat", { action: "screenshot", tabId: tab.id, vision: true })).viewport, { width: 1200, height: 1000 });
  await assert.rejects(f.manager.request("chat", { action: "viewport", tabId: tab.id, width: 1, height: 1000 }), /Размер/);
  await f.manager.ui({ action: "viewport-reset", tabId: tab.id });
  assert.equal(f.manager.state().tabs[0].viewport, undefined);
  assert.equal(f.commands.at(-1)[0], "Emulation.setFocusEmulationEnabled");
  await assert.rejects(f.manager.request("chat", { action: "click", tabId: tab.id, x: 1100, y: 900 }), /Координаты/);
});

test("DOMContentLoaded and network idle have distinct readiness conditions", async () => {
  const f = fixture(), tab = (await f.manager.request("chat", { action: "open", url: "https://example.com" })).tab;
  const wc = f.views[0].webContents, original = wc.debugger.sendCommand;
  wc.isLoading = () => true;
  wc.debugger.sendCommand = async (name, args) => name === "Runtime.evaluate" ? { result: { value: { ready: "interactive", found: true } } } : original(name, args);
  assert.equal((await f.manager.request("chat", { action: "wait", tabId: tab.id, waitUntil: "domcontentloaded", timeoutMs: 1000 })).ready, true);
  assert.ok((await f.manager.request("chat", { action: "screenshot", tabId: tab.id, vision: true })).image);
  assert.equal((await f.manager.request("chat", { action: "wait", tabId: tab.id, waitUntil: "load", timeoutMs: 10 })).timedOut, true);
  wc.isLoading = () => false; wc.debugger.sendCommand = original;
  wc.debugger.emit("message", {}, "Network.requestWillBeSent", { requestId: "pending" });
  assert.equal((await f.manager.request("chat", { action: "wait", tabId: tab.id, waitUntil: "networkidle", timeoutMs: 10 })).timedOut, true);
  wc.debugger.emit("message", {}, "Network.loadingFinished", { requestId: "pending" });
  assert.equal((await f.manager.request("chat", { action: "wait", tabId: tab.id, waitUntil: "networkidle", timeoutMs: 1500 })).ready, true);
});
