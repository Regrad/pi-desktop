const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdtempSync, mkdirSync } = require("node:fs");
const root = process.env.PI_ACCESS_UI_ROOT || path.resolve(__dirname, "..");
mkdirSync("C:/AI_Temp", { recursive: true });
const temporary = mkdtempSync("C:/AI_Temp/pi-access-ui-");
app.setPath("userData", temporary);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let window;
  try {
    const conversation = { id: "access-smoke", title: "Sprite approval", status: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const state = { isStreaming: false, isCompacting: false, thinkingLevel: "medium", steeringMessages: [], followUpMessages: [] };
    const snapshot = { conversation, messages: [{ role: "user", content: "Draw a skeleton wizard sprite.", timestamp: 1 }], state, models: [], thinkingLevels: ["medium"], commands: [], entries: [], compactions: [], queuedPrompts: [],
      extensionState: { extensionPaths: [], activeTools: [], tools: [], commandDiagnostics: [], shortcutDiagnostics: [], errors: [] },
      extensionUi: { statuses: {}, widgets: [], headerLines: [], footerLines: [], pendingDialogs: [] } };
    ipcMain.handle("desktop:bootstrap", () => ({ interfaceLanguage: "en", projects: [], conversations: [conversation], activeConversationId: conversation.id, dataDir: temporary, sessionsDir: temporary }));
    ipcMain.handle("desktop:open-conversation", () => snapshot);
    ipcMain.handle("desktop:get-model-servers", () => []);
    ipcMain.handle("desktop:project-location-issues", () => []);
    ipcMain.handle("desktop:browser", () => ({ tabs: [] }));
    ipcMain.handle("pi:set-editor-text", () => undefined);
    const calls = [];
    ipcMain.handle("pi:control-access", (_event, id, action, revision) => { calls.push({ id, action, revision }); });
    window = new BrowserWindow({ show: false, width: 1100, height: 820, webPreferences: { offscreen: true, backgroundThrottling: false, preload: path.join(root, "dist-electron/electron/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    await window.loadFile(path.join(root, "dist/index.html"));
    const evaluate = code => window.webContents.executeJavaScript(code);
    const waitFor = condition => evaluate(`new Promise((resolve,reject)=>{const end=Date.now()+6000;function check(){if(${condition})return resolve();if(Date.now()>end)return reject(Error('UI timeout: '+${JSON.stringify(condition)}));setTimeout(check,25)}check()})`);
    await waitFor("document.querySelector('.access-chip')");
    assert.match(await evaluate("document.querySelector('.access-chip').textContent"), /Agree first/);
    await evaluate("document.querySelector('.access-chip').click()");
    await waitFor("document.querySelectorAll('.access-menu [role=menuitemradio]').length === 2");
    assert.equal(await evaluate("document.querySelectorAll('.access-menu [role=menuitemradio]').length"), 2);
    await evaluate("document.querySelectorAll('.access-menu button')[1].click()");
    await waitFor("!document.querySelector('.access-menu')");
    assert.deepEqual(calls.pop(), { id: conversation.id, action: "full", revision: 0 });
    conversation.access = { mode: "confirm", phase: "review", revision: 5, proposal: { description: "Draw a 128×128 skeleton wizard, then save the editable sprite and PNG.", targets: ["skeleton_wizard.aseprite", "skeleton_wizard.png"], risks: "" } };
    window.webContents.send("desktop:conversation-changed", conversation);
    await waitFor("document.querySelector('.access-approval')");
    assert.match(await evaluate("document.querySelector('.access-approval').textContent"), /Allow changes/);
    await evaluate("document.querySelector('.access-approval .primary').click()");
    await waitFor("document.querySelector('.access-approval .primary:not(:disabled)')");
    assert.deepEqual(calls.pop(), { id: conversation.id, action: "approve", revision: 5 });
    for (const width of [1100, 760]) {
      window.setSize(width, 820);
      await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      const layout = await evaluate(`(()=>{const card=document.querySelector('.access-approval').getBoundingClientRect();return {right:card.right,bottom:card.bottom,width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth}})()`);
      assert.ok(layout.right <= layout.width && layout.bottom <= layout.height && !layout.overflow, JSON.stringify(layout));
    }
    conversation.access = { ...conversation.access, phase: "approved", started: false, revision: 6 };
    window.webContents.send("desktop:conversation-changed", conversation);
    await waitFor("document.querySelector('.access-permission') && !document.querySelector('.access-approval')");
    assert.match(await evaluate("document.querySelector('.access-permission').textContent"), /Send a message to start/);
    conversation.access = { ...conversation.access, started: true, revision: 7 };
    window.webContents.send("desktop:conversation-changed", conversation);
    await waitFor("document.querySelector('.access-permission').textContent.includes('For the agreed task')");
    state.isStreaming = true;
    window.webContents.send("pi:event", { conversationId: conversation.id, event: { type: "agent_start", state } });
    await waitFor("document.querySelector('.access-chip').disabled");
    assert.equal(await evaluate("document.querySelector('.access-permission button').disabled"), false, "revocation remains available during generation");
    await evaluate("document.querySelector('.access-permission button').click()");
    await waitFor("!document.querySelector('.access-permission button').disabled");
    assert.deepEqual(calls.pop(), { id: conversation.id, action: "cancel", revision: 7 });
    await window.webContents.capturePage().then(image => image.toPNG()).then(bytes => require("node:fs").writeFileSync(path.join(temporary, "approval.png"), bytes));
    console.log(`PASS: two modes, versioned approval, permission badge, revocation while running, narrow layout. ${temporary}`);
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { window?.destroy(); app.quit(); }
});
