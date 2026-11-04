import { useEffect, useState } from "react";
import { DEFAULT_COMFY_SETTINGS, type ComfyMode, type ComfySettings } from "../shared/comfy";

export function ComfySettingsPanel() {
  const [settings, setSettings] = useState<ComfySettings>(structuredClone(DEFAULT_COMFY_SETTINGS));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [checking, setChecking] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState("");
  useEffect(() => {
    let cancelled = false;
    void window.piDesktop.getComfySettings().then((value) => { if (!cancelled) setSettings(value); })
      .catch((error) => { if (!cancelled) setStatus(String(error)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  async function action(work: () => Promise<string>) {
    setBusy(true); setStatus("");
    try { setStatus(await work()); } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  async function checkConnection() {
    setChecking(true);
    setConnectionStatus("Проверяю подключение…");
    try {
      setConnectionStatus(`Подключено. ${await window.piDesktop.checkComfyConnection(settings.url)}`);
    } catch (error) {
      setConnectionStatus(`Не удалось подключиться: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setChecking(false);
    }
  }
  const profiles: { mode: ComfyMode; name: string; builtin: string }[] = [
    { mode: "generate", name: "Создание изображений", builtin: "Qwen Image 2.1" },
    { mode: "edit", name: "Редактирование и изображения-референсы", builtin: "Qwen Image 2.1 Edit" },
    { mode: "compose", name: "Новая сцена из референсов", builtin: "Qwen Image 2.1" },
    { mode: "inpaint", name: "Локальное редактирование по маске", builtin: "Qwen Image 2.1 + сохранение вне маски" },
    { mode: "outpaint", name: "Расширение холста", builtin: "Qwen Image 2.1 Outpaint" },
    { mode: "extract", name: "Извлечение объекта с прозрачностью", builtin: "Qwen Image 2.1 RGBA" },
    { mode: "remove_background", name: "Удаление фона и прозрачный PNG", builtin: "BiRefNet" },
    { mode: "music", name: "Генерация музыки", builtin: "YuE2 — расширенная генерация" },
    { mode: "music_cover", name: "Кавер по исходному аудио", builtin: "YuE2 — расширенный кавер" },
    { mode: "model3d", name: "3D по одному изображению", builtin: "Pixal3D / Trellis2" },
    { mode: "model3d_multiview", name: "3D по четырём ракурсам", builtin: "Pixal3D Multi-view" },
  ];
  return <>
    <h1>ComfyUI</h1>
    <p className="settings-description">Отдельные инструменты аддона для изображений, музыки, речи и 3D. Подготовка описаний не требуется.</p>
    <fieldset disabled={loading || busy || checking} style={{ border: 0, padding: 0, margin: 0 }}>
      <div className="settings-card" style={{ padding: 16 }}>
        <label><input type="checkbox" checked={settings.enabled} onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })} /> Разрешить модели пользоваться ComfyUI</label>
        <label style={{ display: "block", marginTop: 16 }}>Адрес сервера
          <input style={{ width: "100%", boxSizing: "border-box", marginTop: 6 }} value={settings.url} onChange={(e) => setSettings({ ...settings, url: e.target.value })} placeholder="http://127.0.0.1:8188" />
        </label>
        <button style={{ marginTop: 12 }} onClick={() => void checkConnection()}>{checking ? "Проверяю…" : "Проверить подключение"}</button>
        {connectionStatus && <p role="status" aria-live="polite" style={{ margin: "10px 0 0", overflowWrap: "anywhere" }}>{connectionStatus}</p>}
      </div>
      <h2>Workflows</h2>
      <div className="settings-card" style={{ padding: 16 }}>
        {profiles.map(({ mode, name, builtin }) => <div key={mode} style={{ marginBottom: 18 }}>
          <strong>{name}</strong>
          <div className="muted" style={{ margin: "6px 0" }}>{settings.workflows[mode] || `Встроенный: ${builtin}`}</div>
          <button onClick={() => void action(async () => {
            const selected = await window.piDesktop.importComfyWorkflow();
            if (selected) setSettings((current) => ({ ...current, workflows: { ...current.workflows, [mode]: selected } }));
            return selected ? "Workflow импортирован. Нажмите «Сохранить»." : "Выбор отменён.";
          })}>Импортировать API workflow</button>{" "}
          {settings.workflows[mode] && <button onClick={() => setSettings({ ...settings, workflows: { ...settings.workflows, [mode]: "" } })}>Использовать встроенный</button>}
        </div>)}
        <small>Для своих workflows экспортируйте JSON в формате API. Параметры: {"{{prompt}}, {{lyrics}}, {{duration}}, {{audio}}, {{abc}}, {{negative_prompt}}, {{width}}, {{height}}, {{seed}}, {{steps}}, {{count}}, {{cfg}}, {{denoise}}, {{reference_resolution}}, {{canvas_image}}, {{transparent_background}}, {{mask}}, {{mask_channel}}, {{invert_mask}}, {{mask_grow}}, {{mask_blur}}, {{padding_left}}, {{padding_top}}, {{padding_right}}, {{padding_bottom}}, {{feathering}}, {{image_1}} … {{image_10}}"}. Сохранённые модели и остальные параметры workflow используются без изменений. Сохранение области вне маски гарантирует встроенный workflow; собственный должен обеспечивать это сам.</small>
      </div>
      <h2>Встроенные workflows</h2>
      <p className="muted">SAM 3.1 создаёт маску объекта по описанию, точкам или рамкам. Модель проверяет маску и предпросмотр перед редактированием. Для простых геометрических областей можно использовать скрипт, для готовой пользовательской маски — само вложение.</p>
      <div className="settings-card" style={{ padding: 16 }}>
        {([
          ["diffusionModel", "Модель изображений"], ["textEncoder", "Текстовый энкодер"], ["vae", "VAE"], ["backgroundModel", "Модель удаления фона"],
          ["musicCheckpoint", "Модель музыки YuE2"], ["segmentationCheckpoint", "Модель выделения SAM 3.1"],
        ] as const).map(([key, label]) => <label key={key} style={{ display: "block", marginBottom: 12 }}>{label}
          <input style={{ display: "block", width: "100%", boxSizing: "border-box", marginTop: 6 }} value={settings[key]} onChange={(e) => setSettings({ ...settings, [key]: e.target.value })} />
        </label>)}
        <label>Шаги генерации <input type="number" min={1} max={100} value={settings.steps} onChange={(e) => setSettings({ ...settings, steps: Number(e.target.value) })} /></label>
        <label style={{ display: "block", marginTop: 12 }}>Шаги YuE2 <input type="number" min={1} max={100} value={settings.musicSteps} onChange={(e) => setSettings({ ...settings, musicSteps: Number(e.target.value) })} /></label>
      </div>
      <p className="muted">3D: одно изображение или четыре отдельных ракурса в порядке «спереди, слева, сзади, справа». Для текстового описания модель сначала создаёт изображение. Встроенные 3D-workflows сохраняют GLB с текстурами; параметры сэмплирования и обработки сетки сохранены из ваших workflows. Для собственного 3D-workflow нужен Save3DAdvanced и GLB со встроенными текстурами.</p>
      <p className="muted">Qwen: создание и редактирование RGBA, композиции до 10 референсов, перенос позы/одежды/стиля/объектов, надписи, маски и расширение холста. На миниатюре вложения нажмите «Маска»: кисть, ластик, отмена штриха и загрузка готовой маски. Белое — изменять, чёрное — сохранить. Маска передаётся из памяти, без папки input в Pi Desktop. Изображения публикуются вне свёрнутых инструментов, включая показ уже существующих файлов.</p>
      <p className="muted">ComfyUI нужно запустить заранее. Изображения сохраняются в image-generation, треки и редактируемые нотные планы ABC — в music-generation, модели — в 3d-generation в папке соответствующего чата. Модель может получать отчёты по ABC и отдельно планировать музыку до создания звука, но не прослушивает музыку и не видит геометрию GLB. В чате доступны предпросмотр, проигрыватель, интерактивный 3D-просмотр и открытие файла в проводнике. Вложения не копируются. При отмене удаляется только наше задание из очереди; уже запущенная генерация может завершиться в ComfyUI.</p>
      <p className="muted">Встроенные workflows работают локально. Облачные API-узлы ComfyUI запрещены. Импортируйте только доверенные workflows и custom nodes: произвольные сторонние узлы могут самостоятельно обращаться в интернет.</p>
      <button className="primary" onClick={() => void action(async () => {
        setSettings(await window.piDesktop.saveComfySettings(settings));
        return "Сохранено. Настройки действуют при следующем вызове инструмента.";
      })}>Сохранить</button>
    </fieldset>
    {status && <p role="status">{status}</p>}
  </>;
}
