import { useEffect, useRef, useState } from "react";
import { DEFAULT_COMFY_SETTINGS, type ComfyMode, type ComfySettings, type ComfyWorkflowSummary, type ComfyWorkflowInspection } from "../shared/comfy";

export function ComfySettingsPanel() {
  const [settings, setSettings] = useState<ComfySettings>(structuredClone(DEFAULT_COMFY_SETTINGS));
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [checking, setChecking] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState("");
  const [catalog, setCatalog] = useState<ComfyWorkflowSummary>();
  const [inspection, setInspection] = useState<ComfyWorkflowInspection>();
  const [query, setQuery] = useState("");
  const [libraryBusy, setLibraryBusy] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const librarySequence = useRef(0);
  useEffect(() => () => { librarySequence.current++; }, []);
  function updateConnection(next: ComfySettings) {
    librarySequence.current++;
    setCatalog(undefined); setInspection(undefined); setLibraryError("");
    setSettings(next);
  }
  async function loadLibrary(offset = 0) {
    const sequence = ++librarySequence.current;
    setLibraryBusy(true); setLibraryError(""); setInspection(undefined); setCatalog(undefined);
    try {
      const saved = await window.piDesktop.saveComfySettings(settings);
      if (sequence !== librarySequence.current) return;
      setSettings(saved);
      const result = await window.piDesktop.listComfyWorkflows(query, offset);
      if (sequence === librarySequence.current) setCatalog(result);
    } catch (error) { if (sequence === librarySequence.current) setLibraryError(String(error)); }
    finally { if (sequence === librarySequence.current) setLibraryBusy(false); }
  }
  async function inspect(id: string) {
    const sequence = ++librarySequence.current;
    setLibraryBusy(true); setLibraryError(""); setInspection(undefined);
    try {
      const result = await window.piDesktop.inspectComfyWorkflow(id);
      if (sequence === librarySequence.current) setInspection(result);
    } catch (error) { if (sequence === librarySequence.current) setLibraryError(String(error)); }
    finally { if (sequence === librarySequence.current) setLibraryBusy(false); }
  }
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
    <p className="settings-description">Изображения, музыка YuE2 и 3D-модели на вашем компьютере или сервере локальной сети.</p>
    <fieldset disabled={loading || busy || checking || libraryBusy} style={{ border: 0, padding: 0, margin: 0 }}>
      <div className="settings-card" style={{ padding: 16 }}>
        <label><input type="checkbox" checked={settings.enabled} onChange={(e) => updateConnection({ ...settings, enabled: e.target.checked })} /> Разрешить модели пользоваться ComfyUI</label>
        <label style={{ display: "block", marginTop: 16 }}>Адрес сервера
          <input style={{ width: "100%", boxSizing: "border-box", marginTop: 6 }} value={settings.url} onChange={(e) => updateConnection({ ...settings, url: e.target.value })} placeholder="http://127.0.0.1:8188" />
        </label>
        <button style={{ marginTop: 12 }} onClick={() => void checkConnection()}>{checking ? "Проверяю…" : "Проверить подключение"}</button>
        {connectionStatus && <p role="status" aria-live="polite" style={{ margin: "10px 0 0", overflowWrap: "anywhere" }}>{connectionStatus}</p>}
      </div>
      <h2>Библиотека воркфлоу</h2>
      <div className="settings-card" style={{ padding: 16 }}>
        <p className="muted">Сохраните workflow в ComfyUI — модель найдёт его, изучит параметры и выберет способ выполнения запроса. Графы редактора и Export (API) поддерживаются без отдельных инструментов и шаблонных подстановок.</p>
        <div style={{ display: "flex", gap: 8 }}>
          <input aria-label="Поиск воркфлоу" value={query} onChange={e => setQuery(e.target.value)} placeholder="Поиск по названию" style={{ flex: 1, minWidth: 0 }} />
          <button disabled={!settings.enabled} onClick={() => void loadLibrary()}>{libraryBusy ? "Изучаю…" : "Обновить библиотеку"}</button>
        </div>
        <p className="muted">Обновление библиотеки сохраняет текущие настройки подключения. Генерация при этом не запускается.</p>
        {catalog && <>
          <p>Найдено: {catalog.total}</p>
          {catalog.warnings.map(warning => <p role="status" key={warning}>{warning}</p>)}
          {catalog.items.map(item => <div key={item.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, borderTop: "1px solid var(--border)", padding: "10px 0", overflowWrap: "anywhere" }}>
            <div><strong>{item.name}</strong><div className="muted">{item.source === "server" ? "ComfyUI" : "Локальная папка"}</div></div>
            <button onClick={() => void inspect(item.id)}>Параметры</button>
          </div>)}
          <button onClick={() => void loadLibrary()}>В начало</button>{" "}
          {catalog.nextOffset !== null && <button onClick={() => void loadLibrary(catalog.nextOffset!)}>Следующая страница</button>}
        </>}
        {inspection && <section style={{ marginTop: 16, overflowWrap: "anywhere" }}>
          <h3>{inspection.workflow.name}</h3>
          <p className="muted">{inspection.format === "editor" ? "Штатный экспорт графа редактора" : "API-граф"} · узлов: {inspection.nodes.length} · параметров: {inspection.parameters.total}</p>
          {inspection.problems.map(problem => <p role="alert" key={problem}>{problem}</p>)}
          <dl>{inspection.parameters.items.map(parameter => <div key={`${parameter.node}/${parameter.input}`} style={{ marginBottom: 10 }}>
            <dt><code>{parameter.node}.{parameter.input}</code> · {String(parameter.type)}</dt>
            <dd style={{ marginLeft: 0 }}><code>{JSON.stringify(parameter.current) ?? "Не задано"}</code>{parameter.choices && <div className="muted">Варианты: {parameter.choices.map(String).join(", ")}{(parameter.choicesTotal ?? 0) > parameter.choices.length ? "…" : ""}</div>}</dd>
          </div>)}</dl>
          {inspection.parameters.nextOffset !== null && <p className="muted">Показана первая страница. Все параметры доступны модели через постраничное чтение.</p>}
        </section>}
        {libraryBusy && <p role="status" aria-live="polite"><span className="spinner" /> Получаю сведения ComfyUI…</p>}
        {libraryError && <p role="alert">{libraryError}</p>}
        <details style={{ marginTop: 12 }}><summary>Дополнительные локальные папки</summary>
          <p className="muted">Необязательно. По одному абсолютному пути на строку. На сервере автоматически читается папка workflows выбранного пользователя ComfyUI.</p>
          <textarea aria-label="Папки воркфлоу" style={{ width: "100%", boxSizing: "border-box" }} value={(settings.workflowFolders ?? []).join("\n")} onChange={e => updateConnection({ ...settings, workflowFolders: e.target.value.split(/\r?\n/).filter(line => line.trim()) })} />
        </details>
      </div>
      <details><summary>Встроенные профили и прежние настройки — дополнительно</summary>
      <h2>Профили</h2>
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
      <p className="muted">ComfyUI нужно запустить заранее. Изображения сохраняются в image-generation, треки и редактируемые нотные планы ABC — в music-generation, модели — в 3d-generation внутри папки данных Pi Desktop. Модель может получать отчёты по ABC и отдельно планировать музыку до создания звука, но не прослушивает музыку и не видит геометрию GLB. В чате доступны предпросмотр, проигрыватель, интерактивный 3D-просмотр и открытие файла в проводнике. Вложения не копируются. При отмене удаляется только наше задание из очереди; уже запущенная генерация может завершиться в ComfyUI.</p>
      <p className="muted">Встроенные workflows работают локально. Облачные API-узлы ComfyUI запрещены. Импортируйте только доверенные workflows и custom nodes: произвольные сторонние узлы могут самостоятельно обращаться в интернет.</p>
      </details>
      <button className="primary" onClick={() => void action(async () => {
        setSettings(await window.piDesktop.saveComfySettings(settings));
        return "Сохранено. Настройки действуют при следующем вызове инструмента.";
      })}>Сохранить</button>
    </fieldset>
    {status && <p role="status">{status}</p>}
  </>;
}
