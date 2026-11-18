import type { ConversationPlan } from "./types.js";

// Runtime-only acknowledgement: loading or a persisted in_progress step is not execution.
export function confirmedPlanRevision(
  params: { plan?: unknown; execution?: unknown; mark?: unknown },
  plan: ConversationPlan,
  streaming: boolean,
): number | undefined {
  return streaming && (params.plan !== undefined || params.mark !== undefined || params.execution === "active")
    && plan.execution === "active" && plan.steps.some(step => step.status === "in_progress")
    ? plan.revision : undefined;
}

// The acknowledgement belongs to the live run, not to one checklist revision. The manager stamps it
// from the plan it just wrote, while the patched checklist reaches the renderer as a separate event;
// demanding equal revisions there stopped the indicator every time a step was ticked. Stale
// acknowledgements are released by the manager (run settled, paused, removed), not here.
export function planIsWorking(plan: ConversationPlan | undefined, streaming: boolean, confirmedRevision?: number): boolean {
  return Boolean(streaming && confirmedRevision !== undefined
    && plan?.steps.some(step => step.status === "in_progress"));
}
