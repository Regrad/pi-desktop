import type { SessionHistoryTarget } from "./types.js";

type HistoryMessage = { role?: string; content?: unknown };
type HistoryEntry = { id: string; type: string; parentId: string | null; message?: HistoryMessage };

/** Hidden service snapshots alone are not further conversation to rewind. */
export function historyHasLaterMessages(messages: readonly { role?: unknown; display?: unknown }[], index: number): boolean {
  return messages.slice(index + 1).some(message =>
    ["user", "assistant", "toolResult", "tool"].includes(String(message.role))
    || (message.role === "custom" && message.display !== false));
}

function selectable(message: HistoryMessage): boolean {
  if (message.role !== "user" && message.role !== "assistant") return false;
  // Stopping at a tool-call message would leave unmatched calls in model context.
  return !Array.isArray(message.content) || !message.content.some(part => part?.type === "toolCall");
}

/** Map context messages to real entries, never timestamps or display indices alone. */
export function sessionHistoryTargets(messages: readonly unknown[], branch: readonly HistoryEntry[]): SessionHistoryTarget[] {
  const entriesByMessage = new Map<string, { entries: HistoryEntry[]; next: number }>();
  for (const entry of branch) {
    if (entry.type !== "message" || !entry.message || !selectable(entry.message)) continue;
    const key = JSON.stringify(entry.message);
    const bucket = entriesByMessage.get(key);
    if (bucket) bucket.entries.push(entry);
    else entriesByMessage.set(key, { entries: [entry], next: 0 });
  }
  const lastUser = [...branch].reverse().find(entry => entry.type === "message" && entry.message?.role === "user");
  return messages.flatMap((message, messageIndex) => {
    if (!message || typeof message !== "object" || !selectable(message as HistoryMessage)) return [];
    const bucket = entriesByMessage.get(JSON.stringify(message));
    const entry = bucket?.entries[bucket.next++];
    if (!entry) return [];
    return [{ entryId: entry.id, messageIndex, editable: entry.id === lastUser?.id }];
  });
}

export function selectHistoryTarget(branch: readonly HistoryEntry[], entryId: string, editing: boolean): HistoryEntry {
  const target = branch.find(entry => entry.id === entryId);
  if (!target?.message || target.type !== "message" || !selectable(target.message))
    throw new Error("Сообщение недоступно для отката в текущей ветке сессии.");
  if (editing) {
    const lastUser = [...branch].reverse().find(entry => entry.type === "message" && entry.message?.role === "user");
    if (target.id !== lastUser?.id) throw new Error("Редактировать можно только последнее сообщение пользователя.");
  }
  return target;
}
