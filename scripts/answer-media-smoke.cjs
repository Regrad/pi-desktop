const { app, BrowserWindow, ipcMain, nativeImage } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtempSync, readFileSync } = require("node:fs");
const { rm } = require("node:fs/promises");
const appRoot = process.env.PI_SMOKE_APP_ROOT || path.resolve(__dirname, "..");
const temporary = mkdtempSync(path.join(os.tmpdir(), "pi-answer-media-smoke-"));
app.setPath("userData", temporary);

app.whenReady().then(async () => {
  let window;
  let exitCode = 0;
  try {
    const png = nativeImage.createFromBitmap(Buffer.alloc(1280 * 720 * 4, 255), { width: 1280, height: 720 }).toPNG().toString("base64");
    const conversation = { id: "smoke", title: "Media smoke", status: "running", createdAt: new Date(1).toISOString(), updatedAt: new Date(4).toISOString() };
    const image = { type: "image", data: png, mimeType: "image/png" };
    const messages = [
      { role: "user", content: "Create an image", images: [{ name: "User image", data: png, mimeType: "image/png" }], timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "image", name: "media_generate_image", arguments: { prompt: "test" } }], stopReason: "toolUse", timestamp: 2 },
      { role: "toolResult", toolCallId: "image", toolName: "media_generate_image", content: [{ type: "text", text: "Saved test image" }, image], details: { files: ["C:/test.png"] }, timestamp: 3 },
    ];
    const live = { role: "assistant", content: [{ type: "text", text: "Streaming final answer" }], timestamp: 4 };
    const state = { isStreaming: true, isCompacting: false, thinkingLevel: "medium", steeringMessages: [], followUpMessages: [] };
    ipcMain.handle("desktop:bootstrap", () => ({ projects: [], conversations: [conversation], archivedConversations: [], activeConversationId: conversation.id, dataDir: temporary, sessionsDir: temporary }));
    ipcMain.handle("desktop:open-conversation", () => ({ conversation, messages, state, liveMessage: live, models: [], thinkingLevels: ["medium"], commands: [], entries: [], compactions: [], queuedPrompts: [], extensionState: { extensionPaths: [], activeTools: [], tools: [], commandDiagnostics: [], shortcutDiagnostics: [], errors: [] }, extensionUi: { statuses: {}, widgets: [], headerLines: [], footerLines: [], workingVisible: true, pendingDialogs: [] } }));
    ipcMain.handle("pi:set-editor-text", () => undefined);
    window = new BrowserWindow({ show: false, width: 1280, height: 900,
      titleBarStyle: "hidden", titleBarOverlay: { color: "#f6f6f4", symbolColor: "#656560", height: 36 },
      webPreferences: { preload: path.join(appRoot, "dist-electron/electron/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    const errors = [];
    let consoleMessages = 0;
    window.webContents.on("console-message", event => {
      consoleMessages++;
      // Chromium reports this existing meta-CSP limitation as an error, not a UI exception.
      if (event.level === "error" && event.message !== "The Content Security Policy directive 'frame-ancestors' is ignored when delivered via a <meta> element.") errors.push(event.message);
    });
    // Exercise the callback explicitly: normal UI may not emit a console message.
    await window.loadURL("data:text/html,console callback test");
    await window.webContents.executeJavaScript("console.warn('smoke callback probe')");
    assert.ok(consoleMessages > 0, "Console callback exercised without an exception");
    await window.loadFile(path.join(appRoot, "dist/index.html"));
    // CSS-only fixes can be checked in Chromium without compiling the project.
    if (process.env.PI_SMOKE_SOURCE_STYLES) {
      const sourceStyles = readFileSync(path.resolve(__dirname, "../src/styles.css"), "utf8");
      await window.webContents.executeJavaScript(`(() => { const style=document.createElement('style'); style.textContent=${JSON.stringify(sourceStyles)}; document.head.appendChild(style); })()`);
    }
    const waitFor = condition => window.webContents.executeJavaScript(`new Promise((resolve, reject) => { const deadline=Date.now()+5000; function check(){ if(${condition}) return resolve(); if(Date.now()>deadline) return reject(new Error('UI condition timed out: '+${JSON.stringify(condition)})); setTimeout(check,20); } check(); })`);
    await waitFor("document.body.textContent.includes('Streaming final answer')");
    const openPreview = async selector => {
      await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`);
      await waitFor("document.querySelector('.image-preview-dialog:modal') && document.querySelector('.image-preview-full')?.naturalWidth > 0");
      assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.image-preview-dialog').length"), 1);
      const previewLayout = await window.webContents.executeJavaScript(`(() => {
        const title=document.querySelector('.titlebar').getBoundingClientRect();
        const preview=document.querySelector('.image-preview-dialog');
        const bounds=preview.getBoundingClientRect();
        const close=preview.querySelector('.image-preview-close').getBoundingClientRect();
        const backdrop=getComputedStyle(preview, '::backdrop');
        return { titleBottom:title.bottom, top:bounds.top, closeTop:close.top, backdropTop:parseFloat(backdrop.top), bottom:bounds.bottom, height:innerHeight };
      })()`);
      assert.ok(previewLayout.top>=previewLayout.titleBottom && previewLayout.closeTop>=previewLayout.titleBottom && previewLayout.backdropTop>=previewLayout.titleBottom && Math.abs(previewLayout.bottom-previewLayout.height)<1,
        `Viewer, backdrop and its close button stay below native window controls: ${JSON.stringify(previewLayout)}`);
    };
    const closePreview = async () => {
      await window.webContents.executeJavaScript("document.querySelector('[aria-label=\"Закрыть просмотр\"]').click()");
      await waitFor("!document.querySelector('.image-preview-dialog')");
    };
    await openPreview(".message-image-thumb");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.image-preview-full').alt"), "User image");
    const fits = "(() => { const a=document.querySelector('.image-preview-full').getBoundingClientRect(), b=document.querySelector('.image-preview-stage').getBoundingClientRect(); return a.width<=b.width+1 && a.height<=b.height+1 && a.width>78 && Math.abs(a.width/a.height - 1280/720)<0.01; })()";
    assert.equal(await window.webContents.executeJavaScript(fits), true);
    window.setSize(900, 620);
    await waitFor(fits);
    window.setSize(1280, 900);
    await closePreview();
    await window.webContents.executeJavaScript("document.querySelector('.message-image-thumb').dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true}))");
    await waitFor("document.querySelector('.image-preview-dialog:modal')");
    await closePreview();
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.assistant-published-media').length"), 0);
    await window.webContents.executeJavaScript("document.querySelector('.process-fold-head').click()");
    await waitFor("document.querySelector('.tool-card-head')");
    await window.webContents.executeJavaScript("document.querySelector('.tool-card-head').click()");
    await waitFor("document.querySelector('.tool-card-body img')");
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.assistant-published-media').length"), 0);
    await openPreview(".tool-card-body img");
    await window.webContents.executeJavaScript("document.querySelector('[aria-label=\"Увеличить\"]').click()");
    await waitFor("document.querySelector('.image-preview-toolbar span').textContent === '125%'");
    const scrollBefore = await window.webContents.executeJavaScript("document.querySelector('.chat-scroll')?.scrollTop");
    await window.webContents.executeJavaScript("document.querySelector('.image-preview-stage').dispatchEvent(new WheelEvent('wheel', { deltaY: -60, clientX: 640, clientY: 450, bubbles: true, cancelable: true }))");
    await waitFor("parseInt(document.querySelector('.image-preview-toolbar span').textContent) > 125");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.chat-scroll')?.scrollTop"), scrollBefore);
    await window.webContents.executeJavaScript("document.querySelector('[aria-label=\"Вписать изображение\"]').click()");
    await waitFor("document.querySelector('.image-preview-toolbar span').textContent === '100%'");
    const point = await window.webContents.executeJavaScript("(() => { const r=document.querySelector('.image-preview-full').getBoundingClientRect(); return { x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2) }; })()");
    window.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: "mouseMove", x: point.x + 80, y: point.y + 40 });
    window.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, x: point.x + 80, y: point.y + 40 });
    await waitFor("document.querySelector('.image-preview-full').style.transform.includes('translate(80px, 40px)')");
    const send = event => window.webContents.send("pi:event", { conversationId: "smoke", event });
    send({ type: "message_end", message: { ...live, stopReason: "stop" } });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.assistant-published-media').length"), 0);
    send({ type: "agent_settled", state: { ...state, isStreaming: false } });
    await waitFor("document.querySelector('article.message.assistant .assistant-message .assistant-published-media img')");
    // Viewer must survive the original tool image being moved/unmounted.
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.image-preview-dialog:modal').length"), 1);
    await closePreview();
    await openPreview(".assistant-published-media img");
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await waitFor("!document.querySelector('.image-preview-dialog')");
    assert.equal(await window.webContents.executeJavaScript("document.activeElement === document.querySelector('.assistant-published-media img')"), true);
    await window.webContents.executeJavaScript(`(() => {
      const bytes=Uint8Array.from(atob(${JSON.stringify(png)}), c=>c.charCodeAt(0));
      const transfer=new DataTransfer(); transfer.items.add(new File([bytes], 'draft.png', {type:'image/png'}));
      document.querySelector('.composer textarea').dispatchEvent(new ClipboardEvent('paste', {clipboardData:transfer, bubbles:true, cancelable:true}));
    })()`);
    await waitFor("document.querySelector('.attachment-preview img')");
    await openPreview(".attachment-preview img");
    await window.webContents.executeJavaScript("document.querySelector('.image-preview-stage').click()");
    await waitFor("!document.querySelector('.image-preview-dialog')");
    await window.webContents.executeJavaScript("document.querySelector('.attachment-preview [aria-label^=\"Удалить\"]').click()");
    await waitFor("!document.querySelector('.attachment-preview')");
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.tool-card-body img').length"), 0);
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.assistant-published-media img').length"), 1);
    send({ type: "message_start", message: { role: "user", content: "Next task", timestamp: 5 } });
    send({ type: "agent_start" });
    await waitFor("document.body.textContent.includes('Next task')");
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.assistant-published-media img').length"), 1);
    assert.deepEqual(errors, []);
    console.log("Built UI verified: media placement preserved; image viewer works for tools, answers, sent and draft attachments; zoom, wheel, pan, reset, Escape, focus return, backdrop close and streaming transfer passed");
  } catch (error) { console.error(error); exitCode = 1; }
  finally { window?.destroy(); await rm(temporary, { recursive: true, force: true }).catch(() => {}); app.exit(exitCode); }
});
