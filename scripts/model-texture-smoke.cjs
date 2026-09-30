const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { readFileSync } = require("node:fs");

// Runs source Three.js modules in Chromium under the app's actual CSP, without a build.
const root = path.resolve(__dirname, "..");
const model = process.env.PI_TEST_MODEL;
if (!model) throw new Error("Set PI_TEST_MODEL to a local textured GLB");
const csp = readFileSync(path.join(root, "index.html"), "utf8").match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
const html = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp.replace("script-src 'self'", "script-src 'self' 'nonce-probe'")}"><script type="importmap" nonce="probe">{"imports":{"three":"/three/build/three.module.js"}}</script><script type="module" src="/probe.js"></script>`;
const probe = `
import * as THREE from 'three';
import { GLTFLoader } from '/three/examples/jsm/loaders/GLTFLoader.js';
window.probe = async (useHandler) => {
  const manager = new THREE.LoadingManager();
  const failures = [];
  manager.onError = url => failures.push(url);
  manager.setURLModifier(url => {
    if (!url.startsWith('blob:') && !url.startsWith('data:')) throw new Error('External resource');
    return url;
  });
  const loader = new GLTFLoader(manager);
  if (useHandler) loader.register(parser => {
    parser.textureLoader = new THREE.TextureLoader(manager);
    return { name: 'PI_embedded_textures' };
  });
  const buffer = await (await fetch('/model.glb')).arrayBuffer();
  const gltf = await loader.parseAsync(buffer, '');
  const maps = [];
  const textures = new Set();
  gltf.scene.traverse(object => {
    if (!object.isMesh) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      maps.push({ color: !!material.map, width: material.map?.image?.width });
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
      material.dispose();
    }
    object.geometry.dispose();
  });
  for (const texture of textures) { texture.image?.close?.(); texture.dispose(); }
  return { maps, failures: failures.length };
};`;

const server = http.createServer((req, res) => {
  try {
    if (req.url === "/") { res.setHeader("Content-Type", "text/html"); return res.end(html); }
    if (req.url === "/probe.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(probe); }
    if (req.url === "/model.glb") return res.end(readFileSync(model));
    if (req.url.startsWith("/three/")) {
      const base = path.join(root, "node_modules", "three");
      const file = path.resolve(base, req.url.slice(7));
      if (!file.startsWith(base + path.sep)) throw new Error("Invalid module path");
      res.setHeader("Content-Type", "text/javascript");
      return res.end(readFileSync(file));
    }
    res.writeHead(404); res.end();
  } catch { res.writeHead(500); res.end(); }
});

app.whenReady().then(async () => {
  let window;
  let exitCode = 0;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await window.loadURL(`http://127.0.0.1:${server.address().port}/`);
    await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      function ready() { if (window.probe) resolve(); else if (Date.now() > deadline) reject(new Error('Probe failed to load')); else setTimeout(ready, 20); }
      ready();
    })`);
    const broken = await window.webContents.executeJavaScript("window.probe(false)");
    assert.ok(broken.failures > 0 && broken.maps.every(material => !material.color), "Original loader reproduces missing textures under CSP");
    const fixed = await window.webContents.executeJavaScript("window.probe(true)");
    assert.equal(fixed.failures, 0);
    assert.ok(fixed.maps.length > 0 && fixed.maps.every(material => material.color && material.width > 0), "Embedded color textures decode successfully");
    console.log(JSON.stringify({ original: broken, fixed }));
  } catch (error) { exitCode = 1; console.error(error); }
  finally { window?.destroy(); server.close(); app.exit(exitCode); }
});
