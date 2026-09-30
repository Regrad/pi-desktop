import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ImgHTMLAttributes, ReactNode } from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, RotateCcw, X } from "lucide-react";

type ImageSource = { src: string; alt: string };
type View = { zoom: number; x: number; y: number };
const initialView: View = { zoom: 1, x: 0, y: 0 };
const OpenImage = createContext<((image: ImageSource) => void) | null>(null);

export function PreviewImage(props: ImgHTMLAttributes<HTMLImageElement>) {
  const open = useContext(OpenImage);
  if (!open || typeof props.src !== "string") return <img {...props} />;
  const show = () => open({ src: props.src as string, alt: props.alt || "Изображение" });
  return <img {...props} role="button" tabIndex={0}
    className={`${props.className || ""} image-preview-trigger`}
    aria-label={`Открыть изображение: ${props.alt || "Изображение"}`}
    onClick={event => {
      props.onClick?.(event);
      if (event.defaultPrevented) return;
      event.preventDefault(); event.stopPropagation();
      event.currentTarget.focus({ preventScroll: true });
      show();
    }}
    onKeyDown={event => {
      props.onKeyDown?.(event);
      if (!event.defaultPrevented && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault(); event.stopPropagation(); show();
      }
    }} />;
}

function ImageDialog({ image, onClose }: { image: ImageSource; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(initialView);
  const [error, setError] = useState(false);
  const dragging = useRef<{ id: number; x: number; y: number } | null>(null);
  const liveView = useRef(view);
  liveView.current = view;

  const zoom = useCallback((factor: number, point?: { x: number; y: number }) => {
    setView(previous => {
      const next = Math.min(8, Math.max(0.25, previous.zoom * factor));
      const ratio = next / previous.zoom;
      const anchor = point || { x: 0, y: 0 };
      return { zoom: next, x: anchor.x - (anchor.x - previous.x) * ratio, y: anchor.y - (anchor.y - previous.y) * ratio };
    });
  }, []);

  useLayoutEffect(() => {
    const element = dialog.current!;
    const previousFocus = document.activeElement as HTMLElement | null;
    element.showModal();
    return () => {
      element.close();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const element = stage.current!;
    const wheel = (event: WheelEvent) => {
      event.preventDefault(); event.stopPropagation();
      const bounds = element.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
      zoom(Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.003), {
        x: event.clientX - bounds.left - bounds.width / 2,
        y: event.clientY - bounds.top - bounds.height / 2,
      });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [zoom]);

  return createPortal(<dialog ref={dialog} className="image-preview-dialog" aria-label="Просмотр изображения"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="image-preview-toolbar">
      <button type="button" aria-label="Уменьшить" title="Уменьшить" onClick={() => zoom(1 / 1.25)} disabled={view.zoom <= 0.25}><Minus size={18} /></button>
      <span aria-live="polite">{Math.round(view.zoom * 100)}%</span>
      <button type="button" aria-label="Увеличить" title="Увеличить" onClick={() => zoom(1.25)} disabled={view.zoom >= 8}><Plus size={18} /></button>
      <button type="button" aria-label="Вписать изображение" title="Вписать изображение" onClick={() => setView(initialView)}><RotateCcw size={18} /></button>
      <button className="image-preview-close" type="button" aria-label="Закрыть просмотр" title="Закрыть (Escape)" autoFocus onClick={onClose}><X size={22} /></button>
    </div>
    <div ref={stage} className="image-preview-stage" onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      {error ? <p className="image-preview-error" role="status">Не удалось загрузить изображение.</p> : <img
        className="image-preview-full" src={image.src} alt={image.alt} draggable={false}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}
        onError={() => setError(true)}
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault();
          dragging.current = { id: event.pointerId, x: event.clientX - liveView.current.x, y: event.clientY - liveView.current.y };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          const active = dragging.current;
          if (active?.id === event.pointerId) setView(previous => ({ ...previous, x: event.clientX - active.x, y: event.clientY - active.y }));
        }}
        onPointerUp={event => {
          if (dragging.current?.id !== event.pointerId) return;
          dragging.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => { dragging.current = null; }}
        onLostPointerCapture={() => { dragging.current = null; }} />}
    </div>
    <p className="image-preview-hint">Колесо — масштаб · Перетаскивание — перемещение · Escape — закрыть</p>
  </dialog>, document.body);
}

export function ImagePreviewProvider({ children }: { children: ReactNode }) {
  // One viewer for the whole chat. It survives virtualized rows being unmounted
  // or generated media moving from a tool card into the completed answer.
  const [image, setImage] = useState<ImageSource | null>(null);
  const open = useCallback((next: ImageSource) => setImage(next), []);
  return <OpenImage.Provider value={open}>{children}
    {image && <ImageDialog key={image.src} image={image} onClose={() => setImage(null)} />}
  </OpenImage.Provider>;
}
