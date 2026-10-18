/** Deferred services have one owner, including when the window closes mid-start. */
export class StartupTasks {
  private closed = false;
  private pending = new Map<string, Promise<unknown>>();
  private cleanup = new Map<string, () => Promise<unknown>>();
  private closing?: Promise<void>;

  start<T>(name: string, load: () => Promise<T>, close?: (value: T) => Promise<unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Application is closing"));
    const existing = this.pending.get(name);
    if (existing) return existing as Promise<T>;
    const task = Promise.resolve().then(load).then(async value => {
      if (this.closed) {
        await close?.(value);
        throw new Error("Application is closing");
      }
      if (close) this.cleanup.set(name, () => close(value));
      return value;
    }).catch(error => {
      if (this.pending.get(name) === task) this.pending.delete(name);
      throw error;
    });
    this.pending.set(name, task);
    return task;
  }

  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= (async () => {
      await Promise.allSettled(this.pending.values());
      const results = await Promise.allSettled([...this.cleanup.values()].map(close => close()));
      this.cleanup.clear();
      this.pending.clear();
      const failure = results.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })();
  }
}
