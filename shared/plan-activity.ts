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

export function planIsWorking(plan: ConversationPlan | undefined, streaming: boolean, confirmedRevision?: number): boolean {
  return Boolean(streaming && plan?.execution === "active" && confirmedRevision !== undefined
    && plan.revision === confirmedRevision && plan.steps.some(step => step.status === "in_progress"));
}
