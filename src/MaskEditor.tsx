import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import type { Attachment } from "../shared/types";
type Stroke = { points: { x: number; y: number }[]; size: number; erase: boolean };

export function MaskEditor({ image, initialMask, onClose, onSave }: { image: Attachment; initialMask?: Attachment; onClose(): void; onSave(mask: Attachment): void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sourceImage = useRef<HTMLImageElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const base = useRef<HTMLCanvasElement | null>(null);
  const basePreview = useRef<HTMLCanvasElement | null>(null);
  const active = useRef<Stroke | null>(null);
  const [brush, setBrush] = useState(40);
  const [erase, setErase] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  function paint(context: CanvasRenderingContext2D, stroke: Stroke, preview: boolean) {
    context.globalCompositeOperation = preview && stroke.erase ? "destination-out" : "source-over";
    context.strokeStyle = context.fillStyle = stroke.erase ? "black" : preview ? "#ff4444" : "white";
    context.lineWidth = stroke.size; context.lineCap = context.lineJoin = "round";
    context.beginPath();
    const first = stroke.points[0]; if (!first) return;
    context.arc(first.x, first.y, stroke.size / 2, 0, Math.PI * 2); context.fill();
    context.beginPath(); context.moveTo(first.x, first.y);
    for (const point of stroke.points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke(); context.globalCompositeOperation = "source-over";
  }
  function redraw() {
    const element = canvas.current, context = element?.getContext("2d");
    if (!element || !context) return;
    context.clearRect(0, 0, element.width, element.height);
    if (basePreview.current) context.drawImage(basePreview.current, 0, 0);
    for (const stroke of strokes.current) paint(context, stroke, true);
  }
  async function loadMask(data: string, mimeType: string) {
    const bitmap = new Image(); bitmap.src = `data:${mimeType};base64,${data}`;
    await bitmap.decode();
    const element = canvas.current;
    if (!element) return;
    if (Math.abs(bitmap.naturalWidth / bitmap.naturalHeight - element.width / element.height) > 0.01) throw new Error("У маски должны быть те же пропорции, что и у изображения");
    const mask = document.createElement("canvas"); mask.width = element.width; mask.height = element.height;
    mask.getContext("2d")!.drawImage(bitmap, 0, 0, mask.width, mask.height);
    const preview = document.createElement("canvas"); preview.width = mask.width; preview.height = mask.height;
    const pixels = mask.getContext("2d")!.getImageData(0, 0, mask.width, mask.height);
    for (let i = 0; i < pixels.data.length; i += 4) { const value = Math.round(pixels.data[i] * pixels.data[i + 3] / 255); pixels.data[i] = 255; pixels.data[i + 1] = 68; pixels.data[i + 2] = 68; pixels.data[i + 3] = value; }
    preview.getContext("2d")!.putImageData(pixels, 0, 0);
    base.current = mask; basePreview.current = preview; strokes.current = []; redraw();
  }
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [onClose]);
  function initialize() {
    const img = sourceImage.current, element = canvas.current;
    if (!img || !element) return;
    if (img.naturalWidth > 4096 || img.naturalHeight > 4096) { setError("Редактирование по маске: максимум 4096 пикселей по стороне"); return; }
    element.width = img.naturalWidth; element.height = img.naturalHeight; setReady(true);
    if (initialMask?.data && initialMask.mimeType) void loadMask(initialMask.data, initialMask.mimeType).catch(failure => setError(String(failure)));
  }
  function point(event: PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * event.currentTarget.width / rect.width, y: (event.clientY - rect.top) * event.currentTarget.height / rect.height };
  }
  function save() {
    if (!canvas.current || !ready) return;
    const output = document.createElement("canvas"); output.width = canvas.current.width; output.height = canvas.current.height;
    const ctx = output.getContext("2d")!;
    ctx.fillStyle = "black"; ctx.fillRect(0, 0, output.width, output.height);
    if (base.current) ctx.drawImage(base.current, 0, 0);
    for (const stroke of strokes.current) paint(ctx, stroke, false);
    const pixels = ctx.getImageData(0, 0, output.width, output.height);
    let selected = false;
    for (let i = 0; i < pixels.data.length; i += 4) { const value = pixels.data[i]; pixels.data[i + 1] = pixels.data[i + 2] = value; pixels.data[i + 3] = 255; if (value) selected = true; }
    if (!selected) { setError("Выделите область для изменения"); return; }
    ctx.putImageData(pixels, 0, 0);
    const name = `${image.name.replace(/\.[^.]+$/, "")}-mask.png`;
    onSave({ id: crypto.randomUUID(), name, path: `clipboard:${name}`, mimeType: "image/png", data: output.toDataURL("image/png").split(",")[1], maskFor: image.id });
  }
  return <div className="mask-editor-overlay" role="dialog" aria-modal="true" aria-label="Редактор маски">
    <div className="mask-editor-dialog">
      <h2>Маска для {image.name}</h2>
      <p>Закрасьте область, которую нужно изменить. Остальное будет сохранено.</p>
      <div className="mask-editor-stage">
        <img ref={sourceImage} src={`data:${image.mimeType};base64,${image.data}`} onLoad={initialize} onError={() => setError("Изображение недоступно")} alt={image.name} />
        <canvas ref={canvas} onPointerDown={event => {
          if (!ready || event.button !== 0) return;
          event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
          const stroke = { points: [point(event)], size: brush, erase };
          active.current = stroke; strokes.current.push(stroke); redraw();
        }} onPointerMove={event => { if (active.current) { active.current.points.push(point(event)); redraw(); } }}
          onPointerUp={() => { active.current = null; }} onPointerCancel={() => { active.current = null; }} />
      </div>
      <div className="mask-editor-controls">
        <label>Кисть: {brush}px <input type="range" min={1} max={256} value={brush} onChange={event => setBrush(Number(event.target.value))} /></label>
        <button onClick={() => setErase(!erase)} aria-pressed={erase}>{erase ? "Ластик включён" : "Кисть включена"}</button>
        <button onClick={() => { strokes.current.pop(); redraw(); }}>Отменить штрих</button>
        <button onClick={() => { strokes.current = []; base.current = null; basePreview.current = null; redraw(); }}>Очистить</button>
        <button disabled={!ready} onClick={() => void window.piDesktop.chooseAttachments().then(files => {
          if (!files.length) return;
          const mask = files[0]; if (!mask?.data || !mask.mimeType?.startsWith("image/")) throw new Error("Выберите PNG, JPEG или WebP с чёрно-белой маской");
          return loadMask(mask.data, mask.mimeType);
        }).catch(failure => setError(String(failure)))}>Загрузить маску</button>
        <button disabled={!ready} onClick={save}>Прикрепить маску</button><button onClick={onClose}>Отмена</button>
      </div>
      {error && <p role="status">{error}</p>}
    </div>
  </div>;
}
