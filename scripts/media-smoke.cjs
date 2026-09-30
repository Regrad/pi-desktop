const { app, BrowserWindow, protocol } = require("electron");
const { mkdtemp, writeFile, mkdir, rm } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
protocol.registerSchemesAsPrivileged([{ scheme: "pi-generated", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.whenReady().then(async () => {
  let folder, window;
  try {
    folder = await mkdtemp(path.join(os.tmpdir(), "pi-media-smoke-"));
    await mkdir(path.join(folder, "music-generation"));
    const wav = Buffer.alloc(44 + 16000);
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write("data", 36); wav.writeUInt32LE(16000, 40);
    await writeFile(path.join(folder, "music-generation", "test.wav"), wav);
    const { generatedMediaResponse } = await import("../dist-electron/electron/generated-media.js");
    protocol.handle("pi-generated", request => generatedMediaResponse(folder, request));
    window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await window.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27self%27; media-src pi-generated:"><audio id="track" controls></audio>');
    const result = await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const audio = document.getElementById("track");
      const timeout = setTimeout(() => reject(new Error("Audio loading timeout")), 10000);
      audio.onerror = () => reject(new Error("Audio error: " + audio.error.code));
      audio.onloadedmetadata = () => { audio.currentTime = 0.5; };
      audio.onseeked = () => { clearTimeout(timeout); resolve({ duration: audio.duration, position: audio.currentTime }); };
      audio.src = "pi-generated://music/test.wav";
    })`);
    assert.equal(result.duration, 1); assert.equal(result.position, 0.5);
    console.log("Electron CSP, local audio decoding and seeking verified");
  } catch (error) {
    console.error(error); process.exitCode = 1;
  } finally {
    window?.destroy();
    if (folder) await rm(folder, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});
