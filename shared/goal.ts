import type { ConversationGoal } from "./types.js";

export function visibleGoalText(text: string): string {
  const marker = /\n\n\[Pi Desktop goal controller\]\nGoal ID: [0-9a-f-]{36}\nObjective: /i.exec(text);
  return marker ? text.slice(0, marker.index) : text;
}

export function goalPrompt(goal: ConversationGoal): string {
  return [
    "[Pi Desktop goal controller]",
    `Goal ID: ${goal.id}`,
    `Objective: ${goal.objective}`,
    `Acceptance criteria: ${goal.criteria || "Infer reasonable completion conditions from the user's goal. If a material ambiguity prevents safe progress, report blocked and ask one specific question."}`,
    `Progress: ${goal.progress || "No progress reported yet."}`,
    `Previous evidence: ${goal.evidence || "None."}`,
    `Stage ${goal.steps} of ${goal.maxSteps}.`,
    "Work toward this goal within the user's permissions. Do not broaden scope or bypass required approval.",
    "Before ending this stage, call desktop_goal_report with this goal ID, progress, evidence and status.",
    "Use active if more work remains; blocked if user input/permission is required; complete only when all acceptance criteria are satisfied and verified. Describe actual checks and their results in evidence; do not invent verification.",
    "The desktop will continue active goals automatically. Do not ask the user to say continue. If the task requires their decision, report blocked and ask the specific question.",
  ].join("\n");
}

export function applyGoalReport(goal: ConversationGoal, report: unknown): ConversationGoal {
  if (!report || typeof report !== "object" || goal.status !== "active") return goal;
  const value = report as Record<string, unknown>;
  if (value.goalId !== goal.id || !["active", "blocked", "complete"].includes(String(value.status))) return goal;
  if (typeof value.progress !== "string" || !value.progress.trim() || value.progress.length > 8000) return goal;
  if (typeof value.evidence !== "string" || value.evidence.length > 8000) return goal;
  if (value.status === "complete" && !value.evidence.trim()) return goal;
  return { ...goal, status: value.status as ConversationGoal["status"], progress: value.progress.trim(),
    evidence: value.evidence.trim(), updatedAt: new Date().toISOString() };
}

export function settleGoal(goal: ConversationGoal, previousProgress: string): ConversationGoal {
  if (goal.status !== "active") return goal;
  const stalledSteps = goal.progress === previousProgress ? goal.stalledSteps + 1 : 0;
  const reason = goal.steps >= goal.maxSteps ? "Достигнут лимит этапов. Можно продолжить вручную."
    : stalledSteps >= 3 ? "Три этапа без нового отчёта о прогрессе. Требуется проверка пользователя." : undefined;
  return { ...goal, stalledSteps, ...(reason ? { status: "paused" as const, evidence: reason } : {}), updatedAt: new Date().toISOString() };
}
