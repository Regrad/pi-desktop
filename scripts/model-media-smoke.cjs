// Exercise Chromium's real CORS/CSP handling without building the project.
const { app, BrowserWindow, protocol } = require("electron");
const { mkdtemp, writeFile, mkdir, rm } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
protocol.registerSchemesAsPrivileged([{ scheme: "pi-generated", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
app.whenReady().then(async () => {
  let folder, window;
  try {
    folder = await mkdtemp(path.join(os.tmpdir(), "pi-model-media-smoke-"));
    await mkdir(path.join(folder, "3d-generation"));
    await writeFile(path.join(folder, "3d-generation", "test.glb"), Buffer.from("glTF-test"));
    const { generatedMediaResponse } = await import("../electron/generated-media.ts");
    protocol.handle("pi-generated", request => generatedMediaResponse(folder, request));
    window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await window.loadURL('data:text/html,<meta http-equiv="Content-Security-Policy" content="default-src %27self%27; connect-src pi-generated:">');
    const result = await window.webContents.executeJavaScript(`fetch("pi-generated://model3d/test.glb").then(async response => ({status: response.status, mime: response.headers.get("content-type"), body: await response.text()}))`);
    assert.deepEqual(result, { status: 200, mime: "model/gltf-binary", body: "glTF-test" });
    const threeUrl = pathToFileURL(path.resolve(__dirname, "../node_modules/three/build/three.module.js")).href;
    const addons = pathToFileURL(path.resolve(__dirname, "../node_modules/three/examples/jsm/") + path.sep).href;
    const html = path.join(folder, "viewer.html");
    await writeFile(html, `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; connect-src 'self' pi-generated:; img-src 'self' data: blob:"><script type="importmap">${JSON.stringify({ imports: { three: threeUrl } })}</script>`);
    await window.loadFile(html);
    const engine = await window.webContents.executeJavaScript(`(async () => {
      const THREE = await import(${JSON.stringify(threeUrl)});
      const { GLTFLoader } = await import(${JSON.stringify(addons + "loaders/GLTFLoader.js")});
      const { OrbitControls } = await import(${JSON.stringify(addons + "controls/OrbitControls.js")});
      const response = await fetch("pi-generated://model3d/test.glb");
      if (response.status !== 200) throw new Error("Portable model fetch failed from file origin");
      const renderer = new THREE.WebGLRenderer({antialias: true}); renderer.setSize(320, 240);
      document.body.appendChild(renderer.domElement);
      const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(40, 4/3, 0.01, 100);
      const gltf = await new GLTFLoader().parseAsync(JSON.stringify({asset:{version:"2.0"},scenes:[{nodes:[0]}],scene:0,nodes:[{}]}), "");
      scene.add(gltf.scene);
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial({color:0x44aa66}));
      scene.add(mesh); camera.position.set(2, 2, 3);
      const controls = new OrbitControls(camera, renderer.domElement); controls.update(); controls.saveState();
      const initial = camera.position.clone();
      renderer.domElement.dispatchEvent(new WheelEvent("wheel", {deltaY:100, bubbles:true, cancelable:true}));
      const zoomed = camera.position.distanceTo(controls.target) !== initial.length();
      controls.reset(); renderer.render(scene, camera);
      const reset = camera.position.distanceTo(initial) < 0.0001;
      controls.dispose(); mesh.geometry.dispose(); mesh.material.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
      return { zoomed, reset, parsed: gltf.scene.children.length === 1 };
    })()`);
    assert.deepEqual(engine, { zoomed: true, reset: true, parsed: true });
    console.log("Electron local model fetch, CORS and CSP verified without compilation");
    console.log("Bundled Three.js, GLTFLoader, WebGL rendering, OrbitControls zoom/reset and cleanup verified");
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally {
    window?.destroy();
    if (folder) await rm(folder, { recursive: true, force: true });
    app.exit(process.exitCode || 0);
  }
});
