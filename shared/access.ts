import type { ConversationAccess, ConversationRecord } from "./types.js";

export const defaultAccess = (): ConversationAccess => ({ mode: "confirm", phase: "idle", revision: 0 });
export const accessLocked = (state?: ConversationAccess): boolean => state?.mode !== "full" && !(state?.mode === "confirm" && state.phase === "approved"
  && Number.isSafeInteger(state.revision) && state.revision > 0 && typeof state.proposal?.description === "string" && Boolean(state.proposal.description.trim()));
export function closeAccess(state?: ConversationAccess): ConversationAccess {
  return { mode: state?.mode ?? "confirm", phase: "idle", revision: (state?.revision ?? 0) + 1 };
}
export function proposeAccess(input: Record<string, unknown>, state?: ConversationAccess): ConversationAccess {
  if (Object.keys(input).some(key => !["description", "targets", "risks"].includes(key))) throw new Error("Разрешение выдаёт только пользователь в интерфейсе.");
  if (typeof input.description !== "string" || !input.description.trim() || input.description.length > 3000)
    throw new Error("Опишите предлагаемые изменения: до 3000 символов.");
  if (input.targets !== undefined && (!Array.isArray(input.targets) || input.targets.length > 20 || input.targets.some(x => typeof x !== "string" || !x.trim() || x.length > 500)))
    throw new Error("Укажите до 20 файлов или объектов изменения.");
  if (input.risks !== undefined && (typeof input.risks !== "string" || input.risks.length > 2000)) throw new Error("Описание рисков: до 2000 символов.");
  return { mode: state?.mode ?? "confirm", phase: "review", revision: (state?.revision ?? 0) + 1,
    proposal: { description: input.description.trim(), targets: input.targets as string[] ?? [], risks: String(input.risks ?? "").trim() } };
}
export function controlAccess(action: string, revision: number, state?: ConversationAccess): ConversationAccess {
  if (!Number.isSafeInteger(revision) || revision !== (state?.revision ?? 0)) throw new Error("Предложение изменилось. Проверьте актуальный вариант.");
  if (action === "full" || action === "confirm") return { ...closeAccess(state), mode: action };
  if (action === "cancel") return closeAccess(state);
  if (action !== "approve" || state?.mode !== "confirm" || state.phase !== "review" || !state.proposal?.description.trim())
    throw new Error("Сначала дождитесь предложения изменений.");
  return { ...state, phase: "approved", started: false, revision: state.revision + 1 };
}
export function accessTaskOpen(conversation: Pick<ConversationRecord, "plan" | "goal" | "planning">): boolean {
  return Boolean(conversation.plan?.steps.some(step => !["completed", "skipped"].includes(step.status))
    || conversation.goal && !["complete", "budget_limited"].includes(conversation.goal.status)
    || conversation.planning && ["implementation", "working"].includes(conversation.planning.phase));
}
export function accessContext(state?: ConversationAccess): string {
  const value = state ?? defaultAccess();
  const status = value.mode === "full" ? "Full access selected by the user."
    : value.phase === "approved" ? (value.started
      ? "The user approved the proposal below and sent a message to begin. Permission covers this task across tool calls and continuation turns, not unrelated tasks or extra scope."
      : "The user granted permission for the proposal below but has not sent a message to begin. Do not start generation, tools or automatic continuation. Wait for the user's next ordinary message.")
    : "Agree first: read-only investigation and discussion. Changes, shell commands, generation and working-checklist writes are blocked. Use request_changes to submit a short concrete proposal, affected targets and material risks, then end the response. Only the user clicking Allow changes grants permission. Questions, clarifications, chat words and checklist activity never grant permission. A detailed planning document is optional; Plan mode is a separate stronger restriction.";
  return `<pi_desktop_service_context source="access">\n${status}\n${JSON.stringify(value)}\nPlan mode, when enabled, still blocks implementation until its document is approved.\n</pi_desktop_service_context>`;
}
export const accessPolicy = "Access is controlled by the latest desktop access state, separately from Plan mode. Never infer permission from a user clarification, a proposed plan, a checklist, historical approval or your own statement that work is approved. In Agree first mode submit request_changes and wait for the interface approval. Do not ask for a chat word as a substitute. In Full access mode follow the user's task and any additional instructions. Access approval covers the specified task, not extra scope; pause keeps it, completion closes it.";
