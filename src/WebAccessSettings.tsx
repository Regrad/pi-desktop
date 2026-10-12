import { useEffect, useState } from "react";
import type { WebAccessStatus } from "../shared/web-access";

export function WebAccessSettingsPanel() {
  const [settings, setSettings] = useState<WebAccessStatus>();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (window.piDesktop.webClient) return;
    void window.piDesktop.getWebAccessSettings().then(setSettings).catch(error => setMessage(String(error)));
  }, []);
  if (window.piDesktop.webClient) return <><h1>Веб-доступ</h1><p>Настройки доступа меняются только в приложении на компьютере Pi Desktop.</p></>;
  if (!settings) return <><h1>Веб-доступ</h1><p role="status">{message || "Загрузка…"}</p></>;
  const save = async (renewCertificate = false) => {
    setBusy(true); setMessage("");
    try {
      const result = await window.piDesktop.saveWebAccessSettings({
        localEnabled: settings.localEnabled, remoteEnabled: settings.remoteEnabled,
        address: settings.address, port: settings.port, username: settings.username, password, renewCertificate,
      });
      setSettings(result); setPassword("");
      setMessage(result.error || (result.running ? "HTTPS-доступ включён. Проверьте проброс порта и брандмауэр." : "Веб-доступ выключен."));
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <>
    <h1>Веб-доступ</h1>
    <p>Встроенный HTTPS. Сертификат создаётся самим Pi Desktop — отдельные программы и выдача сертификата не нужны.</p>
    <div className="settings-card" style={{ padding: 20, display: "grid", gap: 16 }}>
      <label><input type="checkbox" checked={settings.localEnabled} disabled={busy} onChange={e => setSettings({ ...settings, localEnabled: e.target.checked })} /> Локальный режим — компьютер Pi Desktop и его чаты</label>
      <label><input type="checkbox" checked={settings.remoteEnabled} disabled={busy} onChange={e => setSettings({ ...settings, remoteEnabled: e.target.checked })} /> Удалённый режим — компьютер, где открыт браузер</label>
      {!settings.remoteReady && <small>Клиентский помощник отсутствует в этой сборке. Он включается в релиз при упаковке приложения.</small>}
      <label>Домен или IP<input style={{ display: "block", width: "100%" }} value={settings.address} disabled={busy} onChange={e => setSettings({ ...settings, address: e.target.value })} placeholder="pikawow.fun или выделенный IP" /></label>
      <label>Порт<input type="number" min="1024" max="65535" style={{ display: "block" }} value={settings.port} disabled={busy} onChange={e => setSettings({ ...settings, port: Number(e.target.value) })} /></label>
      <label>Логин<input autoComplete="off" style={{ display: "block" }} value={settings.username} disabled={busy} onChange={e => setSettings({ ...settings, username: e.target.value })} /></label>
      <label>{settings.passwordConfigured ? "Новый пароль (пусто — оставить текущий)" : "Пароль"}<input type="password" autoComplete="new-password" style={{ display: "block" }} value={password} disabled={busy} onChange={e => setPassword(e.target.value)} placeholder="Не менее 12 символов" /></label>
      <button disabled={busy} onClick={() => void save()}>{busy ? "Применение…" : "Сохранить"}</button>
      {(settings.localEnabled || settings.remoteEnabled) && <button disabled={busy} onClick={() => {
        if (confirm("Создать новый сертификат? Его отпечаток изменится. На всех клиентах потребуется сверить новый отпечаток и подтвердить доверие заново.")) void save(true);
      }}>Создать новый сертификат</button>}
      <p role="status">{message || settings.error}</p>
    </div>
    {settings.fingerprint && <div className="settings-card" style={{ padding: 20 }}>
      <p>Адрес: <a href={settings.url} target="_blank" rel="noreferrer">{settings.url}</a></p>
      <p>Отпечаток сертификата SHA-256:</p><code style={{ overflowWrap: "anywhere" }}>{settings.fingerprint}</code>
      <p>Действует до: {new Date(settings.validTo).toLocaleDateString()}</p>
      <p>Перед вводом пароля сверяйте этот отпечаток с сертификатом в браузере. Не подтверждайте неизвестный сертификат.</p>
    </div>}
    <p>Если браузер запрещает исключение из-за HSTS домена, используйте выделенный IP в поле адреса. Изменение адреса создаёт новый сертификат: его потребуется сверить заново.</p>
    <p>Порт пробрасывается только на этот компьютер. Локальный API управления, модель и ComfyUI наружу не открываются.</p>
  </>;
}
