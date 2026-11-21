import { sessionEntryToContextMessages, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { chatMessageWindow, type ChatHistoryPage, type ChatHistoryRequest, type ChatHistoryRow } from "../shared/chat-history.js";

const visibleRoles = new Set(["user", "assistant", "toolResult", "tool", "bashExecution"]);
const pageBytes = 5 * 1024 * 1024;

/** Select visible rows from the active branch, including before any compaction. */
export function sessionTranscript(branch: SessionEntry[], request?: ChatHistoryRequest): ChatHistoryPage {
  const edits = new Map(branch.filter(entry => entry.type === "context_edit").map(entry => [entry.targetId, entry]));
  const rows: ChatHistoryRow[] = [];
  const turns: ChatHistoryPage["marks"] = [];
  let lastUser: ChatHistoryRow | undefined;
  for (const entry of branch) {
    const position = rows.length;
    if (entry.type === "compaction") {
      rows.push({ id: entry.id, position, entry: { type: entry.type, id: entry.id, timestamp: entry.timestamp, tokensBefore: entry.tokensBefore } });
      continue;
    }
    if (entry.type !== "message" && entry.type !== "custom_message") continue;
    const [original] = sessionEntryToContextMessages(entry);
    const edit = edits.get(entry.id);
    if (!original || edit?.replacement === null) continue;
    const message = { ...original };
    if (edit && "content" in message) {
      const content = edit.replacement.content;
      Object.assign(message, { content: typeof content === "string" && (message.role === "assistant" || message.role === "toolResult")
        ? [{ type: "text", text: content }] : content });
    }
    if (!visibleRoles.has(message.role) && !(message.role === "custom" && message.display !== false)) continue;
    const row = { id: entry.id, position, message };
    rows.push(row);
    if (message.role === "user") {
      lastUser = row;
      turns.push({ id: entry.id, position, timestamp: Date.parse(entry.timestamp) });
    }
  }
  if (lastUser) lastUser.editable = true;
  const count = Math.min(52, turns.length);
  const marks = Array.from({ length: count }, (_, index) => turns[Math.round(index * (turns.length - 1) / Math.max(1, count - 1))]);
  const target = request ? rows.findIndex(row => row.id === request.id) : rows.length;
  if (target === -1) throw new Error("Сообщение больше не в активной ветке чата.");
  const backward = !request || request.direction === "before";
  const boundary = request?.direction === "after" ? target + 1 : target;
  let first = boundary;
  let last = boundary;
  let bytes = 0;
  for (let index = backward ? boundary - 1 : boundary;
    index >= 0 && index < rows.length && last - first < chatMessageWindow; index += backward ? -1 : 1) {
    bytes += Buffer.byteLength(JSON.stringify(rows[index]));
    if (first !== last && bytes > pageBytes) break;
    if (backward) first = index;
    else last = index + 1;
  }
  const page = rows.slice(first, last);
  return { rows: page, before: first > 0 ? page[0]?.id : undefined, after: last < rows.length ? page.at(-1)?.id : undefined, marks, total: rows.length };
}
