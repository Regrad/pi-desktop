// Uses only fixture IPC and an isolated profile. Never opens the user's data folder.
// Pass --capture-readme to refresh the README screenshot from the real renderer.
const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { pathToFileURL } = require("node:url");
const appRoot = path.resolve(__dirname, "..");
const tempRoot = process.platform === "win32" ? "C:\\AI_Temp" : os.tmpdir();
mkdirSync(tempRoot, { recursive: true });
const temporary = mkdtempSync(path.join(tempRoot, "pi-language-ui-"));
app.setPath("userData", path.join(temporary, "chromium"));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  let window;
  try {
    const { DataStore } = await import(pathToFileURL(path.join(appRoot, "dist-electron/electron/data-store.js")).href);
    const fixtureData = path.join(temporary, "fixture-data");
    const makeStore = () => new DataStore(fixtureData, appRoot, process.execPath, path.join(temporary, "shared"));
    let store = makeStore();
    await store.initialize({ refreshSessions: false });
    const date = "2026-11-13T10:00:00.000Z";
    const project = { id: "demo", name: "Studio website", path: "C:\\Projects\\studio-website", paths: ["C:\\Projects\\studio-website"], addedAt: date, lastOpenedAt: date };
    const chat = { id: "demo-release", projectId: project.id, title: "Prepare the next release", status: "idle", createdAt: date, updatedAt: date,
      plan: { revision: 3, execution: "paused", updatedAt: date, steps: [
        { step: "Review the app structure and release scripts", status: "completed" },
        { step: "Document the build and verification steps", status: "completed" },
        { step: "Check the release checklist", status: "completed" },
      ] } };
    const chats = [chat,
      { ...chat, id: "demo-layout", title: "Polish the landing page", plan: undefined },
      { ...chat, id: "demo-search", title: "Add keyboard navigation", plan: undefined },
      { ...chat, id: "demo-ideas", title: "Ideas for a small weekend project", projectId: undefined, plan: undefined }];
    const model = { provider: "local", id: "local-model", name: "Local model", contextWindow: 32768, reasoning: true, thinkingLevels: ["off", "low", "medium", "high"] };
    const userText = "Review the project and put together a clear release checklist. Keep the build reproducible and preserve existing user data.";
    const answerText = "The release checklist is ready. The app and user data have separate folders, so updates can replace the application without overwriting existing chats.\n\n### Release workflow\n\n1. **Build** the app from the pinned source revision.\n2. **Verify** startup, settings, and chat navigation in an isolated profile.\n3. **Package** the application and keep the existing data folder in place.\n\n```powershell\nnpm ci\nnpm run build\nnpm run release:update\n```\n\nThe checklist is complete. Review the packaged app before publishing the release.";
    const snapshot = { conversation: chat, messages: [
      { role: "user", content: userText, timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: answerText }], timestamp: 2, stopReason: "stop" },
    ], state: { isStreaming: false, isCompacting: false, model, thinkingLevel: "medium", steeringMessages: [], followUpMessages: [] },
      models: [model], thinkingLevels: model.thinkingLevels, commands: [], entries: [], compactions: [], queuedPrompts: [],
      extensionState: { extensionPaths: [], activeTools: [], tools: [], commandDiagnostics: [], shortcutDiagnostics: [], errors: [] },
      extensionUi: { statuses: {}, widgets: [], headerLines: [], footerLines: [], workingVisible: false, pendingDialogs: [] } };
    ipcMain.handle("desktop:bootstrap", () => ({ projects: [project], conversations: chats, archivedConversations: [], activeProjectId: project.id, activeConversationId: chat.id, dataDir: fixtureData, sessionsDir: path.join(fixtureData, "sessions"), interfaceLanguage: store.getInterfaceLanguage() }));
    ipcMain.handle("desktop:open-conversation", () => snapshot);
    ipcMain.handle("desktop:set-interface-language", (_event, language) => store.setInterfaceLanguage(language));
    ipcMain.handle("desktop:get-notebook-limit", () => 12000);
    ipcMain.handle("desktop:get-model-servers", () => []);
    ipcMain.handle("pi:set-editor-text", () => undefined);
    ipcMain.handle("desktop:browser", () => ({ tabs: [], visible: false }));
    const errors = [];
    window = new BrowserWindow({ show: false, width: 1600, height: 850, backgroundColor: "#f7f7f5", webPreferences: { offscreen: true, backgroundThrottling: false, preload: path.join(appRoot, "dist-electron/electron/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    window.webContents.on("console-message", event => { if (event.level === "error" && !event.message.includes("frame-ancestors")) errors.push(event.message); });
    const js = source => window.webContents.executeJavaScript(source);
    const waitFor = source => js(`new Promise((resolve,reject)=>{const end=Date.now()+8000;function check(){if(${source})return resolve();if(Date.now()>end)return reject(Error('UI timeout: '+${JSON.stringify(source)}));setTimeout(check,25)}check()})`);
    const changeLanguage = async language => {
      await js(`(()=>{const el=document.querySelector('#interface-language');el.value=${JSON.stringify(language)};el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      await waitFor(`document.documentElement.lang === ${JSON.stringify(language)} && !document.querySelector('#interface-language').disabled`);
    };
    const openSettings = async () => { await js("document.querySelector('.sidebar-footer').click()"); await waitFor("document.querySelector('#interface-language')"); };
    const back = async () => { await js("document.querySelector('.settings-back').click()"); await waitFor("document.querySelector('.composer textarea')"); };
    await window.loadFile(path.join(appRoot, "dist/index.html"));
    await waitFor("document.querySelector('.plan-step') && document.querySelector('.composer textarea')");
    assert.equal(await js("document.documentElement.lang"), "en");
    assert.equal(await js("document.querySelector('.plan-heading strong').textContent"), "Plan completed");
    if (process.argv.includes("--capture-readme")) {
      await js("document.fonts.ready");
      await new Promise(resolve => setTimeout(resolve, 250));
      const directory = path.join(appRoot, "docs", "assets");
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "pi-desktop.png"), (await window.webContents.capturePage()).toPNG());
    }
    const draft = "Несохранённый черновик — keep this text";
    await js(`(()=>{const el=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(draft)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await openSettings();
    assert.equal(await js("document.querySelector('#interface-language').value"), "en");
    await changeLanguage("ru");
    assert.equal(await js("document.querySelector('.settings-inner h1').textContent"), "Общее");
    writeFileSync(path.join(temporary, "settings-ru.png"), (await window.webContents.capturePage()).toPNG());
    await back();
    assert.equal(await js("document.querySelector('.composer textarea').value"), draft);
    assert.equal(await js("document.querySelector('.plan-heading strong').textContent"), "План выполнен");
    assert.equal(await js("document.querySelector('.chat-header strong').textContent"), chat.title);
    assert.ok((await js("document.body.innerText")).includes(userText));
    // A new store and reloaded renderer simulate a launch using the saved preference.
    store = makeStore();
    await store.initialize({ refreshSessions: false });
    await window.reload();
    await waitFor("document.documentElement.lang === 'ru' && document.querySelector('.plan-step')");
    await openSettings();
    await changeLanguage("en");
    assert.equal(await js("document.querySelector('.settings-inner h1').textContent"), "General");
    writeFileSync(path.join(temporary, "settings-en.png"), (await window.webContents.capturePage()).toPNG());
    await back();
    assert.equal(await js("document.querySelector('.plan-heading strong').textContent"), "Plan completed");
    assert.deepEqual(errors, [], "Renderer errors");
    console.log(JSON.stringify({ result: "PASS", checks: ["English default", "EN/RU switch", "draft preserved", "user content unchanged", "persisted language after reload", "switch back to English"], temporary }));
    window.destroy();
    app.exit(0);
  } catch (error) {
    console.error(error);
    if (window && !window.isDestroyed()) writeFileSync(path.join(temporary, "failure.png"), (await window.webContents.capturePage()).toPNG());
    console.error(`Artifacts: ${temporary}`);
    app.exit(1);
  }
});
