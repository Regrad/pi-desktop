const { app, BrowserWindow, ipcMain } = require("electron");
const { mkdtemp, writeFile, rm } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");

app.whenReady().then(async () => {
  let folder, window;
  try {
    folder = await mkdtemp(path.join(os.tmpdir(), "pi-drop-smoke-"));
    const original = path.join(folder, "photo.png");
    await writeFile(original, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF3sAAAAASUVORK5CYII=", "base64"));
    let received;
    ipcMain.handle("desktop:attach-file-paths", (_event, paths) => { received = paths; return [{ path: paths[0] }]; });
    window = new BrowserWindow({ show: false, webPreferences: {
      preload: path.resolve(__dirname, "../dist-electron/electron/preload.cjs"),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    } });
    await window.loadURL("data:text/html,<input id='file' type='file'>");
    window.webContents.debugger.attach("1.3");
    const { root } = await window.webContents.debugger.sendCommand("DOM.getDocument");
    const { nodeId } = await window.webContents.debugger.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: "#file" });
    await window.webContents.debugger.sendCommand("DOM.setFileInputFiles", { nodeId, files: [original] });
    const returned = await window.webContents.executeJavaScript(`(async () => {
      const path = window.piDesktop.getDroppedFilePath(document.querySelector('#file').files[0]);
      const result = await window.piDesktop.attachFilePaths([path]);
      return { path, attachment: result[0] };
    })()`);
    assert.equal(returned.path, original);
    assert.deepEqual(received, [original]);
    assert.equal(returned.attachment.path, original);
    console.log("Electron File → preload → IPC original path verified");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    window?.destroy();
    if (folder) await rm(folder, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});
