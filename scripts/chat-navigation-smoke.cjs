const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtempSync, mkdirSync } = require("node:fs");
const root = process.env.PI_CHAT_UI_ROOT || path.resolve(__dirname, "..");
mkdirSync("C:/AI_Temp", { recursive: true });
const temporary = mkdtempSync("C:/AI_Temp/pi-chat-navigation-");
app.setPath("userData", temporary);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let window;
  try {
    const record = id => ({ id, title: `Chat ${id}`, status: "idle", createdAt: new Date(1).toISOString(), updatedAt: new Date(2).toISOString() });
    const message = text => ({ role: "assistant", content: [{ type: "text", text }], timestamp: 2, stopReason: "stop" });
    const snapshot = (id, text) => ({ conversation: record(id), messages: text ? [message(text)] : [],
      state: { isStreaming: false, isCompacting: false, thinkingLevel: "medium", steeringMessages: [], followUpMessages: [] },
      models: [], thinkingLevels: ["medium"], commands: [], entries: [], compactions: [], queuedPrompts: [],
      extensionState: { extensionPaths: [], activeTools: [], tools: [], commandDiagnostics: [], shortcutDiagnostics: [], errors: [] },
      extensionUi: { statuses: {}, widgets: [], headerLines: [], footerLines: [], pendingDialogs: [] } });
    const old = snapshot("old", "PREVIOUS_SAVED_MESSAGE");
    old.liveMessage = message("PREVIOUS_LIVE_FRAGMENT");
    old.state.isStreaming = true;
    const next = snapshot("new");
    const other = snapshot("other", "OTHER_CHAT_MESSAGE");
    let resolveCreate, rejectCreate, resolveOld;
    let delayOld = false;
    ipcMain.handle("desktop:bootstrap", () => ({ interfaceLanguage: "en", projects: [], conversations: [old.conversation, other.conversation],
      archivedConversations: [], activeConversationId: "old", dataDir: temporary, sessionsDir: temporary }));
    ipcMain.handle("desktop:open-conversation", (_event, id) => id === "old" ? delayOld ? new Promise(resolve => { resolveOld = resolve; }) : old : id === "new" ? next : other);
    ipcMain.handle("desktop:create-conversation", () => new Promise((resolve, reject) => { resolveCreate = resolve; rejectCreate = reject; }));
    ipcMain.handle("desktop:get-model-servers", () => []);
    ipcMain.handle("desktop:project-location-issues", () => []);
    ipcMain.handle("desktop:browser", () => ({ tabs: [] }));
    ipcMain.handle("pi:set-editor-text", () => undefined);
    window = new BrowserWindow({ show: false, width: 1100, height: 820, webPreferences: { offscreen: true, backgroundThrottling: false,
      preload: path.join(root, "dist-electron/electron/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    await window.loadFile(path.join(root, "dist/index.html"));
    const js = code => window.webContents.executeJavaScript(code);
    const wait = condition => js(`new Promise((resolve,reject)=>{const end=Date.now()+6000;function check(){if(${condition})return resolve();if(Date.now()>end)return reject(Error('UI timeout: '+${JSON.stringify(condition)}));setTimeout(check,20)}check()})`);
    const frames = () => js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const content = () => js("document.querySelector('.conversation-scroll').textContent");
    const choose = id => js(`document.querySelector('[data-conversation-id="${id}"] .chat-row').click()`);
    const create = () => js("document.querySelector('.standalone-new-chat').click()");
    const draft = text => js(`(()=>{const e=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const sendLate = () => {
      window.webContents.send("pi:event", { conversationId: "old", event: { type: "message_start", message: message("LATE_OLD_FRAGMENT") } });
      window.webContents.send("pi:event", { conversationId: "old", event: { type: "desktop_history_preview", history: {
        rows: [{ id: "old-history", position: 0, message: message("LATE_OLD_HISTORY") }], total: 1, marks: [] } } });
    };
    await wait("document.querySelector('.conversation-scroll')?.textContent.includes('PREVIOUS_LIVE_FRAGMENT') && document.querySelector('.composer')");
    await draft("OLD_CHAT_DRAFT");
    await create();
    await wait("document.querySelector('.chat-loading')");
    assert.equal(typeof resolveCreate, "function");
    sendLate();
    resolveCreate(next);
    await wait("document.querySelector('[data-conversation-id=\"new\"] .chat-row.selected') && !document.querySelector('.chat-loading')");
    await frames();
    assert.doesNotMatch(await content(), /PREVIOUS_|LATE_OLD_/, "a new chat must not inherit the preceding live reply");
    assert.equal(await js("document.querySelector('.composer textarea').value"), "");
    sendLate(); await frames();
    assert.doesNotMatch(await content(), /PREVIOUS_|LATE_OLD_/);
    window.webContents.send("pi:event", { conversationId: "new", event: { type: "message_start", message: message("NEW_CHAT_LIVE") } });
    await wait("document.querySelector('.conversation-scroll').textContent.includes('NEW_CHAT_LIVE')");
    await choose("old"); await wait("document.querySelector('.conversation-scroll').textContent.includes('PREVIOUS_LIVE_FRAGMENT')");
    assert.equal(await js("document.querySelector('.composer textarea').value"), "OLD_CHAT_DRAFT");
    delayOld = true;
    await choose("old"); await wait("document.querySelector('.chat-loading')");
    assert.equal(typeof resolveOld, "function");
    await choose("other"); await wait("document.querySelector('.conversation-scroll').textContent.includes('OTHER_CHAT_MESSAGE')");
    resolveOld(old); sendLate(); await frames();
    assert.match(await content(), /OTHER_CHAT_MESSAGE/);
    assert.doesNotMatch(await content(), /PREVIOUS_|LATE_OLD_|NEW_CHAT_LIVE/);
    await create(); await wait("document.querySelector('.chat-loading')");
    await choose("other"); await wait("document.querySelector('.conversation-scroll').textContent.includes('OTHER_CHAT_MESSAGE')");
    resolveCreate(next); await frames();
    assert.match(await content(), /OTHER_CHAT_MESSAGE/, "late creation cannot replace a selected chat");
    delayOld = false;
    await choose("old"); await wait("document.querySelector('.conversation-scroll').textContent.includes('PREVIOUS_LIVE_FRAGMENT')");
    await create(); await wait("document.querySelector('.chat-loading')");
    rejectCreate(new Error("Expected test creation failure"));
    await wait("!document.querySelector('.chat-loading')"); await frames();
    assert.doesNotMatch(await content(), /PREVIOUS_|LATE_OLD_|NEW_CHAT_LIVE/, "failed creation must leave a clean view");
    await choose("old"); await wait("document.querySelector('.conversation-scroll').textContent.includes('PREVIOUS_LIVE_FRAGMENT')");
    assert.match(await content(), /PREVIOUS_SAVED_MESSAGE/, "switching views must preserve the original chat");
    console.log(`PASS: new chat clears live text, background events stay isolated, late opens cannot overwrite selection, failed creation stays clean, original chat remains intact. ${temporary}`);
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { window?.destroy(); app.exit(process.exitCode || 0); }
});
