/** A second frame runs after the first frame has had a chance to paint. */
export function afterFirstPaint(action: () => void,
  request = (callback: FrameRequestCallback) => requestAnimationFrame(callback),
  cancel = (id: number) => cancelAnimationFrame(id)): () => void {
  let frame = request(() => { frame = request(() => { if (!cancelled) action(); }); });
  let cancelled = false;
  return () => { cancelled = true; cancel(frame); };
}
