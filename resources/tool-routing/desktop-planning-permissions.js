import { readFileSync } from "node:fs";

/** Live desktop permissions are separate from the model's unchanged tool catalog. */
export function readDesktopPlanning() {
  const id = process.env.PI_DESKTOP_CONVERSATION_ID;
  const file = process.env.PI_DESKTOP_GOAL_STATE_FILE;
  if (!id) return;
  if (!file) throw new Error("Desktop permissions unavailable; execution disabled.");
  const state = JSON.parse(readFileSync(file, "utf8"));
  const conversation = state.conversations?.find(item => item.id === id);
  if (!conversation) throw new Error("Conversation permissions unavailable; execution disabled.");
  return conversation.planning;
}

export function desktopPlanningLocked() {
  const state = readDesktopPlanning();
  return Boolean(state && !["working", "inactive", "completed"].includes(state.phase) && !(state.phase === "implementation"
    && Number.isSafeInteger(state.revision) && state.approvedRevision === state.revision
    && typeof state.content === "string" && state.content.trim()));
}

export function assertPlanningModelAccess() {
  if (desktopPlanningLocked()) throw new Error("PLAN mode: additional model generation is unavailable until user approval.");
}

/** Pi Lens can mutate files from these hooks without calling an edit tool. */
export function guardExtensionHandler(event, handler, source) {
  if (!/(?:^|[\\/])pi-lens[\\/]/i.test(source ?? "") || !["tool_call", "tool_result", "turn_end", "agent_end", "agent_settled"].includes(event)) return handler;
  return (...args) => {
    // Successful reads only update Lens's read-before-edit ledger, not project files.
    if (event === "tool_result" && args[0]?.toolName === "read") return handler(...args);
    if (!desktopPlanningLocked()) return handler(...args);
  };
}
