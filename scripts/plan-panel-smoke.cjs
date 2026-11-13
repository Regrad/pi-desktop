const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtempSync, writeFileSync } = require("node:fs");
const appRoot = path.resolve(__dirname, "..");
const temporary = mkdtempSync(path.join(os.tmpdir(), "pi-plan-smoke-"));
app.setPath("userData", temporary);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let window;
  let phase = "startup";
  try {
    const conversation = { id: "plan-smoke", title: "Рабочий план", status: "working", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      plan: { execution: "active", revision: 1, updatedAt: new Date().toISOString(), explanation: "Проверка показала, что план нужно дополнить тестом восстановления состояния.", steps: [
        { step: "Изучить структуру проекта и существующие инструменты", status: "completed" },
        { step: "Добавить изменяемый чеклист и компактную панель", status: "in_progress" },
        { step: "Проверить сохранение после перезапуска и собрать релиз", status: "pending" },
      ] } };
    const state = { isStreaming: true, isCompacting: false, thinkingLevel: "medium", steeringMessages: [], followUpMessages: [] };
    const snapshot = { planWorkingRevision: 1, conversation, messages: [{ role: "user", content: "Сделай изменяемый чеклист для сложных задач.", timestamp: 1 }, { role: "assistant", content: [{ type: "text", text: "Сначала изучил проект. Добавляю инструмент и панель рабочего плана." }], timestamp: 2 }], state, models: [], thinkingLevels: ["medium"], commands: [], entries: [], compactions: [], queuedPrompts: [],
      extensionState: { extensionPaths: [], activeTools: [], tools: [], commandDiagnostics: [], shortcutDiagnostics: [], errors: [] },
      extensionUi: { statuses: {}, widgets: [], headerLines: [], footerLines: [], workingVisible: true, pendingDialogs: [] } };
    ipcMain.handle("desktop:bootstrap", () => ({ interfaceLanguage: "ru", projects: [], conversations: [conversation], archivedConversations: [], activeConversationId: conversation.id, dataDir: temporary, sessionsDir: temporary }));
    ipcMain.handle("desktop:open-conversation", () => snapshot);
    ipcMain.handle("pi:set-editor-text", () => undefined);
    ipcMain.handle("desktop:get-model-servers", () => []);
    ipcMain.handle("desktop:get-notebook-limit", () => 12000);
    ipcMain.handle("desktop:browser", () => ({ tabs: [], visible: false }));

    const queuedCalls = [];
    ipcMain.handle("desktop:queue-prompt", (_event, id, message, attachments, requestPlan) => {
      queuedCalls.push({ id, message, requestPlan });
      return [{ id: "queued", message, attachments, requestPlan, createdAt: new Date().toISOString() }];
    });
    let removed = false;
    ipcMain.handle("pi:remove-plan", (_event, id) => {
      assert.equal(id, conversation.id);
      removed = true;
      conversation.plan = { ...conversation.plan, revision: conversation.plan.revision + 1, steps: [] };
      window.webContents.send("desktop:conversation-changed", conversation);
    });
    window = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: { offscreen: true, backgroundThrottling: false, preload: path.join(appRoot, "dist-electron/electron/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    const errors = [];
    window.webContents.on("console-message", event => { if (event.level === "error" && !event.message.includes("frame-ancestors")) errors.push(event.message); });
    await window.loadFile(path.join(appRoot, "dist/index.html"));
    const waitFor = condition => window.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const end=Date.now()+5000;function check(){if(${condition})return resolve();if(Date.now()>end)return reject(Error('UI timeout'));setTimeout(check,25)}check()})`);
    await waitFor("document.querySelector('.plan-step.in_progress')");
    assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.plan-step').length"), 3);
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.plan-progress').getAttribute('aria-valuenow')"), "1");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.plan-step-status').textContent"), "Выполняется");
    assert.equal(await window.webContents.executeJavaScript("getComputedStyle(document.querySelector('.plan-spinner')).animationName"), "plan-spin");
    const firstRotation = await window.webContents.executeJavaScript("getComputedStyle(document.querySelector('.plan-spinner')).transform");
    await new Promise(resolve => setTimeout(resolve, 250));
    const nextRotation = await window.webContents.executeJavaScript("getComputedStyle(document.querySelector('.plan-spinner')).transform");
    assert.notEqual(firstRotation, nextRotation, "Current step indicator actually rotates");
    window.webContents.send("pi:event", { conversationId: conversation.id, event: { type: "desktop_persistence_error", error: "Smoke: temporary save failure" } });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.plan-step-status').textContent"), "Выполняется");
    phase = "capture expanded";
    writeFileSync(path.join(temporary, "plan-expanded.png"), (await window.webContents.capturePage()).toPNG());
    const originalPlan = conversation.plan;
    conversation.plan = { ...originalPlan, steps: Array.from({ length: 40 }, (_, index) => ({
      step: `Шаг ${index + 1}: изучить затронутые системы, проверить связи и сохранить подтверждённый результат`,
      status: index === 2 ? "in_progress" : "pending",
    })) };
    window.webContents.send("desktop:conversation-changed", conversation);
    await waitFor("document.querySelectorAll('.plan-step').length === 40");
    window.setSize(1920, 1000);
    await waitFor("getComputedStyle(document.querySelector('.conversation-plan')).position === 'absolute'");
    await new Promise(resolve => setTimeout(resolve, 300));
    const layout = () => window.webContents.executeJavaScript(`(()=>{
      const plan=document.querySelector('.conversation-plan'),panel=document.querySelector('.plan-panel'),body=document.querySelector('.plan-body'),composer=document.querySelector('.composer-wrap'),scroll=document.querySelector('.conversation-scroll');
      const p=plan.getBoundingClientRect(),c=composer.getBoundingClientRect(),s=scroll.getBoundingClientRect();
      return {right:p.left>=c.right && p.left>=s.right,internalScroll:body.scrollHeight>body.clientHeight,outerScroll:composer.scrollHeight>composer.clientHeight+1,visible:panel.getBoundingClientRect().bottom<=innerHeight && c.bottom<=innerHeight,overflow:getComputedStyle(composer).overflowY};
    })()`);
    let geometry = await layout();
    assert.equal(geometry.right, true, "Wide layout puts plan beside chat and composer");
    assert.equal(geometry.internalScroll, true, "Long plan scrolls inside card");
    assert.equal(geometry.visible, true, "Plan and composer stay within viewport");
    assert.equal(geometry.overflow, "visible", "Composer has no outer scrollbar");
    phase = "capture right panel";
    writeFileSync(path.join(temporary, "plan-right.png"), (await window.webContents.capturePage()).toPNG());
    window.setSize(1100, 600);
    await waitFor("getComputedStyle(document.querySelector('.conversation-plan')).position !== 'absolute'");
    await new Promise(resolve => setTimeout(resolve, 300));
    geometry = await layout();
    assert.equal(geometry.internalScroll, true);
    assert.equal(geometry.visible, true, "Narrow layout keeps input visible");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.conversation-plan').getBoundingClientRect().bottom <= document.querySelector('.composer-wrap').getBoundingClientRect().top + 1"), true);
    writeFileSync(path.join(temporary, "plan-narrow.png"), (await window.webContents.capturePage()).toPNG());
    window.setSize(1100, 800);
    conversation.plan = originalPlan;
    window.webContents.send("desktop:conversation-changed", conversation);
    await waitFor("document.querySelectorAll('.plan-step').length === 3");
    await window.webContents.executeJavaScript("document.querySelector('.plan-heading').click()");
    await waitFor("!document.querySelector('.plan-body')");
    assert.match(await window.webContents.executeJavaScript("document.querySelector('.plan-current').textContent"), /изменяемый чеклист/);
    await new Promise(resolve => setTimeout(resolve, 250));
    writeFileSync(path.join(temporary, "plan-collapsed.png"), (await window.webContents.capturePage()).toPNG());
    conversation.plan = { ...conversation.plan, revision: 2, steps: conversation.plan.steps.map(step => ({ ...step, status: "completed" })) };
    window.webContents.send("desktop:conversation-changed", conversation);
    await waitFor("document.querySelector('.plan-heading strong').textContent === 'План выполнен'");
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('.plan-progress').getAttribute('aria-valuenow')"), "3");
    await window.webContents.executeJavaScript("document.querySelector('[aria-label=\"Убрать план\"]').click()");
    await waitFor("!document.querySelector('.plan-panel')");
    assert.equal(removed, true);
    // A normal-mode checklist does not implicitly enter read-only planning mode.
    await window.webContents.executeJavaScript("(()=>{const input=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'Изучи систему и предложи изменения');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await new Promise(resolve => setTimeout(resolve, 100));
    await window.webContents.executeJavaScript("document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))");
    assert.equal(queuedCalls.length, 1);
    assert.equal(queuedCalls[0].requestPlan, false);
    assert.equal(queuedCalls[0].message, "Изучи систему и предложи изменения");
    assert.deepEqual(errors, []);
    writeFileSync(path.join(temporary, "result.json"), JSON.stringify({ passed: true }));
    console.log(`Plan UI smoke passed; screenshots: ${temporary}`);
    window.destroy(); app.exit(0);
  } catch (error) { writeFileSync(path.join(temporary, "result.json"), JSON.stringify({ passed: false, phase, error: String(error), stack: error.stack })); console.error(error); window?.destroy(); app.exit(1); }
});
