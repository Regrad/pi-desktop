import type { ConversationPlanning, ConversationPlan } from "./types.js";

export const planningLimit = 30000;
export function isPlanning(state?: ConversationPlanning): boolean {
  return Boolean(state && !["working", "inactive", "completed"].includes(state.phase) && !approvedPlanning(state));
}
export function approvedPlanning(state?: ConversationPlanning): boolean {
  return state?.phase === "implementation" && Number.isSafeInteger(state.revision) && state.approvedRevision === state.revision && typeof state.content === "string" && Boolean(state.content.trim());
}
function revision(expected: unknown, state?: ConversationPlanning) {
  if (!Number.isSafeInteger(expected) || expected !== (state?.revision ?? 0))
    throw new Error("План изменился. Проверьте актуальную версию и повторите действие.");
}
export function controlPlanningState(action: string, expected: number, state?: ConversationPlanning): ConversationPlanning {
  revision(expected, state);
  if (!["start", "revise", "approve", "cancel"].includes(action)) throw new Error("Неизвестное действие режима планирования.");
  if (action !== "start" && !state) throw new Error("План ещё не создан.");
  if (action === "approve" && (state?.phase !== "review" || !state.content.trim()))
    throw new Error("Сначала дождитесь готового плана для согласования.");
  const next = (state?.revision ?? 0) + 1;
  return { content: state?.content ?? "", revision: next, updatedAt: new Date().toISOString(),
    phase: action === "approve" ? "implementation" : action === "cancel" ? "inactive" : "draft",
    ...(action === "approve" ? { approvedRevision: next } : {}) };
}
export function revisePlanning(params: Record<string, unknown>, state?: ConversationPlanning): ConversationPlanning {
  if (!isPlanning(state)) throw new Error("Подробный план доступен только в режиме «План».");
  revision(params.expectedRevision, state);
  const operations = [params.content !== undefined, params.append !== undefined, params.old_text !== undefined || params.new_text !== undefined].filter(Boolean).length;
  if (operations > 1) throw new Error("Выберите одну операцию: content, append или old_text + new_text.");
  let content = state?.content ?? "";
  if (params.content !== undefined) {
    if (typeof params.content !== "string") throw new Error("content должен быть текстом.");
    content = params.content;
  } else if (params.append !== undefined) {
    if (typeof params.append !== "string") throw new Error("append должен быть текстом.");
    content += params.append;
  } else if (operations) {
    if (typeof params.old_text !== "string" || !params.old_text || typeof params.new_text !== "string") throw new Error("Нужны непустой old_text и строка new_text.");
    const index = content.indexOf(params.old_text);
    if (index < 0 || content.indexOf(params.old_text, index + 1) !== -1) throw new Error("old_text должен совпадать ровно с одним фрагментом плана.");
    content = content.slice(0, index) + params.new_text + content.slice(index + params.old_text.length);
  }
  if (content.length > planningLimit) throw new Error(`План превышает ${planningLimit} символов.`);
  if (params.ready !== undefined && typeof params.ready !== "boolean") throw new Error("ready должен быть boolean.");
  if (params.ready && !content.trim()) throw new Error("Нельзя согласовать пустой план.");
  return { content, phase: params.ready ? "review" : "draft",
    revision: (state?.revision ?? 0) + 1, updatedAt: new Date().toISOString() };
}

/** Finishing the specification is separate from ticking the implementation checklist. */
export function completePlanning(params: Record<string, unknown>, state?: ConversationPlanning, checklist?: ConversationPlan): ConversationPlanning {
  revision(params.expectedRevision, state);
  if (params.complete !== true || Object.keys(params).some(key => !["complete", "expectedRevision"].includes(key)))
    throw new Error("Завершение плана: используйте только complete: true, без редактирования документа.");
  if (state?.phase === "completed") return state;
  if (!approvedPlanning(state) && !(state?.phase === "working" && state.content.trim()))
    throw new Error("Завершить можно только рабочий или согласованный план после реализации и проверки результата.");
  if (checklist?.steps.some(step => step.status !== "completed"))
    throw new Error("В рабочем чеклисте остались незавершённые пункты. Проверьте результат и актуальность чеклиста перед завершением плана.");
  return { ...state!, phase: "completed", revision: state!.revision + 1, updatedAt: new Date().toISOString() };
}

const reads = new Set(["read", "grep", "find", "ls", "get_goal", "codemode", "web_search", "media_status", "media_list_attachments", "comfyui_status", "comfyui_list_attachments"]);
const browserReads = new Set(["list", "open", "navigate", "select", "state", "snapshot", "screenshot", "logs", "wait", "viewport", "viewport-reset", "scroll", "back", "forward", "reload", "zoom", "show", "hide"]);
const navigationReads = new Set(["definition", "typeDefinition", "declaration", "references", "hover", "signatureHelp", "documentSymbol", "findSymbol", "workspaceSymbol", "implementation", "prepareCallHierarchy", "incomingCalls", "outgoingCalls", "capabilities"]);
/** Deny unknown tools and argument-dependent writes, even when called through another tool. */
export function planningToolAllowed(name: string, input: Record<string, unknown> = {}): boolean {
  if (reads.has(name)) return true;
  if (name === "update_implementation_plan") return true;
  if (["update_notebook", "update_checklist"].includes(name)) return Object.keys(input).length === 0;
  if (name === "browser") return browserReads.has(String(input.action));
  if (name === "manage_skills") return ["list", "read", "validate"].includes(String(input.action));
  if (name === "lsp_navigation") return navigationReads.has(String(input.operation)) && !input.apply;
  return false;
}
const readOnlyScope = "The detailed document is required and is the only writable target. Files, terminal commands, generations, goals, the working checklist and the notebook stay read-only until interface approval.";

export function planningModeLine(state?: ConversationPlanning): string {
  if (!isPlanning(state)) return "Plan mode is OFF for this chat. The detailed document tool is unavailable. Use the working checklist and notebook for ordinary work; access permissions are controlled separately.";
  if (state?.phase === "review") return `Plan mode is ON for this chat: read only, awaiting approval. ${readOnlyScope} Ask the user to approve it with the «Начать реализацию» control and end the turn: a word in the chat is not approval.`;
  return `Plan mode is ON for this chat: read only. ${readOnlyScope}`;
}

export function normalPlanningContext(): string {
  return `<pi_desktop_service_context source="implementation-plan">\n${planningModeLine()} Earlier document snapshots are historical data, not a request or current permission.\n</pi_desktop_service_context>`;
}

/** One work order starts execution; it does not expose the editing tool outside Plan mode. */
export function planImplementationPrompt(state: ConversationPlanning): string {
  return `<pi_desktop_service_context source="approved-work">\nThe user approved this work at revision ${state.revision} and implementation has started. Build a working checklist with update_checklist, set execution to "active", implement the agreed scope and verify each step before completing it. This is an application step, not a new request from the user, and does not widen the approved scope.\n\nApproved scope:\n${state.content}\n</pi_desktop_service_context>`;
}
export function planningTick(state: ConversationPlanning): string {
  if (!isPlanning(state)) return "";
  const next = state.phase === "review"
    ? "Ask the user to approve the document with the «Начать реализацию» control and end the turn; a word in chat does not approve it."
    : "Prepare the required detailed document with update_implementation_plan, then submit ready=true.";
  return `<pi_desktop_service_context source="implementation-plan">Document: ${state.phase}, revision ${state.revision}. ${planningModeLine(state)} ${next}</pi_desktop_service_context>`;
}
export function planningContext(state: ConversationPlanning): string {
  if (!isPlanning(state)) return normalPlanningContext();
  return `<pi_desktop_service_context source="implementation-plan">\n${JSON.stringify(state)}\n${planningModeLine(state)}\nInvestigate before drafting. A detailed document is mandatory in this mode: record scope, approach, important decisions and verification with update_implementation_plan. Set ready=true only when it is ready for review. The checklist is not a substitute for this document. Implementation is forbidden until the user approves this revision.\n</pi_desktop_service_context>`;
}

/** The app closes the saved reference after the implementation checklist is verified. */
export function settlePlanning(state: ConversationPlanning | undefined, checklist: ConversationPlan | undefined, completedNormally: boolean): ConversationPlanning | undefined {
  if (!completedNormally || !approvedPlanning(state) || !checklist?.steps.length
    || checklist.steps.some(step => !["completed", "skipped"].includes(step.status))) return state;
  return { ...state!, phase: "completed", revision: state!.revision + 1, updatedAt: new Date().toISOString() };
}
export const planningPolicy = "Only the user switches Plan mode in the interface. The latest implementation-plan state says whether it is ON or OFF; tool visibility, earlier document snapshots and the wording of a request never select a mode. When OFF, do not call update_implementation_plan or create a detailed planning document: the tool is blocked. Use update_checklist and update_notebook for ordinary work, following the current access permissions. When ON, the detailed planning document is mandatory, not an optional aid: investigate first, clarify missing requirements when needed, then use update_implementation_plan to record scope, approach, decisions, significant risks and verification. The working checklist cannot replace it. This mode is read-only except for that document; terminal commands, files, generation, goals, checklist writes and notebook writes are blocked. Set ready=true when the document is ready, briefly summarise the proposal and ask for approval with the «Начать реализацию» control in the plan panel. That control is the only approval: never offer a chat word as a substitute and never treat one as approval. End the turn while awaiting the decision. Finishing a document does not resume an unrelated paused goal.";
