import { t } from "./i18n";
import { lazy, Suspense, useState } from "react";
import { PreviewImage } from "./ImagePreview";
import { generatedMediaReference } from "../shared/generated-links";
const ModelViewer = lazy(() => import("./ModelViewer"));

function GeneratedAsset({ part }: { part: Record<string, unknown> }) {
  const [error, setError] = useState("");
  const [openModel, setOpenModel] = useState(!window.piDesktop.webClient);
  const filename = typeof part.path === "string" ? part.path.split(/[\\/]/).pop() : undefined;
  const reference = typeof part.path === "string" ? generatedMediaReference(part.path) : undefined;
  const music = part.type === "audio";
  const model = part.type === "model3d";
  const video = part.type === "video";
  const kind = model ? "model3d" : music ? "music" : video ? "video" : part.type === "file" ? "artifact" : "image";
  const source = music || video
    ? reference && (window.piDesktop.webClient ? window.piDesktop.getGeneratedMediaUrl!(kind, reference) : `pi-generated://${kind}/${encodeURIComponent(reference)}`)
    : typeof part.data === "string" ? `data:${part.mimeType};base64,${part.data}` : undefined;
  return <div className="generated-asset">
    {model ? reference && (openModel ? <Suspense fallback={<p>{t("Загрузка просмотра 3D…")}</p>}><ModelViewer source={window.piDesktop.webClient ? window.piDesktop.getGeneratedMediaUrl!("model3d", reference) : `pi-generated://model3d/${encodeURIComponent(reference)}`} /></Suspense> : <button onClick={() => setOpenModel(true)}>{t("Открыть 3D")}</button>)
      : music ? source && <audio className="content-audio" src={source} controls preload={window.piDesktop.webClient ? "none" : "metadata"} onError={() => setError(t("Трек недоступен: проверьте файл в папке music-generation."))} />
      : video ? source && <video className="content-image" src={source} controls preload="metadata" onError={() => setError(t("Видеофайл недоступен."))} />
      : part.type === "file" ? <p>{filename}</p>
      : source && <PreviewImage className="content-image" src={source} alt={filename ?? t("Созданное изображение")} />}
    {filename && <div className="generated-asset-file" style={{ justifyContent: "flex-end" }}>{!reference && window.piDesktop.webClient && typeof part.data === "string"
      ? <a href={`data:${String(part.mimeType)};base64,${part.data}`} download={filename}>{t("Скачать")}</a>
      : <button onClick={() => void ((part.originalPath || !reference) && typeof part.path === "string" && !window.piDesktop.webClient ? window.piDesktop.showItemInFolder(part.path) : window.piDesktop.showGeneratedFile(kind, reference ?? filename)).catch(() => setError(t("Файл не найден в папке данных Pi Desktop.")))}>{window.piDesktop.webClient ? t("Скачать") : t("Показать в проводнике")}</button>}</div>}
    {reference && window.piDesktop.webMode === "remote" && <button onClick={() => void window.piDesktop.showGeneratedOnClient!(kind, reference).catch(error => setError(String(error)))}>{t("Показать в проводнике этого ПК")}</button>}
    {error && <small role="status">{error}</small>}
  </div>;
}

export function ComfyMedia({ parts }: { parts: Record<string, unknown>[] }) {
  return <>{parts.map((part, i) => <GeneratedAsset key={`${String(part.path ?? part.type)}-${i}`} part={part} />)}</>;
}
