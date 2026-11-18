import type { ConversationPlan, PlanStep } from "./types.js";

export const planRequestText = "The user enabled Compose a plan for this message. Before writing the plan, carefully investigate the systems that will be affected, their connections, constraints, current implementation and relevant evidence. Only then create a sound actionable checklist with update_checklist and keep it flexible as new evidence arrives. Do not invent a plan before investigating. This preference does not grant permission to execute work: if the user is asking a question or discussing options, investigate and provide a proposed plan without starting implementation.";
export const planRequestSuffix = `\n\n[Pi Desktop plan request]\n${planRequestText}`;
export function visiblePlanRequestText(text: string): string {
  return text.replace(planRequestSuffix, "");
}

export function requestedPlanContext<T extends { role: string; content?: unknown }>(messages: readonly T[]): { messages: T[]; requested: boolean } {
  let lastUser = -1;
  messages.forEach((message, index) => { if (message.role === "user") lastUser = index; });
  let requested = false;
  const projected = messages.flatMap((message, index) => {
    if (message.role !== "user") return [message];
    let marked = false;
    const clean = (text: string) => {
      if (text.includes(planRequestSuffix)) marked = true;
      if (index === lastUser && text.includes(planRequestSuffix)) requested = true;
      return visiblePlanRequestText(text);
    };
    const projected = { ...message, content: typeof message.content === "string" ? clean(message.content)
      : Array.isArray(message.content) ? message.content.map(part => part?.type === "text" ? { ...part, text: clean(String(part.text ?? "")) } : part) : message.content } as T;
    // SAFETY: служебное сообщение вне MessageLike, но проекция читает только role/customType/content.
    return marked ? [projected, { role: "custom", customType: "desktop_plan_request", display: false,
      content: `<pi_desktop_service_context source="plan-request">\n${planRequestText}\n</pi_desktop_service_context>` } as unknown as T] : [projected];
  });
  return { messages: projected, requested };
}

export const planStatuses = ["pending", "in_progress", "waiting", "skipped", "completed"] as const;
// A closed step is finished work or a deliberate skip; a skipped step never counts as done.
export const isPlanComplete = (steps: PlanStep[]) => steps.length > 0 && steps.every(step => step.status === "completed" || step.status === "skipped");
/** An open checklist still has work left; an empty or fully closed one needs neither reminders nor continuation. */
export const isPlanOpen = (plan?: ConversationPlan) => Boolean(plan?.steps.length && !isPlanComplete(plan.steps));

export const planPolicy = "Create a checklist with update_checklist when the user requests one or when it helps keep track of substantial parts of a complex task: distinct results, dependencies between stages, and unfinished work. For simple tasks, work without a checklist; several tool calls alone do not make one necessary. Before creating a plan, investigate the task and affected systems. Plan verifiable stages and results, not individual tool calls. Use the plan to choose the next action, mark work completed only after verification, and revise steps when new evidence appears. The plan should reflect actual work, not force adherence to an obsolete approach. Mark a step as soon as it is verified instead of batching all marks to the end of the turn, otherwise the checklist stops describing reality. You may add, remove, rewrite, reorder or split steps, or revise the entire checklist, by submitting the full revised list. Previously completed steps may be reopened when new evidence requires rechecking them. Explain material changes briefly, without seeking permission for routine in-scope replanning. Five statuses exist: pending (not started), in_progress (the single step you are performing right now), waiting (blocked on the user's answer or approval), skipped (deliberately not done, with a required short reason the user sees), completed (verified done). The list is a queue in execution order: nothing above the in_progress step may stay pending, so move the step you are starting upward instead of jumping over rows, and mark anything you pass as skipped with its reason. A step that needs the user becomes waiting, and while any step waits no step may be in_progress and automatic continuation stops: set execution=paused, ask one consolidated question and end the response. Look facts up yourself instead of asking the user about them. The checklist closes only when every step is completed or skipped, and skipped steps never read as completed. Plans organize work; their existence alone does not authorize extra scope or autonomous continuation. Explicit execution=active enables continuation only within work authorized by the user. A stored plan can belong to an earlier task: prioritize the current user request, and revise or replace the plan as appropriate. If the user clears a checklist, do not recreate it for the same task unless requested; a new substantial task may justify a new plan. A pi_desktop_service_context source=plan block records checklist state at that point in history, not another user request. A short checklist tick only reports progress on a turn and is never a new instruction; treat it as a prompt to mark work you already finished. Later confirmed states supersede it.";

const tickStepText = (text: string) => text.length > 80 ? `${text.slice(0, 77)}…` : text;

// Компактный статус чеклиста на каждый ход: полной проекции состояния мало,
// когда ревизия не менялась, а именно тогда статусы и отстают от работы.
export function planTick(plan: ConversationPlan): string {
  const completed = plan.steps.filter(step => step.status === "completed").length;
  const skipped = plan.steps.filter(step => step.status === "skipped").length;
  const running = plan.steps.find(step => step.status === "in_progress");
  const next = plan.steps.find(step => step.status === "pending");
  const waitingIndex = plan.steps.findIndex(step => step.status === "waiting");
  const parts = [`${completed}/${plan.steps.length} completed${skipped ? `, ${skipped} skipped` : ""}`];
  if (waitingIndex >= 0) parts.push(`frozen on step ${waitingIndex + 1}, waiting for the user`);
  else if (running) parts.push(`in progress: ${tickStepText(running.step)}`);
  else if (next) parts.push(`next: ${tickStepText(next.step)}`);
  parts.push(plan.execution === "active" ? "execution active" : "execution paused");
  return `<pi_desktop_service_context source="plan">Checklist tick (revision ${plan.revision}; not a new task): ${parts.join(", ")}. Read full list: update_checklist({}).</pi_desktop_service_context>`;
}

export function planProblem(steps: PlanStep[]): string | undefined {
  const inProgress = steps.findIndex(step => step.status === "in_progress");
  if (steps.filter(step => step.status === "in_progress").length > 1) return "Only one step may be in_progress.";
  if (inProgress < 0) return;
  const waiting = steps.findIndex(step => step.status === "waiting");
  if (waiting >= 0) {
    return `The checklist is frozen while step ${waiting + 1} waits for the user: no step may be in_progress. Ask the question, set execution=paused and end the response.`;
  }
  const blocked = steps.findIndex((step, index) => index < inProgress && step.status === "pending");
  if (blocked >= 0) {
    return `Step ${blocked + 1} is pending while step ${inProgress + 1} is in_progress. The checklist runs in order: work the earlier step, mark it skipped with a reason, or move the step you are performing above it.`;
  }
  return;
}

export function updatedPlan(params: Record<string, unknown>, current?: ConversationPlan): ConversationPlan {
  if (params.expectedRevision !== undefined && params.expectedRevision !== (current?.revision ?? 0)) {
    throw new Error("Plan changed since it was read. Call update_checklist({}) to read the current plan before revising it.");
  }
  if (params.execution !== undefined && !["active", "paused"].includes(String(params.execution))) throw new Error("execution must be active or paused.");
  if (params.mark !== undefined && params.plan !== undefined) throw new Error("Use either mark for one step or plan for the whole checklist.");
  if (params.mark === undefined && params.status !== undefined) throw new Error("status writes a single marked step; submit plan to rewrite the checklist.");
  const baseSteps = current?.steps ?? [];
  const markIndex = params.mark === undefined ? undefined : Number(params.mark);
  if (markIndex !== undefined) {
    if (!baseSteps.length) throw new Error("There is no checklist to mark. Submit plan to create one.");
    if (!Number.isSafeInteger(markIndex) || markIndex < 1 || markIndex > baseSteps.length) {
      throw new Error(`mark must be a step number from 1 to ${baseSteps.length}.`);
    }
    if (params.status === undefined) throw new Error(`mark needs the new status: ${planStatuses.join(", ")}.`);
  }
  if (params.reason !== undefined && (typeof params.reason !== "string" || params.reason.trim().length > 200)) {
    throw new Error("reason must be text of at most 200 characters.");
  }
  let submitted: unknown;
  if (markIndex !== undefined) submitted = baseSteps.map((value, index) => index === markIndex - 1
    ? { step: value.step, status: params.status, ...(params.reason !== undefined ? { reason: params.reason } : {}) } : value);
  else submitted = params.plan === undefined ? current?.steps : params.plan;
  if (!Array.isArray(submitted) || submitted.length > 40) throw new Error("plan must be an array of at most 40 steps; use [] to clear it.");
  const steps: PlanStep[] = submitted.map((value, index) => {
    if (!value || typeof value !== "object" || typeof value.step !== "string" || !value.step.trim() || value.step.trim().length > 300
      || !planStatuses.includes(value.status)) {
      throw new Error(`Each step needs text (1-300 characters) and status ${planStatuses.join(", ")}.`);
    }
    const reason = typeof (value as { reason?: unknown }).reason === "string" ? (value as { reason: string }).reason.trim() : undefined;
    if (value.status === "skipped" && !reason) {
      throw new Error(`Step ${index + 1} is skipped: give a short reason, for example "skipped: not needed after the model change".`);
    }
    return value.status === "skipped" && reason ? { step: value.step.trim(), status: value.status, reason }
      : { step: value.step.trim(), status: value.status };
  });
  const problem = planProblem(steps);
  if (problem) throw new Error(problem);
  if (params.explanation !== undefined && (typeof params.explanation !== "string" || params.explanation.length > 2000)) {
    throw new Error("explanation must be text of at most 2000 characters.");
  }
  // A step waiting on the user freezes continuation, and a fully closed list has nothing to run.
  const live = steps.some(step => step.status === "pending" || step.status === "in_progress");
  const frozen = steps.some(step => step.status === "waiting");
  return { steps, execution: live && !frozen && (params.execution ?? current?.execution) === "active" ? "active" : "paused",
    explanation: typeof params.explanation === "string" ? params.explanation.trim() || undefined : current?.explanation,
    revision: (current?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
}

export function planContext(plan: ConversationPlan): string {
  if (!plan.steps.length) return `<pi_desktop_service_context source="plan">\nChecklist cleared (revision ${plan.revision}). Ignore historical checklist versions. Do not recreate a user-cleared checklist for the same task unless requested. This does not cancel the goal or stop the current response.\n</pi_desktop_service_context>`;
  return `<pi_desktop_service_context source="plan">\nChecklist snapshot (revision ${plan.revision}; not a new task; steps are numbered in list order from 1; statuses: pending, in_progress, waiting, skipped with a reason, completed):\n${JSON.stringify({ steps: plan.steps, explanation: plan.explanation, execution: plan.execution === "active" ? "active" : "paused" })}\nLater confirmed states supersede this snapshot. Use update_checklist to revise it, update_checklist({mark: N, status, reason}) to write one step; a checklist does not resume a paused goal.\n</pi_desktop_service_context>`;
}

export const planExecutionPolicy = "Set execution=active only for work the user has authorized you to carry out, not for a proposed plan or discussion. Active unfinished plans automatically continue after your response ends. Before ending to ask a question, await approval or report a real blocker, set execution=paused and briefly state the reason in explanation; explicit Stop also pauses continuation. Asking the user is a stop signal, not a pause between sentences: once the question or the offered choice is in the response, that response ends there, with no further tool calls, step marks or remaining checklist items after it. The checklist cannot move past an answer you do not have yet, so never present options and then keep executing the plan, decide on your own, or announce the user's choice. If the answer is not actually needed, decide and continue without asking; if it is needed, pause, ask, and stop waiting for the reply. Resume a paused plan with execution=active only when the user's latest instruction authorizes continuation. Replanning stays flexible and does not grant extra scope. Completion or clearing stops plan continuation. A paused/blocked/budget-limited goal must never be bypassed by its checklist. A separately user-approved implementation document may authorize independent work without resuming an unrelated goal.";

export function canContinuePlan(plan?: ConversationPlan, goal?: { status: string }): boolean {
  return Boolean(plan?.execution === "active" && !plan.steps.some(step => step.status === "waiting")
    && plan.steps.some(step => step.status === "pending" || step.status === "in_progress")
    && (!goal || goal.status === "complete"));
}
