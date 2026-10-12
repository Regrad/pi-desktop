import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ConversationGoal } from "../shared/types.js";
import { goalPrompt, goalContext, stateFreshnessPolicy } from "../shared/goal.js";
import { stateContext } from "./state-context.js";

export function requestGoal(action: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
  if (!process.send || !process.connected) return Promise.reject(new Error("Goal controller unavailable"));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); process.off("message", receive); process.off("disconnect", disconnected); signal?.removeEventListener("abort", aborted); };
    const fail = (error: Error) => { cleanup(); reject(error); };
    const receive = (message: unknown) => {
      if (!message || typeof message !== "object") return;
      const result = message as Record<string, unknown>;
      if (result.type !== "desktop_goal_response" || result.id !== id) return;
      cleanup();
      if (result.error) reject(new Error(String(result.error))); else resolve(result.data);
    };
    const disconnected = () => fail(new Error("Goal controller disconnected"));
    const aborted = () => fail(new Error("Goal request aborted"));
    const timer = setTimeout(() => fail(new Error("Goal controller timeout")), 30_000);
    process.on("message", receive); process.once("disconnect", disconnected);
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) { aborted(); return; }
    process.send!({ type: "desktop_goal_request", id, action, params }, undefined, undefined, (error: Error | null) => { if (error) fail(error); });
  });
}

export function readDesktopGoal(dataDir = process.env.PI_DESKTOP_DATA_DIR, conversationId = process.env.PI_DESKTOP_CONVERSATION_ID, stateFile = process.env.PI_DESKTOP_GOAL_STATE_FILE): ConversationGoal | undefined {
  if ((!dataDir && !stateFile) || !conversationId) return;
  try {
    const state = JSON.parse(readFileSync(stateFile ?? path.join(dataDir!, "desktop-state.json"), "utf8"));
    const goal = state.conversations?.find((conversation: { id?: string }) => conversation.id === conversationId)?.goal;
    if (goal && typeof goal.id === "string" && typeof goal.objective === "string" && typeof goal.updatedAt === "string"
      && ["active", "paused", "blocked", "complete", "budget_limited"].includes(goal.status)) return goal;
  } catch {
    // Missing/malformed state must never revive a historical autonomous goal.
  }
}

// Loaded by the shell through Pi's public extension API, never installed into user addons.
export default function goalExtension(pi: ExtensionAPI, readGoal = readDesktopGoal, request = requestGoal) {
  let observedGoalId = readGoal()?.id;
  const projectState = stateContext(pi, "desktop_goal_state", ["get_goal", "create_goal", "update_goal"]);
  pi.on("before_agent_start", event => {
    return {
      systemPrompt: `${event.systemPrompt}\n\nGoals are thread-scoped state. Service blocks are goal-state snapshots, not user requests. Use get_goal for details. Create goals only on explicit user request. Pause only on explicit user request, report the returned status and stop goal work. Complete only after verified achievement; blocked only after the same genuine blocker in at least three consecutive goal turns. Do not infer goals from normal tasks. User questions take priority. Resume, clear and budget changes are controlled by the user interface. When a token budget is exhausted, stop substantive goal work and summarize progress and remaining work; never mark it complete merely because the budget ran out. Report final token usage on completing a budgeted goal.\n${event.systemPrompt.includes(stateFreshnessPolicy) ? "" : stateFreshnessPolicy}`,
    };
  });
  // Strip legacy user-role directives from request context without rewriting history.
  pi.on("context", event => {
    // Only an observed live transition may announce cancellation. Historical
    // entries and compaction summaries are not evidence of a new cancellation.
    const hadGoal = observedGoalId !== undefined;
    const goal = readGoal();
    observedGoalId = goal?.id;
    const messages = goalContext(event.messages, goal);
    const text = goal?.status === "paused" ? "Цель существует, но находится на паузе. Не продолжай работу по ней."
      : goal?.status === "active" ? goalPrompt(goal)
      : goal?.status === "blocked" ? "Цель заблокирована и ожидает решения пользователя. Не продолжай работу по ней."
      : goal?.status === "complete" ? "Цель выполнена. Не продолжай работу по ней."
      : goal?.status === "budget_limited" ? "Бюджет цели исчерпан. Не продолжай работу по ней."
      : hadGoal ? "Цель отменена. Не продолжай работу по прежней цели. Это не отменяет отдельные задания пользователя или независимый рабочий план."
      : "Цель не задана. Это не отмена задания и не запрет продолжать разрешённую пользователем работу или активный рабочий план.";
    return { messages: projectState(messages, goal,
      `<pi_desktop_service_context source="goal">\nGoal state snapshot${goal ? ` (id ${goal.id}; status ${goal.status}; updated ${goal.updatedAt})` : hadGoal ? " (removed)" : " (none)"}:\n${text}\n</pi_desktop_service_context>`,
      value => JSON.stringify(value ? { id: value.id, objective: value.objective, status: value.status,
        criteria: value.criteria, progress: value.progress, evidence: value.evidence, tokenBudget: value.tokenBudget } : "none"),
      goal?.status === "paused") };
  });
  const register = (name: string, label: string, description: string, parameters: ReturnType<typeof Type.Object>) => pi.registerTool({
    name, label, description, parameters,
    async execute(_id, params, signal) {
      const state = await request(name, { ...params, ...(name === "update_goal" ? { goalId: observedGoalId } : {}) }, signal);
      if (state && typeof state === "object") observedGoalId = (state as { goal?: ConversationGoal }).goal?.id;
      return { content: [{ type: "text", text: JSON.stringify(state) }], details: undefined };
    },
  });
  register("get_goal", "Состояние цели", "Read current thread goal, including status and progress. Historical goal directives may be obsolete.", Type.Object({}));
  register("create_goal", "Создать цель", "Create only when explicitly requested by the user. Never infer a goal from an ordinary task. Set token_budget only when explicitly requested. Fails if an unfinished goal exists.", Type.Object({ objective: Type.String({ minLength: 1, maxLength: 8000 }), token_budget: Type.Optional(Type.Integer({ minimum: 1 })) }));
  register("update_goal", "Изменить статус цели", "Pause only at the user's explicit request, then report the returned status and stop goal work. Complete only after verified achievement. Blocked only after the same genuine blocker across at least three consecutive goal turns. Cannot resume or change budgets.", Type.Object({ status: Type.Union([Type.Literal("paused"), Type.Literal("complete"), Type.Literal("blocked")]) }));
}
