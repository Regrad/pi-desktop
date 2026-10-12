const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtempSync, writeFileSync } = require("node:fs");
const root = path.resolve(__dirname, "..");
const temporary = mkdtempSync(path.join(os.tmpdir(), "pi-notebook-smoke-"));
app.setPath("userData", temporary);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let window;
  try {
    const conversation = { id: "notebook-smoke", title: "Проверка блокнота", status: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      notebook: { content: "## Проект\n\n- Папка: `X:\\KDPI`\n- Сайт: https://example.test/kdpi\n- Источник: пользователь\n\n## Учётная запись\n\nЛогин: demo\nПароль: test-only-secret", revision: 1, updatedAt: new Date().toISOString() },
      plan: { revision: 1, steps: [{ step: "Проверить блокнот", status: "pending" }] } };
    const snapshot = { conversation, messages: [{ role: "user", content: "Сохрани полезные сведения в блокноте", timestamp: 1 }],
      state: { isStreaming: false, isCompacting: false, thinkingLevel: "medium", steeringMessages: [], followUpMessages: [] }, models: [], thinkingLevels: ["medium"], commands: [], entries: [], compactions: [], queuedPrompts: [],
      extensionState: { extensionPaths: [], activeTools: [], tools: [], commandDiagnostics: [], shortcutDiagnostics: [], errors: [] },
      extensionUi: { statuses: {}, widgets: [], headerLines: [], footerLines: [], workingVisible: true, pendingDialogs: [] } };
    ipcMain.handle("desktop:bootstrap", () => ({ projects: [], conversations: [conversation], archivedConversations: [], activeConversationId: conversation.id, dataDir: temporary, sessionsDir: temporary }));
    ipcMain.handle("desktop:open-conversation", () => snapshot);
    ipcMain.handle("pi:set-editor-text", () => undefined);
    ipcMain.handle("desktop:browser", () => ({ tabs: [], visible: false }));
    const saves = [];
    ipcMain.handle("pi:save-notebook", (_event, id, content, revision) => {
      assert.equal(id, conversation.id); assert.equal(revision, conversation.notebook.revision);
      conversation.notebook = { content, revision: revision + 1, updatedAt: new Date().toISOString() };
      saves.push(content); window.webContents.send("desktop:conversation-changed", conversation);
      return conversation.notebook;
    });
    window = new BrowserWindow({ show: false, width: 1920, height: 1000, webPreferences: { offscreen: true, backgroundThrottling: false,
      preload: path.join(root, "dist-electron/electron/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    const errors = [];
    window.webContents.on("console-message", event => { if (event.level === "error" && !event.message.includes("frame-ancestors")) errors.push(event.message); });
    const js = value => window.webContents.executeJavaScript(value);
    const wait = condition => js(`new Promise((resolve,reject)=>{const end=Date.now()+5000;function poll(){if(${condition})return resolve();if(Date.now()>end)return reject(Error('UI timeout: '+${JSON.stringify(condition)}));setTimeout(poll,25)}poll()})`);
    const input = content => js(`(()=>{const el=document.querySelector('.notebook-content textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,${JSON.stringify(content)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await window.loadFile(path.join(root, "dist/index.html"));
    await wait("document.querySelector('.notebook-toggle')");
    assert.equal(await js("!!document.querySelector('.notebook-panel')"), false);
    await js("document.querySelector('.notebook-toggle').click()");
    await wait("document.querySelector('.notebook-preview')");
    assert.equal(await js("!!document.querySelector('.plan-panel')"), false, "Notebook takes the right panel, not the plan state");
    assert.equal(await js("getComputedStyle(document.querySelector('.conversation-notebook')).position"), "absolute");
    assert.equal(await js("document.querySelector('.conversation-notebook').getBoundingClientRect().left >= document.querySelector('.composer-wrap').getBoundingClientRect().right"), true);
    writeFileSync(path.join(temporary, "notebook-wide.png"), (await window.webContents.capturePage()).toPNG());
    await js("document.querySelector('.notebook-actions button').click()");
    await wait("document.querySelector('.notebook-content textarea')");
    await input("Папка: X:\\KDPI\nСайт: https://example.test/kdpi\nИсточник: пользователь");
    await wait("!document.querySelector('.notebook-save').disabled");
    await js("document.querySelector('.notebook-toggle').click();document.querySelector('.notebook-toggle').click()");
    await wait("document.querySelector('.notebook-content textarea')");
    assert.match(await js("document.querySelector('.notebook-content textarea').value"), /X:\\KDPI/);
    await js("document.querySelector('.notebook-save').click()");
    await wait("document.querySelector('.notebook-preview')");
    assert.equal(saves.length, 1);
    // Live model edit updates preview without reopening the notebook.
    conversation.notebook = { ...conversation.notebook, content: "Новый факт от модели", revision: 3 };
    window.webContents.send("desktop:conversation-changed", conversation);
    await wait("document.querySelector('.notebook-preview').textContent.includes('Новый факт')");
    await js("document.querySelector('.notebook-actions button').click()");
    await input("Несохранённая правка пользователя");
    await wait("!document.querySelector('.notebook-save').disabled");
    conversation.notebook = { ...conversation.notebook, content: "Конкурирующая правка модели", revision: 4 };
    window.webContents.send("desktop:conversation-changed", conversation);
    await wait("document.querySelector('.notebook-warning')");
    assert.equal(await js("document.querySelector('.notebook-save').disabled"), true);
    assert.equal(await js("document.querySelector('.notebook-content textarea').value"), "Несохранённая правка пользователя");
    await js("window.confirm=()=>true;document.querySelector('.notebook-warning button').click()");
    await wait("document.querySelector('.notebook-content textarea').value === 'Конкурирующая правка модели'");
    // Long notes scroll internally; on narrow windows the drawer must not push input out of view.
    await input("Длинная заметка\n".repeat(300));
    window.setSize(1100, 600);
    await wait("document.querySelector('.main-panel').clientWidth < 1160");
    await new Promise(resolve => setTimeout(resolve, 150));
    const geometry = await js(`(()=>{const panel=document.querySelector('.notebook-panel').getBoundingClientRect(),composer=document.querySelector('.composer-wrap').getBoundingClientRect(),footer=document.querySelector('.notebook-footer').getBoundingClientRect();return {visible:panel.bottom<=innerHeight&&composer.bottom<=innerHeight&&footer.bottom<=panel.bottom,above:panel.bottom<=composer.top+1}})()`);
    writeFileSync(path.join(temporary, "notebook-narrow.png"), (await window.webContents.capturePage()).toPNG());
    assert.equal(geometry.visible, true);
    await js("document.querySelector('[aria-label=\"Очистить блокнот\"]').click()");
    await wait("document.querySelector('.notebook-content textarea').value === ''");
    assert.equal(conversation.notebook.content, ""); assert.equal(conversation.notebook.revision, 5);
    await js("document.querySelector('[aria-label=\"Закрыть блокнот\"]').click()");
    await wait("document.querySelector('.plan-panel')");
    assert.equal(conversation.plan.steps.length, 1);
    assert.deepEqual(errors, []);
    console.log(`Notebook UI smoke passed; screenshots: ${temporary}`);
    window.destroy(); app.exit(0);
  } catch (error) { console.error(error); window?.destroy(); app.exit(1); }
});
