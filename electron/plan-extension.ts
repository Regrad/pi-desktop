import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ConversationPlan } from "../shared/types.js";
import { planContext, planPolicy, planExecutionPolicy, requestedPlanContext } from "../shared/plan.js";
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
  const projectState = stateContext(pi, "desktop_plan_state", ["update_plan"]);
  pi.on("before_agent_start", event => ({ systemPrompt: `${event.systemPrompt}\n\n${planPolicy}\n${planExecutionPolicy}\n${event.systemPrompt.includes(stateFreshnessPolicy) ? "" : stateFreshnessPolicy}` }));
  pi.on("context", event => {
    const plan = readPlan();
    observedRevision = plan?.revision ?? 0;
    const projection = requestedPlanContext(event.messages);
    return { messages: projectState(projection.messages, plan,
      plan ? planContext(plan) : "<pi_desktop_service_context source=\"plan\">Checklist removed. Ignore historical checklist versions.</pi_desktop_service_context>",
      value => String(value?.revision ?? 0), Boolean(plan?.steps.length && plan.execution === "paused"),
      '<pi_desktop_service_context source="plan">Состояние чеклиста: на паузе.</pi_desktop_service_context>') };
  });
  pi.registerTool({
    name: "update_plan", label: "Рабочий план", description: `Read or revise the flexible working checklist. Follow the planning and execution rules in the system prompt. Call {} to read. Submit the full revised plan only when changing steps; omit plan to keep the steps unchanged. To start or resume authorized work, call {execution:"active"}; do not resend unchanged steps. When beginning checklist work in a new run, explicitly confirm execution="active"; restored state alone does not mark a step as currently executing. Before asking for input or approval, set execution=paused and state the reason in explanation. New plans default to paused unless execution="active" is explicitly supplied. If execution is omitted, revisions preserve the current mode; completing all steps or clearing the list stops automatic continuation. A paused plan does not imply that work was interrupted. Pausing disables automatic continuation, not the current response. Ending a normal response does not pause an active plan. plan: [] clears the checklist.`,
    parameters: Type.Object({ execution: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("paused")])), explanation: Type.Optional(Type.String({ maxLength: 2000 })), plan: Type.Optional(Type.Array(Type.Object({
      step: Type.String({ minLength: 1, maxLength: 300 }), status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
    }), { maxItems: 40 })) }),
    async execute(_id, params, signal) {
      const state = await request("update_plan", { ...params, ...(params.plan !== undefined || params.execution !== undefined || params.explanation !== undefined ? { expectedRevision: observedRevision } : {}) }, signal);
      if (state && typeof state === "object") observedRevision = (state as { plan?: ConversationPlan }).plan?.revision ?? 0;
      return { content: [{ type: "text", text: JSON.stringify(state) }], details: undefined };
    },
  });
}
