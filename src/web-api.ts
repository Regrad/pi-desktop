import type { PiDesktopApi, Attachment } from "../shared/types";

/** Reuses the chat UI, with a separate authenticated browser transport. */
export async function installWebApi(): Promise<boolean> {
  if (window.piDesktop) return true;
  if (location.protocol !== "https:") {
    document.body.textContent = "Веб-доступ Pi Desktop работает только через HTTPS.";
    return false;
  }
  const response = await fetch("/api/session", { cache: "no-store" });
  if (!response.ok) { location.replace("/"); return false; }
  const session = await response.json() as { csrf: string; localEnabled: boolean; remoteEnabled: boolean; remoteReady: boolean; fingerprint: string; url: string; device?: { id: string; name: string; connected: boolean } };
  const request = async (endpoint: string) => {
    const result = await fetch(endpoint, { method: "POST", headers: { "X-Pi-CSRF": session.csrf } });
    const value = await result.json(); if (!result.ok) throw new Error(value.error || "Не удалось выполнить запрос"); return value;
  };
  const connect = async () => {
    const pair = await request("/api/device/pair");
    const uri = `pi-desktop-agent://connect?server=${encodeURIComponent(pair.url + "/")}&fingerprint=${encodeURIComponent(pair.fingerprint)}&token=${pair.token}`;
    const link = document.createElement("a"); link.href = uri; link.click();
    // This polls connection state only; it never repeats a command or prompt.
    const deadline = Date.now() + 120000;
    const poll = async () => {
      if (Date.now() > deadline) return;
      try { const state = await (await fetch("/api/session", { cache: "no-store" })).json(); if (state.device?.connected) { sessionStorage.setItem("pi-web-mode", "remote"); location.reload(); return; } }
      catch { return; }
      setTimeout(() => void poll(), 1500);
    };
    setTimeout(() => void poll(), 1000);
  };
  let selected = sessionStorage.getItem("pi-web-mode");
  if (!["local", "remote"].includes(selected ?? "")) selected = null;
  if (selected === "local" && !session.localEnabled || selected === "remote" && !session.remoteEnabled) selected = null;
  if (!selected && session.localEnabled && !session.remoteEnabled) selected = "local";
  if (!selected && !session.localEnabled && session.remoteEnabled) selected = "remote";
  const mode = selected === "remote" ? "remote" : "local";
  const action = (parent: HTMLElement, title: string, callback: () => void) => { const button = document.createElement("button"); button.textContent = title; button.onclick = callback; parent.append(button); return button; };
  if (!selected || mode === "remote" && !session.device) {
    const panel = document.createElement("main"); panel.style.cssText = "max-width:600px;margin:10vh auto;font:16px system-ui;display:grid;gap:16px;padding:24px";
    const heading = document.createElement("h1"); heading.textContent = "Pi Desktop — где работать?"; panel.append(heading);
    if (session.localEnabled) action(panel, "Компьютер Pi Desktop и его чаты", () => { sessionStorage.setItem("pi-web-mode", "local"); location.reload(); });
    if (session.remoteEnabled) {
      const note = document.createElement("p"); note.textContent = "Для управления этим ПК один раз скачайте и запустите помощник. После установки он запускается кнопкой ниже. Чаты этого ПК будут храниться отдельно на сервере."; panel.append(note);
      const download = document.createElement("a"); download.href = "/api/device/helper"; download.textContent = "Скачать помощник для Windows x64"; download.setAttribute("download", "Pi Desktop Agent.exe"); panel.append(download);
      action(panel, "Подключить управление этого ПК", () => void connect().catch(error => alert(String(error)))).disabled = !session.remoteReady;
      if (!session.remoteReady) { const status = document.createElement("p"); status.textContent = "Помощник ещё не собран в этой версии приложения."; panel.append(status); }
    }
    action(panel, "Выйти", () => void request("/api/logout").then(() => location.replace("/")));
    document.body.replaceChildren(panel); return false;
  }
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const uploaded = new Map<string, Attachment>();
  const events = new EventSource(`/api/events?mode=${mode}`);
  let opened = false, interrupted = false;
  events.onopen = () => { if (opened && interrupted) location.reload(); opened = true; };
  events.onerror = () => { interrupted = true; };
  events.onmessage = event => {
    const { channel, payload } = JSON.parse(event.data) as { channel: string; payload: unknown };
    listeners.get(channel)?.forEach(listener => listener(payload));
  };
  const rpc = async (method: string, args: unknown[] = []): Promise<unknown> => {
    if (["sendPrompt", "queuePrompt", "setGoal"].includes(method) && Array.isArray(args[2])) {
      args = [...args];
      args[2] = await Promise.all((args[2] as Attachment[]).map(async attachment => {
        if (!attachment.path.startsWith("clipboard:") || !attachment.data) return attachment;
        let saved = uploaded.get(attachment.id);
        if (!saved) {
          saved = await rpc("uploadAttachment", [{ name: attachment.name, data: attachment.data }]) as Attachment;
          if (uploaded.size > 200) uploaded.clear();
          uploaded.set(attachment.id, saved);
        }
        return { ...saved, id: attachment.id, maskFor: attachment.maskFor };
      }));
    }
    const result = await fetch("/api/rpc", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Pi-CSRF": session.csrf },
      body: JSON.stringify({ mode, method, args }),
    });
    if (result.status === 401) { events.close(); location.replace("/"); throw new Error("Сессия завершена. Войдите снова."); }
    const body = await result.json() as { result?: unknown; error?: string };
    if (!result.ok) throw new Error(body.error || "Не удалось выполнить запрос");
    return body.result;
  };
  const subscribe = (channel: string, listener: (value: unknown) => void) => {
    const group = listeners.get(channel) ?? new Set();
    group.add(listener); listeners.set(channel, group);
    return () => { group.delete(listener); };
  };
  const chooseAttachments = (): Promise<Attachment[]> => new Promise(resolve => {
    const input = document.createElement("input");
    input.type = "file"; input.multiple = true;
    input.oncancel = () => resolve([]);
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      try { resolve(await Promise.all(files.map(file => upload(file)))); }
      catch (error) { alert(error instanceof Error ? error.message : String(error)); resolve([]); }
    };
    input.click();
  });
  const upload = async (file: File): Promise<Attachment> => {
    if (file.size > 8 * 1024 * 1024) throw new Error("Вложение должно быть не больше 8 МБ");
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1]);
      reader.onerror = reject; reader.readAsDataURL(file);
    });
    return await rpc("uploadAttachment", [{ name: file.name, data }]) as Attachment;
  };
  window.piDesktop = new Proxy({ webClient: true }, {
    get(_target, name: string) {
      if (name === "webClient") return true;
      if (name === "webMode") return mode;
      if (name === "getGeneratedMediaUrl") return (kind: string, filename: string) => `/api/media/${kind}/${encodeURIComponent(filename)}?mode=${mode}`;
      if (name === "getDroppedFilePath") return () => "";
      if (name === "chooseAttachments") return mode === "remote" ? () => rpc("chooseAttachments") : chooseAttachments;
      if (name === "onPiEvent") return (listener: (value: unknown) => void) => subscribe("pi:event", listener);
      if (name === "onExtensionUi") return (listener: (value: unknown) => void) => subscribe("pi:extension-ui", listener);
      if (name === "onConversationChanged") return (listener: (value: unknown) => void) => subscribe("desktop:conversation-changed", listener);
      if (name === "onControlSelect") return () => () => {};
      if (name === "controlSelectionReady") return () => {};
      if (name === "showGeneratedFile") return async (kind: string, filename: string) => {
        const anchor = document.createElement("a");
        anchor.href = `/api/media/${kind}/${encodeURIComponent(filename)}?mode=${mode}`; anchor.download = filename.split("/").pop()!; anchor.click();
      };
      if (name === "showItemInFolder") return mode === "remote" ? (...args: unknown[]) => rpc(name, args) : async () => { throw new Error("В браузере используйте скачивание файла."); };
      if (name === "showGeneratedOnClient") return (kind: string, filename: string) => rpc("showGeneratedFile", [kind, filename]);
      if (name === "getWebAccessSettings") return async () => { throw new Error("Настройки доступа меняются в Pi Desktop."); };
      return (...args: unknown[]) => rpc(name, args);
    },
  }) as PiDesktopApi;
  const controls = document.createElement("div"); controls.style.cssText = "position:fixed;top:4px;right:8px;z-index:10000;font:12px system-ui;display:flex;gap:6px;background:var(--surface,#fff);padding:4px";
  const status = document.createElement("span"); status.textContent = mode === "local" ? "ПК Pi Desktop" : `${session.device!.name} · ${session.device!.connected ? "Подключён" : "Отключён"}`; controls.append(status);
  if (mode === "remote") subscribe("web:device", value => { const state = value as { connected: boolean; reason?: string }; status.textContent = `${session.device!.name} · ${state.connected ? "Подключён" : "Отключён"}`; status.title = state.reason ?? ""; });
  if (session.localEnabled && session.remoteEnabled) action(controls, "Сменить режим", () => { sessionStorage.removeItem("pi-web-mode"); events.close(); location.reload(); });
  if (mode === "remote") {
    action(controls, "Подключить ПК", () => void connect().catch(error => alert(String(error)))).disabled = !session.remoteReady;
    action(controls, "Отключить", () => void request("/api/device/disconnect").then(() => { events.close(); location.reload(); }));
  }
  action(controls, "Выйти", () => void request("/api/logout").then(() => { events.close(); location.replace("/"); }));
  document.body.append(controls);
  return true;
}
