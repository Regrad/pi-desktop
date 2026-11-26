const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const { mkdirSync, mkdtempSync, writeFileSync } = require("node:fs");
const root = process.env.PI_COMMAND_UI_ROOT || path.resolve(__dirname, "..");
mkdirSync("C:/AI_Temp", { recursive: true });
const temporary = mkdtempSync("C:/AI_Temp/pi-command-palette-");
app.setPath("userData", temporary);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let window;
  try {
    const conversation = { id: "commands", title: "Command menu", status: "idle", createdAt: new Date(1).toISOString(), updatedAt: new Date(2).toISOString() };
    const commands = Array.from({ length: 24 }, (_, index) => ({ name: index === 0 ? `skill:${"very-long-command-name-".repeat(8)}` : `skill:pi-lens-command-${index}`,
      description: "Search and replace code patterns. " + "LongDescriptionWithoutSpaces".repeat(25), source: "skill" }));
    const snapshot = { conversation, commands, messages: [], entries: [], compactions: [], queuedPrompts: [], models: [], thinkingLevels: ["medium"],
      state: { isStreaming: false, isCompacting: false, thinkingLevel: "medium", steeringMessages: [], followUpMessages: [] },
      extensionState: { extensionPaths: [], activeTools: [], tools: [], commandDiagnostics: [], shortcutDiagnostics: [], errors: [] },
      extensionUi: { statuses: {}, widgets: [], headerLines: [], footerLines: [], pendingDialogs: [] } };
    let language = "ru";
    ipcMain.handle("desktop:bootstrap", () => ({ interfaceLanguage: language, projects: [], conversations: [conversation], archivedConversations: [],
      activeConversationId: conversation.id, dataDir: temporary, sessionsDir: temporary }));
    ipcMain.handle("desktop:open-conversation", () => snapshot);
    ipcMain.handle("desktop:get-model-servers", () => []);
    ipcMain.handle("desktop:project-location-issues", () => []);
    ipcMain.handle("desktop:browser", () => ({ tabs: [] }));
    ipcMain.handle("pi:set-editor-text", () => undefined);
    window = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { offscreen: true, backgroundThrottling: false,
      preload: path.join(root, "dist-electron/electron/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    const js = code => window.webContents.executeJavaScript(code);
    const wait = condition => js(`new Promise((resolve,reject)=>{const end=Date.now()+6000;function check(){if(${condition})return resolve();if(Date.now()>end)return reject(Error('UI timeout: '+${JSON.stringify(condition)}));setTimeout(check,20)}check()})`);
    const frames = () => js("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    for (language of ["ru", "en"]) {
      await window.loadFile(path.join(root, "dist/index.html"));
      await wait("document.querySelector('.composer button[title*=\"Ctrl+Shift+P\"]')");
      await js("document.querySelector('.composer button[title*=\"Ctrl+Shift+P\"]').click()");
      await wait("document.querySelector('.command-palette')");
      for (const [width, height, zoom] of [[560, 740, 1], [760, 480, 1], [760, 640, 1.25], [1100, 800, 1]]) {
        window.setSize(width, height);
        window.webContents.setZoomFactor(zoom);
        const [contentWidth, contentHeight] = window.getContentSize();
        await wait(`Math.abs(innerWidth - ${contentWidth / zoom}) <= 1 && Math.abs(innerHeight - ${contentHeight / zoom}) <= 1`);
        await frames();
        const geometry = await js(`(()=>{
          const card=document.querySelector('.command-palette'), list=card.querySelector('.command-dynamic-list');
          list.scrollTop=0;
          const rect=e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
          return {viewport:{width:innerWidth,height:innerHeight},card:rect(card),close:rect(card.querySelector('.modal-head button')),
            search:rect(card.querySelector('input')),note:rect(card.querySelector('.command-palette-note')),
            badge:rect(list.querySelector('em')),first:rect(list.querySelector('button')),text:rect(list.querySelector('button > span')),
            list:rect(list),scrollable:list.scrollHeight>list.clientHeight,overflow:card.scrollWidth>card.clientWidth+1};
        })()`);
        for (const key of ["card", "close", "search", "note", "badge"]) {
          const r = geometry[key];
          assert.ok(r.left >= 8 && r.top >= 8 && r.right <= geometry.viewport.width - 8 && r.bottom <= geometry.viewport.height - 8,
            `${language} ${width}×${height} @${zoom}: ${key} is clipped: ${JSON.stringify(geometry)}`);
        }
        assert.equal(geometry.overflow, false, JSON.stringify(geometry));
        assert.ok(geometry.text.top >= geometry.first.top && geometry.text.bottom <= geometry.first.bottom, "long command names must fit their own row: " + JSON.stringify(geometry));
        assert.ok(geometry.scrollable && geometry.list.height > 20, "commands must scroll inside the dialog");
        await js("document.querySelector('.command-dynamic-list').scrollTop=100000"); await frames();
        const bottom = await js("(()=>{const e=document.querySelector('.command-dynamic-list');return {last:e.lastElementChild.getBoundingClientRect().bottom,list:e.getBoundingClientRect().bottom,scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight}})()");
        assert.ok(bottom.last <= bottom.list + 1, `${language} ${width}×${height} @${zoom}: final command is clipped: ${JSON.stringify(bottom)}`);
        if (language === "ru" && width === 560) writeFileSync(path.join(temporary, "narrow.png"), (await window.webContents.capturePage()).toPNG());
      }
      await js("document.querySelector('.command-dynamic-list button:last-child').click()");
      await wait("!document.querySelector('.command-palette')");
      assert.equal(await js("document.querySelector('.composer textarea').value"), "/skill:pi-lens-command-23 ");
      await js("document.querySelector('.composer button[title*=\"Ctrl+Shift+P\"]').click()"); await wait("document.querySelector('.command-palette input')");
      await js("(()=>{const e=document.querySelector('.command-palette input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'no-such-command');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
      await wait("document.querySelector('.command-empty')");
      await js("document.querySelector('.command-palette .modal-head button').click()");
      await wait("!document.querySelector('.command-palette')");
    }
    console.log(`PASS: command menu fits narrow/short windows and zoom, close/search/footer/badges remain visible, list scrolls, command selection and search work in RU/EN. ${temporary}`);
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { window?.destroy(); app.exit(process.exitCode || 0); }
});
