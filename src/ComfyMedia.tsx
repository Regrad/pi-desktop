import { lazy, Suspense, useState } from "react";
import { PreviewImage } from "./ImagePreview";
const ModelViewer = lazy(() => import("./ModelViewer"));

function GeneratedAsset({ part }: { part: Record<string, unknown> }) {
  const [error, setError] = useState("");
  const [openModel, setOpenModel] = useState(!window.piDesktop.webClient);
  const filename = typeof part.path === "string" ? part.path.split(/[\\/]/).pop() : undefined;
  const music = part.type === "audio";
  const model = part.type === "model3d";
  const source = music
    ? filename && (window.piDesktop.webClient ? window.piDesktop.getGeneratedMediaUrl!("music", filename) : `pi-generated://music/${encodeURIComponent(filename)}`)
    : typeof part.data === "string" ? `data:${part.mimeType};base64,${part.data}` : undefined;
  return <div className="generated-asset">
    {model ? filename && (openModel ? <Suspense fallback={<p>Загрузка просмотра 3D…</p>}><ModelViewer source={window.piDesktop.webClient ? window.piDesktop.getGeneratedMediaUrl!("model3d", filename) : `pi-generated://model3d/${encodeURIComponent(filename)}`} /></Suspense> : <button onClick={() => setOpenModel(true)}>Открыть 3D</button>)
      : music ? source && <audio className="content-audio" src={source} controls preload={window.piDesktop.webClient ? "none" : "metadata"} onError={() => setError("Трек недоступен: проверьте файл в папке music-generation.")} />
      : source && <PreviewImage className="content-image" src={source} alt={filename ?? "Созданное изображение"} />}
    {filename && <div className="generated-asset-file" style={{ justifyContent: "flex-end" }}><button onClick={() => void (part.originalPath && typeof part.path === "string" && !window.piDesktop.webClient ? window.piDesktop.showItemInFolder(part.path) : window.piDesktop.showGeneratedFile(model ? "model3d" : music ? "music" : "image", filename)).catch(() => setError("Файл не найден в папке данных Pi Desktop."))}>{window.piDesktop.webClient ? "Скачать" : "Показать в проводнике"}</button></div>}
    {filename && window.piDesktop.webMode === "remote" && <button onClick={() => void window.piDesktop.showGeneratedOnClient!(model ? "model3d" : music ? "music" : "image", filename).catch(error => setError(String(error)))}>Показать в проводнике этого ПК</button>}
    {error && <small role="status">{error}</small>}
  </div>;
}

export function ComfyMedia({ parts }: { parts: Record<string, unknown>[] }) {
  return <>{parts.map((part, i) => <GeneratedAsset key={`${String(part.path ?? part.type)}-${i}`} part={part} />)}</>;
}
