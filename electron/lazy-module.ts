/** Share concurrent imports, but allow retry after a failed load. */
export function lazyModule<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => pending ??= Promise.resolve().then(load).catch(error => {
    pending = undefined;
    throw error;
  });
}
