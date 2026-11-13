import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ConversationPlan } from "../shared/types.js";
import { planContext, planPolicy, planExecutionPolicy, planTick, requestedPlanContext } from "../shared/plan.js";
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
      value => String(value?.revision ?? 0), Boolean(plan?.steps.some(step => step.status !== "completed")),
      plan ? planTick(plan) : undefined, { refreshTurns: plan?.execution === "active" ? 3 : 0 }) };
  });
  pi.registerTool({
    name: "update_plan", label: "Рабочий план", description: `Read or revise the flexible working checklist. Follow the planning and execution rules in the system prompt. Call {} to read the full list; writes confirm revision, execution and progress without repeating steps. Submit the full revised plan only when changing steps; omit plan to keep the steps unchanged. To start or resume authorized work, call {execution:"active"}; do not resend unchanged steps. When beginning checklist work in a new run, explicitly confirm execution="active"; restored state alone does not mark a step as currently executing. Before asking for input or approval, set execution=paused and state the reason in explanation. New plans default to paused unless execution="active" is explicitly supplied. If execution is omitted, revisions preserve the current mode; completing all steps or clearing the list stops automatic continuation. A paused plan does not imply that work was interrupted. Pausing disables automatic continuation, not the current response. Ending a normal response does not pause an active plan. plan: [] clears the checklist. Mark one step without resending the list: {mark: N, status} where N is the 1-based position in the current checklist; mark and plan cannot be combined, and status needs mark. A checklist tick in a later turn only reports progress: mark what you already finished instead of leaving statuses behind.`,
    parameters: Type.Object({ execution: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("paused")])), explanation: Type.Optional(Type.String({ maxLength: 2000 })), mark: Type.Optional(Type.Number({ minimum: 1, maximum: 40 })), status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")])), plan: Type.Optional(Type.Array(Type.Object({
      step: Type.String({ minLength: 1, maxLength: 300 }), status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
    }), { maxItems: 40 })) }),
    async execute(_id, params, signal) {
      const writes = params.plan !== undefined || params.execution !== undefined || params.explanation !== undefined || params.mark !== undefined || params.status !== undefined;
      const state = await request("update_plan", { ...params, ...(writes ? { expectedRevision: observedRevision } : {}) }, signal) as { plan?: ConversationPlan };
      const plan = state?.plan;
      observedRevision = plan?.revision ?? 0;
      const response = writes && plan ? { plan: { revision: plan.revision, execution: plan.execution },
        progress: { completed: plan.steps.filter(step => step.status === "completed").length, total: plan.steps.length } } : state;
      return { content: [{ type: "text", text: JSON.stringify(response) }], details: undefined };
    },
  });
}
