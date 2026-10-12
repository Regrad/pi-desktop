import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ConversationNotebook } from "../shared/types.js";
import { notebookContext, notebookLimit, notebookPolicy, notebookUsage, validateNotebookLimit } from "../shared/notebook.js";
import { requestGoal } from "./goal-extension.js";
import { stateContext } from "./state-context.js";

export function readDesktopNotebook(): ConversationNotebook | undefined {
  const file = process.env.PI_DESKTOP_GOAL_STATE_FILE
    ?? (process.env.PI_DESKTOP_DATA_DIR ? path.join(process.env.PI_DESKTOP_DATA_DIR, "desktop-state.json") : undefined);
  const id = process.env.PI_DESKTOP_CONVERSATION_ID;
  if (!file || !id) return;
  const state = JSON.parse(readFileSync(file, "utf8"));
  const notebook = state.conversations?.find((conversation: { id: string }) => conversation.id === id)?.notebook;
  if (notebook === undefined) return;
  if (typeof notebook.content !== "string" || !Number.isSafeInteger(notebook.revision))
    throw new Error("Не удалось прочитать блокнот: неверный формат данных.");
  return notebook;
}

export function readDesktopNotebookLimit(): number {
  const file = process.env.PI_DESKTOP_GOAL_STATE_FILE
    ?? (process.env.PI_DESKTOP_DATA_DIR ? path.join(process.env.PI_DESKTOP_DATA_DIR, "desktop-state.json") : undefined);
  return file ? validateNotebookLimit(JSON.parse(readFileSync(file, "utf8")).notebookCharacterLimit ?? notebookLimit) : notebookLimit;
}

export default function notebookExtension(pi: ExtensionAPI, readNotebook = readDesktopNotebook, request = requestGoal, readLimit = readDesktopNotebookLimit) {
  let observedRevision = readNotebook()?.revision ?? 0;
  const projectState = stateContext(pi, "desktop_notebook_state", ["update_notebook"], "notebook");
  const projectLimit = stateContext(pi, "desktop_notebook_limit_state", []);
  pi.on("before_agent_start", event => ({ systemPrompt: `${event.systemPrompt}\n\n${notebookPolicy}` }));
  pi.on("context", event => {
    const notebook = readNotebook();
    observedRevision = notebook?.revision ?? 0;
    const limit = readLimit();
    const messages = projectState(event.messages, notebook, notebookContext(notebook, limit), value => String(value?.revision ?? 0));
    return { messages: projectLimit(messages, limit,
      `Notebook character limit: ${limit}. Applies to the final text for all writes. Existing notes are not truncated when the limit decreases. This limit supersedes earlier usage limits. Usage at this limit change: ${JSON.stringify(notebookUsage(notebook, limit))}.`, String) };
  });
  pi.registerTool({
    name: "update_notebook", label: "Блокнот",
    description: "Read or edit short persistent notes in this chat. Call {} to read. Choose one write operation: old_text + new_text replaces exactly one literal unique fragment (new_text: '' deletes it); append adds text verbatim at the end (include a newline if needed); content replaces the entire Markdown (content: '' clears it). Prefer targeted edits for small changes. Read and write results include notebook and usage: currentChars, limit, remainingChars. The limit applies to the final text. Invalid, missing, ambiguous or oversized edits are rejected without changes. On revision conflict, read current notes and merge your changes instead of overwriting them.",
    parameters: Type.Object({
      content: Type.Optional(Type.String()),
      old_text: Type.Optional(Type.String({ minLength: 1 })),
      new_text: Type.Optional(Type.String()),
      append: Type.Optional(Type.String({ minLength: 1 })),
    }),
    async execute(_id, params, signal) {
      const writing = params.content !== undefined || params.append !== undefined || params.old_text !== undefined || params.new_text !== undefined;
      const result = await request("update_notebook", { ...params, ...(writing ? { expectedRevision: observedRevision } : {}) }, signal);
      observedRevision = (result as { notebook?: ConversationNotebook })?.notebook?.revision ?? 0;
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
    },
  });
}
