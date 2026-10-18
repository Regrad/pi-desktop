import type { ConversationRun } from "./types.js";

export function canResumeRun(run?: ConversationRun): boolean {
  return Boolean(run && (run.interruption || !run.completedAt));
}

export function composerAction(working: boolean, hasDraft: boolean, run?: ConversationRun): "queue" | "send" | "resume" {
  if (working) return "queue";
  return !hasDraft && canResumeRun(run) ? "resume" : "send";
}
