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
