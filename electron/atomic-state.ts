import { rename, writeFile } from "node:fs/promises";

export class StatePersistenceError extends Error {
  constructor(destination: string, stage: string, attempts: number, cause: unknown) {
    const code = (cause as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
    super(`Не удалось сохранить состояние: ${destination}. Операция: ${stage}; код: ${code}; попыток: ${attempts}. Работа модели не остановлена; последние изменения могли не сохраниться.`, { cause });
    this.name = "StatePersistenceError";
  }
}

const defaults = { rename, writeFile, wait: (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  warn: (message: string) => console.warn(message) };

/** Caller serializes writes. Never delete the valid destination as a fallback. */
export async function atomicStateWrite(destination: string, content: string, operations = defaults): Promise<void> {
  const temporary = `${destination}.tmp`;
  async function retry(stage: string, action: () => Promise<unknown>) {
    for (let attempt = 0; ; attempt++) {
      try { await action(); return; }
      catch (cause) {
        const code = (cause as NodeJS.ErrnoException)?.code;
        if (!["EPERM", "EBUSY", "EACCES"].includes(code ?? "") || attempt >= 6) {
          const error = new StatePersistenceError(destination, stage, attempt + 1, cause);
          operations.warn(error.message);
          throw error;
        }
        if (attempt === 0) operations.warn(`Повтор сохранения состояния: ${destination}; ${stage}; ${code}.`);
        await operations.wait(25 * 2 ** attempt);
      }
    }
  }
  await retry("запись временного файла", () => operations.writeFile(temporary, content, "utf8"));
  await retry("замена файла", () => operations.rename(temporary, destination));
}
