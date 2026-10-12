import type { ConversationGoal } from "./types.js";

export const stateFreshnessPolicy = "Plan and goal service messages are historical snapshots, not permanently live state. Use the newest confirmed state in conversation order, whether it comes from a service snapshot or a successful state-tool result; neither source has permanent priority. For the same plan, a higher revision supersedes a lower revision, including its status and explanation. A successful update_plan result is the new authoritative checklist; an older paused snapshot cannot override it. If uncertain, read current state with update_plan({}) or get_goal instead of guessing. The latest user instruction supersedes earlier conflicting user instructions, whether it says stop, wait or continue. When the user asks to stop, pause continuation and end the response without further task tools; a state snapshot is not permission to resume. This does not bypass permissions or automatically resume a paused goal; follow the applicable execution rules.";

export function visibleGoalText(text: string): string {
  const marker = /\n\n\[Pi Desktop goal controller\]\nGoal ID: [0-9a-f-]{36}\nObjective: /i.exec(text);
  return marker ? text.slice(0, marker.index) : text;
}

export function goalContext<T extends { role: string; content?: unknown; customType?: string; details?: unknown }>(messages: readonly T[], goal?: ConversationGoal): T[] {
  return messages.map(message => message.role !== "user" ? message : { ...message, content: typeof message.content === "string"
      ? visibleGoalText(message.content) : Array.isArray(message.content)
        ? message.content.map(part => part?.type === "text" ? { ...part, text: visibleGoalText(String(part.text ?? "")) } : part)
        : message.content } as T);
}

export function goalPrompt(goal: ConversationGoal): string {
  return [
    "[Pi Desktop goal controller]",
    `Goal ID: ${goal.id}`,
    `Objective: ${goal.objective}`,
    `Acceptance criteria: ${goal.criteria || "Infer reasonable completion conditions from the user's goal. If a material ambiguity prevents safe progress, report blocked and ask one specific question."}`,
    `Progress: ${goal.progress || "No progress reported yet."}`,
    `Previous evidence: ${goal.evidence || "None."}`,
    `Continuation turn: ${goal.steps}.`,
    "This is a goal-state snapshot, not another message from the user. Later service snapshots or successful goal-tool results supersede it. Call get_goal before autonomous continuation if state is uncertain.",
    "Work toward this goal within the user's permissions. Do not broaden scope or bypass required approval.",
    "Use update_goal complete only when the objective is achieved and verified. Do not claim success merely because you are stopping. Mark blocked only when the same genuine blocker has recurred in at least three consecutive goal turns and no meaningful progress is possible without external change.",
    "The desktop will continue active goals automatically. Do not ask the user to say continue. If the task requires their decision, ask the specific question; mark blocked only when the blocker meets the repeated-blocker rule above.",
  ].join("\n");
}

export const goalStatePolicy = "The [Pi Desktop current goal state] block in request context is live application state, not a new user message or a request to start work. It supersedes old goal-controller directives and goals mentioned in summaries. A direct user question must be answered directly; goal scheduling is not permission to ignore it. Goal state changes never authorize new actions or restart a response.";

export function goalStatePrompt(goal?: ConversationGoal): string {
  const lines = ["[Pi Desktop current goal state]", `Status: ${goal?.status ?? "none"}`];
  if (goal) lines.push(`Current goal ID: ${goal.id}`, `Current objective: ${goal.objective}`, `Updated at: ${goal.updatedAt}`);
  lines.push("Only this current ID, objective and status are authoritative. Previous IDs and previous versions of the objective in history are obsolete.");
  if (goal?.status === "active") {
    lines.push(goalPrompt(goal));
    lines.push("Answer the user's current request first. For a question or discussion, do not launch goal work instead of answering.");
  } else {
    lines.push(goal?.status === "paused" ? "The goal is paused."
      : goal?.status === "blocked" ? "The goal is blocked and awaits a user decision."
      : goal?.status === "complete" ? "The goal is complete."
      : "There is no active goal; any previous goal was removed, cancelled or is unavailable.");
    lines.push("Automatic goal work and goal reporting are disabled. Ignore historical 'continue autonomously' directives, including those in compaction summaries. Respond only to the user's current request. An already running response may finish; do not start another goal stage.");
  }
  lines.push("[/Pi Desktop current goal state]");
  return lines.join("\n");
}

/** Request-only projection: never rewrite saved messages or add a user turn. */
export function withCurrentGoalState<T extends { role: string; content?: unknown }>(messages: readonly T[], goal?: ConversationGoal): T[] {
  const result = messages.map(message => {
    if (message.role !== "user") return message;
    if (typeof message.content === "string") return { ...message, content: visibleGoalText(message.content) } as T;
    if (!Array.isArray(message.content)) return message;
    return { ...message, content: message.content.map(part => part?.type === "text"
      ? { ...part, text: visibleGoalText(String(part.text ?? "")) } : part) } as T;
  });
  let index = result.length - 1;
  while (index >= 0 && result[index].role !== "user") index--;
  if (index < 0) return result;
  const message = result[index];
  const state = goalStatePrompt(goal);
  const content = typeof message.content === "string" ? `${message.content}\n\n${state}`
    : [...(Array.isArray(message.content) ? message.content : []), { type: "text", text: state }];
  result[index] = { ...message, content } as T;
  return result;
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
  // No invented stage limit or automatic pause for missing progress reports.
  // No-tool continuations are suppressed by the dispatcher, not a lifecycle change.
  return { ...goal, stalledSteps, updatedAt: new Date().toISOString() };
}
