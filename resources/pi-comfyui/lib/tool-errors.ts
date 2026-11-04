import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

// Backend configuration belongs to application diagnostics, not tool arguments.
export async function mediaToolError(dataDir: string, tool: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const internal = /comfyui|workflow|node_errors|class_type|api_node|fetch failed|ECONN|ENOTFOUND/i.test(message);
  if (!internal) return { isError: true, content: [{ type: "text" as const, text: message }], details: {} };
  const id = randomUUID();
  const directory = path.join(dataDir, "logs", "media-tools");
  let recorded = false;
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${id}.json`), JSON.stringify({ id, tool,
      timestamp: new Date().toISOString(), message, stack: error instanceof Error ? error.stack : undefined }, null, 2), { flag: "wx" });
    recorded = true;
  } catch { /* A diagnostics write failure must still return the operation failure. */ }
  const unavailable = /fetch failed|ECONN|ENOTFOUND|отключ[её]н|disabled/i.test(message);
  return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({
    error: unavailable ? "media_unavailable" : "media_operation_failed",
    message: unavailable ? "Media tools are unavailable. Check the application's media settings."
      : "The media operation failed internally. Application maintenance is required.",
    ...(recorded ? { diagnostic_id: id } : {}),
  }) }], details: {} };
}
