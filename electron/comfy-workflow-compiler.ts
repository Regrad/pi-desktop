import { BrowserWindow, session } from "electron";
import { localComfyUrl } from "../shared/comfy.js";
import { loadComfySettings, validateGraph } from "./comfy-client.js";
import type { ApiGraph } from "../resources/pi-comfyui/lib/workflow-catalog.js";

// Runs in an isolated, disposable ComfyUI frontend, never in the user's editor.
// The frontend owns widget serialization, subgraphs and virtual/reroute nodes.
export const compileWorkflowScript = (workflow: Record<string, unknown>) => `
  (async () => {
    const { app } = await import('./scripts/app.js');
    const deadline = Date.now() + 15000;
    while (!app.graph || !app.canvas || app.vueAppReady === false) {
      if (Date.now() > deadline) throw new Error('ComfyUI frontend initialization timed out');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const loaded = await app.loadGraphData(${JSON.stringify(workflow)}, true, false, null,
      { skipAssetScans: true, silentAssetErrors: true, deferWarnings: true });
    if (loaded === false) throw new Error('ComfyUI could not load the workflow');
    const result = await app.graphToPrompt();
    if (!result?.output || !Object.keys(result.output).length) throw new Error('ComfyUI exported an empty API graph');
    return result.output;
  })()
`;

export class ComfyWorkflowCompiler {
  private readonly active = new Map<string, Set<BrowserWindow>>();
  private readonly epochs = new Map<string, number>();
  private readonly slots = new Set<number>();
  private closed = false;
  private readonly dataDir: string;
  constructor(dataDir: string) { this.dataDir = dataDir; }
  async compile(owner: string, workflow: Record<string, unknown>): Promise<ApiGraph> {
    const epoch = this.epochs.get(owner) ?? 0;
    if (this.closed) throw new Error("Экспорт ComfyUI остановлен");
    if (!workflow || !Array.isArray(workflow.nodes) || JSON.stringify(workflow).length > 8 * 1024 * 1024) throw new Error("Некорректный JSON редактора ComfyUI");
    const settings = await loadComfySettings(this.dataDir);
    if (!settings.enabled || this.closed || (this.epochs.get(owner) ?? 0) !== epoch) throw new Error("Экспорт ComfyUI отключён или отменён");
    const url = localComfyUrl(settings.url), origin = new URL(url).origin;
    const slot = [0, 1].find(slot => !this.slots.has(slot));
    if (slot === undefined) throw new Error("Два экспорта ComfyUI уже выполняются. Дождитесь результата и повторите изучение workflow.");
    const temporary = session.fromPartition(`pi-comfy-export-${slot}`, { cache: false });
    temporary.setPermissionCheckHandler(() => false);
    temporary.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    const denyDownload = (event: Electron.Event) => event.preventDefault();
    temporary.on("will-download", denyDownload);
    // The temporary page may read definitions and assets but cannot queue jobs,
    // write user workflows/settings, open windows or contact external services.
    temporary.webRequest.onBeforeRequest((details, callback) => {
      const target = new URL(details.url.replace(/^ws:/, "http:").replace(/^wss:/, "https:"));
      const allowed = details.method === "GET" && (target.origin === origin || /^(data|blob):/.test(details.url));
      callback({ cancel: !allowed });
    });
    const window = new BrowserWindow({ show: false, webPreferences: { session: temporary, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    this.slots.add(slot);
    const owners = this.active.get(owner) ?? new Set<BrowserWindow>();
    owners.add(window); this.active.set(owner, owners);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, destination) => { if (new URL(destination).origin !== origin) event.preventDefault(); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      window.once("closed", () => reject(new Error("Экспорт ComfyUI отменён")));
      timer = setTimeout(() => reject(new Error("ComfyUI не экспортировал workflow за 25 секунд. Проверьте доступность frontend и custom nodes.")), 25_000);
    });
    try {
      return await Promise.race([interrupted, (async () => {
        await window.loadURL(`${url}/`);
        return validateGraph(await window.webContents.executeJavaScript(compileWorkflowScript(workflow))) as ApiGraph;
      })()]);
    } finally {
      clearTimeout(timer);
      if (!window.isDestroyed()) window.destroy();
      owners.delete(window);
      if (!owners.size) this.active.delete(owner);
      temporary.webRequest.onBeforeRequest(null);
      temporary.off("will-download", denyDownload);
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = temporary.clearStorageData().catch(() => undefined).finally(() => this.slots.delete(slot));
      try { await Promise.race([cleanup, new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 2000); })]); }
      finally { clearTimeout(cleanupTimer); }
    }
  }
  cancel(owner: string) { this.epochs.set(owner, (this.epochs.get(owner) ?? 0) + 1); for (const window of this.active.get(owner) ?? []) if (!window.isDestroyed()) window.destroy(); }
  close() { this.closed = true; for (const owner of this.active.keys()) this.cancel(owner); }
}
