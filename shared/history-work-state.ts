import type { ConversationGoal, ConversationPlan } from "./types.js";

type Entry = { type: string; customType?: string; content?: unknown; details?: any; data?: any; timestamp?: string; message?: any };
type WorkState = { goal?: ConversationGoal; plan?: ConversationPlan };
const stateTools = new Set(["update_plan", "get_goal", "create_goal", "update_goal", "desktop_goal_report"]);
function text(value: unknown): string {
  return typeof value === "string" ? value : Array.isArray(value)
    ? value.filter(part => part?.type === "text").map(part => part.text).join("") : "";
}

/** Replay only the retained branch, never the abandoned answer or the current desktop state. */
export function historyWorkState(branch: readonly Entry[], current?: WorkState): WorkState {
  let goal: ConversationGoal | undefined, plan: ConversationPlan | undefined;
  const apply = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (Object.hasOwn(value, "plan")) {
      const p = value.plan;
      if (p == null) plan = undefined;
      else if (Array.isArray(p.steps) && Number.isSafeInteger(p.revision)
        && (!plan || p.revision >= plan.revision)) plan = structuredClone(p);
    }
    if (Object.hasOwn(value, "goal")) {
      const g = value.goal;
      if (g == null) goal = undefined;
      else if (typeof g.id === "string" && typeof g.objective === "string"
        && typeof g.updatedAt === "string" && typeof g.steps === "number"
        && !(goal && goal.id === g.id && Date.parse(g.updatedAt) < Date.parse(goal.updatedAt))) goal = structuredClone(g);
    }
  };
  for (const entry of branch) {
    try {
      if (entry.type === "custom" && entry.customType === "pi_desktop_history_position") apply(entry.data?.workState);
      const message = entry.type === "custom_message" ? entry : entry.message;
      if (!message) continue;
      if (message.role === "toolResult" && !message.isError && stateTools.has(message.toolName)) {
        apply(JSON.parse(text(message.content)));
      } else if (["desktop_plan_state", "desktop_goal_state"].includes(message.customType)) {
        const field = message.customType === "desktop_plan_state" ? "plan" : "goal";
        if (Object.hasOwn(message.details ?? {}, "workState")) apply({ [field]: message.details.workState });
        else if (field === "plan") {
          const body = text(message.content);
          const json = body.match(/\n(\{[^\n]*\})\n/);
          const revision = /revision (\d+)/.exec(body);
          if (json && revision) apply({ plan: { ...JSON.parse(json[1]), revision: Number(revision[1]), updatedAt: entry.timestamp } });
          else if (/Checklist (cleared|removed)/.test(body)) plan = undefined;
        } else {
          // Legacy goal keys are partial. Merge only into an already confirmed full goal.
          const key = JSON.parse(message.details?.stateKey ?? "null");
          if (key === null) goal = undefined;
          else if (goal?.id === key.id) goal = { ...goal, ...key };
        }
      }
    } catch { /* Invalid/unstructured text is not a state acknowledgement. */ }
  }
  const now = new Date().toISOString();
  return {
    goal: goal ? { ...goal, status: goal.status === "active" ? "paused" : goal.status, updatedAt: now } : undefined,
    plan: plan ? { ...plan, execution: "paused", revision: Math.max(plan.revision, current?.plan?.revision ?? 0) + 1, updatedAt: now } : undefined,
  };
}
