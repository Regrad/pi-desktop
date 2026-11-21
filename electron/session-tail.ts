import { open } from "node:fs/promises";
import type { ChatHistoryPage, ChatHistoryRow } from "../shared/chat-history.js";
import type { JsonObject } from "../shared/types.js";

const quickRows = 18;
const quickBytes = 2 * 1024 * 1024;

/** Read the final visible rows without parsing the full session or loading Pi. */
export async function readSessionTail(file: string): Promise<ChatHistoryPage | undefined> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    for (let window = 128 * 1024; ; window *= 2) {
      const length = Math.min(size, window);
      const start = size - length;
      const buffer = Buffer.allocUnsafe(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
        if (!bytesRead) return;
        offset += bytesRead;
      }
      const lines = buffer.toString("utf8").split("\n");
      if (start) lines.shift();
      const entries = new Map<string, JsonObject>();
      let id: string | undefined;
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as JsonObject;
          if (entry && typeof entry.id === "string" && "parentId" in entry) {
            id = entry.id;
            entries.set(id, entry);
          }
        } catch { /* Partial or malformed lines are ignored by Pi as well. */ }
      }
      const rows: ChatHistoryRow[] = [];
      const visited = new Set<string>();
      const edited = new Set<string>();
      while (id && !visited.has(id) && rows.length < quickRows) {
        const entry = entries.get(id);
        if (!entry) break;
        visited.add(id);
        if (entry.type === "context_edit" && typeof entry.targetId === "string") edited.add(entry.targetId);
        if (edited.has(id)) return; // Let the full projection apply the edit.
        const message = entry.message as JsonObject | undefined;
        if (entry.type === "message" && message && ["user", "assistant", "toolResult", "tool", "bashExecution"].includes(String(message.role)))
          rows.push({ id, position: 0, message });
        if (entry.type === "compaction") rows.push({ id, position: 0, entry: { type: "compaction", id, timestamp: String(entry.timestamp), tokensBefore: entry.tokensBefore } });
        id = typeof entry.parentId === "string" ? entry.parentId : undefined;
      }
      if (rows.length >= quickRows || !id) {
        rows.reverse().forEach((row, position) => { row.position = position; });
        return rows.length ? { rows, marks: [], total: rows.length } : undefined;
      }
      if (!start || window >= quickBytes) return;
    }
  } finally {
    await handle.close();
  }
}
