const { app, BrowserWindow, ipcMain } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { pathToFileURL } = require("node:url");
const root = process.env.PI_SKILLS_SMOKE_ROOT || path.resolve(__dirname, "..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-skills-ui-"));
app.setPath("userData", path.join(temporary, "electron"));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let window;
  let stage = "load";
  try {
    const { SkillsStore } = await import(pathToFileURL(path.join(root, "dist-electron/electron/skills-store.js")));
    const options = { cwd: path.join(temporary, "project"), agentDir: path.join(temporary, "agent"), appRoot: root, project: true };
    fs.mkdirSync(options.cwd, { recursive: true }); fs.mkdirSync(options.agentDir, { recursive: true });
    fs.writeFileSync(path.join(options.agentDir, "settings.json"), JSON.stringify({ skills: ["-**"] }));
    const skills = new SkillsStore(options); skills.includeNative([skills.roots.user, skills.roots.project]);
    const conversation = { id: "skills-ui", title: "Проверка навыков", status: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const snapshot = { conversation, messages: [{ role: "user", content: "Проверить навыки", timestamp: 1 }],
      state: { isStreaming: false, isCompacting: false, thinkingLevel: "medium", steeringMessages: [], followUpMessages: [] }, models: [], thinkingLevels: ["medium"], commands: [], entries: [], compactions: [], queuedPrompts: [],
      extensionState: { extensionPaths: [], activeTools: [], tools: [], commandDiagnostics: [], shortcutDiagnostics: [], errors: [] },
      extensionUi: { statuses: {}, widgets: [], headerLines: [], footerLines: [], workingVisible: true, pendingDialogs: [] } };
    ipcMain.handle("desktop:bootstrap", () => ({ interfaceLanguage: "ru", projects: [], conversations: [conversation], archivedConversations: [], activeConversationId: conversation.id, dataDir: temporary, sessionsDir: temporary }));
    ipcMain.handle("desktop:open-conversation", () => snapshot);
    ipcMain.handle("pi:set-editor-text", () => undefined);
    ipcMain.handle("desktop:get-model-servers", () => []);
    ipcMain.handle("desktop:get-notebook-limit", () => 12000);

    ipcMain.handle("desktop:browser", () => ({ tabs: [], visible: false }));
    ipcMain.handle("desktop:skills", (_event, id, command) => { assert.equal(id, conversation.id); return skills.command(command); });
    const errors = [];
    window = new BrowserWindow({ show: false, width: 1520, height: 960, webPreferences: { offscreen: true, backgroundThrottling: false,
      preload: path.join(root, "dist-electron/electron/preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    window.webContents.on("console-message", event => { if (event.level === "error" && !event.message.includes("frame-ancestors")) errors.push(event.message); });
    const js = source => window.webContents.executeJavaScript(source);
    const wait = condition => js(`new Promise((resolve,reject)=>{const end=Date.now()+15000;function poll(){if(${condition})return resolve();if(Date.now()>end)return reject(Error('UI timeout: '+${JSON.stringify(condition)}));setTimeout(poll,25)}poll()})`);
    const input = (selector, value) => js(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    const click = async text => {
      await wait(`[...document.querySelectorAll('.skills-dialog button')].some(el=>el.textContent.trim()===${JSON.stringify(text)}&&!el.disabled)`);
      return js(`(()=>{const el=[...document.querySelectorAll('.skills-dialog button')].find(el=>el.textContent.trim()===${JSON.stringify(text)});if(!el)throw Error('Missing button');el.click();})()`);
    };
    await window.loadFile(path.join(root, "dist/index.html"));
    await wait("document.querySelector('[aria-label=\"Навыки\"]')");
    await js("document.querySelector('[aria-label=\"Навыки\"]').click()");
    await wait("document.querySelector('.skill-item strong')?.textContent === 'maintain-skills'");
    assert.equal(await js("document.querySelector('.skills-dialog').matches(':modal')"), true);
    await js("document.querySelector('.skill-item').click()");
    await wait("document.querySelector('.skills-document .notebook-preview')");
    assert.equal(await js("document.querySelector('[aria-label=\"Удалить навык\"]').disabled"), true);
    await click("Создать");
    await wait("document.querySelector('[aria-label=\"Имя навыка\"]')?.value === 'my-skill'");
    await input('[aria-label="Имя навыка"]', "game-workflow");
    await wait("document.querySelector('.skills-document textarea')?.value.includes('game-workflow')");
    const first = '---\nname: game-workflow\ndescription: A reusable game workflow.\n---\n\nInspect the game scene and validate its exported resources.\n';
    await input('.skills-document textarea', first);
    stage = "create-save";
    await click("Сохранить");
    await wait("document.querySelector('.skills-actions small')?.textContent === 'Сохранено'");
    let catalog = await skills.catalog(true);
    let skill = catalog.skills.find(item => item.name === "game-workflow");
    assert.equal(skill.scope, "project"); assert.equal(fs.readFileSync(skill.filePath, "utf8"), first);
    await input('.skills-document textarea', first + "Verify the output.");
    await js("window.confirm=()=>true;document.querySelector('[aria-label=\"Закрыть навыки\"]').click()");
    await wait("!document.querySelector('.skills-dialog')");
    await js("document.querySelector('[aria-label=\"Навыки\"]').click()");
    await wait("document.querySelector('.skills-document textarea')?.value.endsWith('Verify the output.')");
    stage = "reopened-draft-save";
    await click("Сохранить");
    await wait("document.querySelector('.skills-actions small')?.textContent === 'Сохранено'");
    await click("Отключить");
    await wait("[...document.querySelectorAll('.skills-dialog button')].some(el=>el.textContent.trim()==='Включить')");
    assert.equal((await skills.catalog(true)).skills.find(item => item.id === skill.id).enabled, false);
    const restored = new SkillsStore(options); restored.includeNative([skills.roots.user, skills.roots.project]);
    assert.equal((await restored.catalog()).skills.find(item => item.id === skill.id).enabled, false);
    await click("Включить");
    await wait("[...document.querySelectorAll('.skills-dialog button')].some(el=>el.textContent.trim()==='Отключить')");
    fs.writeFileSync(path.join(temporary, "skills-wide.png"), (await window.webContents.capturePage()).toPNG());
    await input('.skills-document textarea', first + "Unsaved user edit");
    fs.writeFileSync(skill.filePath, first + "Verified concurrent model edit");
    await js("document.querySelector('[aria-label=\"Обновить список\"]').click()");
    await wait("document.querySelector('.skills-alert')?.textContent.includes('Файл изменился')");
    assert.equal(await js("[...document.querySelectorAll('.skills-dialog button')].find(el=>el.textContent.trim()==='Сохранить').disabled"), true);
    assert.match(fs.readFileSync(skill.filePath, "utf8"), /Verified concurrent model edit/);
    await js("[...document.querySelectorAll('.skill-item')].find(el=>el.textContent.includes('game-workflow')).click()");
    await wait("document.querySelector('.skills-document textarea')?.value.endsWith('Verified concurrent model edit')");
    window.setSize(620, 780);
    await new Promise(resolve => setTimeout(resolve, 150));
    const geometry = await js(`(()=>{const d=document.querySelector('.skills-dialog').getBoundingClientRect();const a=document.querySelector('.skills-actions').getBoundingClientRect();return {visible:d.left>=0&&d.right<=innerWidth&&d.top>=0&&d.bottom<=innerHeight,footer:a.bottom<=d.bottom}})()`);
    assert.equal(geometry.visible, true); assert.equal(geometry.footer, true);
    fs.writeFileSync(path.join(temporary, "skills-narrow.png"), (await window.webContents.capturePage()).toPNG());
    await js("document.querySelector('[aria-label=\"Удалить навык\"]').click()");
    await wait("!document.querySelector('.skills-document')");
    assert.equal(fs.existsSync(path.dirname(skill.filePath)), false);
    assert.ok((await skills.catalog(true)).skills.some(item => item.name === "maintain-skills"));
    assert.deepEqual(errors, []);
    console.log(`Skills UI smoke passed: bundled protection, creation, editing, draft recovery, enable/disable persistence, concurrent-edit protection, deletion and responsive layout. Screenshots: ${temporary}`);
    window.destroy(); app.exit(0);
  } catch (error) {
    console.error(stage, error);
    if (window) console.error(await window.webContents.executeJavaScript(`JSON.stringify({alerts:[...document.querySelectorAll('.skills-alert')].map(el=>el.textContent),footer:document.querySelector('.skills-actions')?.textContent,items:[...document.querySelectorAll('.skill-item strong')].map(el=>el.textContent),content:document.querySelector('.skills-document textarea')?.value})`));
    window?.destroy(); app.exit(1);
  }
});
