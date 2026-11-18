import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ConversationPlan } from "../shared/types.js";
import { isPlanOpen, planContext, planPolicy, planExecutionPolicy, planStatuses, planTick, requestedPlanContext } from "../shared/plan.js";
import { requestGoal } from "./goal-extension.js";
import { stateFreshnessPolicy } from "../shared/goal.js";
import { stateContext } from "./state-context.js";

export function readDesktopPlan(): ConversationPlan | undefined {
  const file = process.env.PI_DESKTOP_GOAL_STATE_FILE
    ?? (process.env.PI_DESKTOP_DATA_DIR ? path.join(process.env.PI_DESKTOP_DATA_DIR, "desktop-state.json") : undefined);
  if (!file || !process.env.PI_DESKTOP_CONVERSATION_ID) return;
  try {
    const state = JSON.parse(readFileSync(file, "utf8"));
    const plan = state.conversations?.find((conversation: { id?: string }) => conversation.id === process.env.PI_DESKTOP_CONVERSATION_ID)?.plan;
    if (Array.isArray(plan?.steps) && Number.isSafeInteger(plan.revision)) return { ...plan, execution: plan.execution === "active" ? "active" : "paused" };
  } catch { /* Unavailable state must not revive a historical plan. */ }
}

export default function planExtension(pi: ExtensionAPI, readPlan = readDesktopPlan, request = requestGoal) {
  let observedRevision = readPlan()?.revision ?? 0;
  // The old tool name still appears in sessions written before the checklist rename.
  const projectState = stateContext(pi, "desktop_plan_state", ["update_checklist", "update_plan"]);
  pi.on("before_agent_start", event => ({ systemPrompt: `${event.systemPrompt}\n\n${planPolicy}\n${planExecutionPolicy}\n${event.systemPrompt.includes(stateFreshnessPolicy) ? "" : stateFreshnessPolicy}` }));
  pi.on("context", event => {
    const plan = readPlan();
    observedRevision = plan?.revision ?? 0;
    const projection = requestedPlanContext(event.messages);
    return { messages: projectState(projection.messages, plan,
      plan ? planContext(plan) : "<pi_desktop_service_context source=\"plan\">Checklist removed. Ignore historical checklist versions.</pi_desktop_service_context>",
      value => String(value?.revision ?? 0), isPlanOpen(plan),
      plan ? planTick(plan) : undefined, { refreshTurns: plan?.execution === "active" ? 3 : 0 }) };
  });
  pi.registerTool({
    name: "update_checklist", label: "Чеклист", description: `Read or revise the working checklist for this chat. Statuses: ${planStatuses.join(", ")}. Call {} to read the full list; writes confirm revision, execution and progress without repeating steps. The list is a queue in execution order: nothing above in_progress may stay pending, so to do a lower step first, submit the whole list in the new order. To pass a step without doing it, {mark: N, status:"skipped", reason:"why"}; a skip without a reason is rejected. To need the user, {mark: N, status:"waiting"}, set execution=paused with the reason in explanation, ask one consolidated question and end the response; while a step waits no other step can start and continuation stops. Mark a step completed only after verifying it; the checklist closes when every step is completed or skipped, and a skipped step never reads as completed. Submit the full plan only when steps change; omit plan to keep them, and plan: [] clears the checklist. New plans default to paused unless execution="active" is explicitly supplied; a restored checklist is not running until you confirm execution="active". A paused plan does not imply that work was interrupted. If execution is omitted, revisions keep the current mode. The planning and execution rules live in the system prompt.`,
    parameters: Type.Object({
      execution: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("paused")], { description: "active continues automatically after this response; paused does not." })),
      explanation: Type.Optional(Type.String({ maxLength: 2000 })),
      mark: Type.Optional(Type.Number({ minimum: 1, maximum: 40, description: "Step number in the current checklist; cannot be combined with plan." })),
      status: Type.Optional(Type.Union(planStatuses.map(value => Type.Literal(value)), { description: "waiting blocks on the user; skipped needs reason; completed means verified." })),
      reason: Type.Optional(Type.String({ maxLength: 200, description: "Required for skipped: one short line shown under the step." })),
      plan: Type.Optional(Type.Array(Type.Object({
        step: Type.String({ minLength: 1, maxLength: 300 }), status: Type.Union(planStatuses.map(value => Type.Literal(value))),
        reason: Type.Optional(Type.String({ maxLength: 200 })),
      }), { maxItems: 40, description: "Full revised list in execution order; [] clears the checklist." })),
    }),
    async execute(_id, params, signal) {
      const writes = params.plan !== undefined || params.execution !== undefined || params.explanation !== undefined
        || params.mark !== undefined || params.status !== undefined || params.reason !== undefined;
      const state = await request("update_checklist", { ...params, ...(writes ? { expectedRevision: observedRevision } : {}) }, signal) as { plan?: ConversationPlan };
      const plan = state?.plan;
      observedRevision = plan?.revision ?? 0;
      const response = writes && plan ? { plan: { revision: plan.revision, execution: plan.execution },
        progress: { completed: plan.steps.filter(step => step.status === "completed").length,
          skipped: plan.steps.filter(step => step.status === "skipped").length, total: plan.steps.length } } : state;
      return { content: [{ type: "text", text: JSON.stringify(response) }], details: undefined };
    },
  });
}
