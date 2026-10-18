import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ApiGraph } from "./workflow-catalog.js";

export async function compileDesktopWorkflow(workflow: Record<string, unknown>, signal?: AbortSignal): Promise<ApiGraph> {
  const root = process.env.PI_DESKTOP_APP_ROOT;
  if (!root) throw new Error("Штатный экспорт JSON редактора доступен в Pi Desktop. Для другого исполнителя используйте Export (API).");
  const { requestGoal } = await import(pathToFileURL(path.join(root, "dist-electron/electron/goal-extension.js")).href);
  try { return await requestGoal("comfy_compile", { workflow }, signal) as ApiGraph; }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replaceAll("Goal controller", "ComfyUI export controller").replaceAll("Goal request", "ComfyUI export"));
  }
}
