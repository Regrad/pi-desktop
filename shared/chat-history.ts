import type { JsonObject, SessionEntryView } from "./types.js";

export type ChatHistoryRequest = { direction: "before" | "after" | "at"; id: string };
export type ChatHistoryRow = { id: string; position: number; message?: JsonObject; entry?: SessionEntryView; editable?: boolean };
export type ChatHistoryMark = { id: string; position: number; timestamp: number };
export type ChatHistoryPage = {
  rows: ChatHistoryRow[];
  before?: string;
  after?: string;
  marks: ChatHistoryMark[];
  total: number;
};

export const chatMessageWindow = 60;

/** Apply context omissions to cached pages, including pages that arrive late. */
export function omitHistoryEntries(page: ChatHistoryPage | undefined, omitted: ReadonlySet<string>): ChatHistoryPage | undefined {
  if (!page || !omitted.size) return page;
  const removed = page.rows.filter(row => omitted.has(row.id));
  if (!removed.length) return page;
  const retained = page.rows.filter(row => !omitted.has(row.id));
  if (!retained.length) return undefined;
  const position = (value: number) => value - removed.filter(row => row.position < value).length;
  return {
    ...page,
    rows: retained.map(row => ({ ...row, position: position(row.position) })),
    before: page.before && omitted.has(page.before) ? retained[0].id : page.before,
    after: page.after && omitted.has(page.after) ? retained.at(-1)!.id : page.after,
    marks: page.marks.filter(mark => !omitted.has(mark.id)).map(mark => ({ ...mark, position: position(mark.position) })),
    total: page.total - removed.length,
  };
}
