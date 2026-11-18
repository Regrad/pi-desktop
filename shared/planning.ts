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
  return { content, phase: isPlanning(state) ? (params.ready ? "review" : "draft") : "working",
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

const reads = new Set(["read", "grep", "find", "ls", "get_goal", "codemode", "web_search", "get_search_content", "media_status", "media_list_attachments", "comfyui_status", "comfyui_list_attachments"]);
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
  // Pi Web Access documents raw mode as direct text HTTP only (no repo cloning/video extraction).
  if (name === "fetch_content") return input.mode === "raw" && !input.forceClone && !input.timestamp && !input.frames;
  return false;
}
const readOnlyScope = "The planning document is the only writable target: files, the terminal, generations, goals, the working checklist and the notebook stay read-only. Tool availability is the same in both modes, so a blocked write answers with the reason instead of a missing tool.";
const fullAccessScope = "Only the user switches Plan mode, in the interface; a document, a working checklist or the update_implementation_plan tool never does. Rules elsewhere that ask for the user's consent govern approval, not this mode.";

/** The only statement of what the model may execute right now; every state message starts with it. */
export function planningModeLine(state?: ConversationPlanning): string {
  if (!isPlanning(state)) return `Plan mode is OFF for this chat: full access. ${fullAccessScope}`;
  const current = state as ConversationPlanning;
  if (current.phase === "review") return `Plan mode is ON for this chat: read only, the document waits for the user's approval. ${readOnlyScope} Ask the user to approve it with the «Начать реализацию» control in the plan panel and end the turn: a word in the chat is not approval, so never offer one, and start nothing until a newer state message says the plan was approved.`;
  if (current.phase === "implementation") return `Plan mode is ON again for this chat: the approved document changed or became empty, so it needs approval once more. ${readOnlyScope}`;
  return `Plan mode is ON for this chat: read only. ${readOnlyScope}`;
}
/** Reminder form of the same fact; it never differs from planningModeLine. */
function planningModeShort(state?: ConversationPlanning): string {
  if (!isPlanning(state)) return "Plan mode is OFF (full access)";
  const current = state as ConversationPlanning;
  if (current.phase === "implementation") return "Plan mode is ON again (read only: approval was lost)";
  return current.phase === "review" ? "Plan mode is ON (read only: awaiting approval)" : "Plan mode is ON (read only)";
}
/** Emitted while no planning document exists, so the absence of one is never guessed. */
export function normalPlanningContext(): string {
  return `<pi_desktop_service_context source="implementation-plan">\nNo planning document in this chat. ${planningModeLine()}\nA planning document from earlier in this chat that no newer state message describes is closed and no longer restricts work; it authorizes nothing by itself.\n</pi_desktop_service_context>`;
}
/** Each phase gets the rule of its own moment, never the rule of a neighbouring phase. */
/** Starting the approved work is an application step: the engine receives it as a service
 * message, so nothing lands in the chat as if the user had typed the instruction. */
export function planImplementationPrompt(state: ConversationPlanning): string {
  return `<pi_desktop_service_context source="implementation-plan">\nThe user approved this planning document at revision ${state.revision} and implementation has started. Plan mode is OFF for this chat: full access. Build a working checklist from the approved items with update_checklist, set execution to "active", then implement the document: keep it current when a decision changes and mark steps once they are verified. This is an application step, not a new request from the user, and it does not widen the approved scope.\n</pi_desktop_service_context>`;
}
export function planningTick(state: ConversationPlanning): string {
  const mode = planningModeShort(state);
  let note = `${mode}. Prepare the document, then submit ready=true.`;
  if (state.phase === "review") note = `${mode}. Summarise what you propose, ask the user to approve the plan with the «Начать реализацию» control and end the turn; you may answer questions or revise the document, but start nothing else, because a word in chat does not approve it.`;
  else if (state.phase === "implementation") note = isPlanning(state)
    ? `${mode}. Ask the user to approve the changed document before any implementation.`
    : `${mode}. Work from the approved document: check each next step against it and revise it when a decision changes.`;
  else if (state.phase === "working") note = `${mode}. Work from this document: check each next step against it, revise it when a decision changes and mark it complete:true once verified.`;
  else if (state.phase === "completed" || state.phase === "inactive") note = `${mode}. Saved reference for this chat; read the text with update_implementation_plan({}).`;
  return `<pi_desktop_service_context source="implementation-plan">Planning document: ${state.phase}, revision ${state.revision}. ${note}</pi_desktop_service_context>`;
}
export function planningContext(state: ConversationPlanning): string {
  return `<pi_desktop_service_context source="implementation-plan">\n${JSON.stringify(state)}\n${planningModeLine(state)} This is the planning document, not a new user request. ${state.phase === "working" ? "Working specification in normal mode. Continue within the current user request, revise this document when useful and use a checklist to track progress. This document does not activate Plan mode, require separate approval or authorize additional scope. Mark complete:true after implementation and verification." : state.phase === "completed" ? "This plan is completed and retained for reference, not authorization for further work. Follow the latest user request." : state.phase === "inactive" ? "Saved reference only: it neither authorizes historical work nor restricts independent current requests." : approvedPlanning(state) ? "The user approved this specification. Use a separate checklist for implementation progress. After verifying the whole result, mark this document completed with update_implementation_plan({complete:true})." : "Plan mode: implementation is forbidden until the user approves this revision, and checklist activity does not approve it. Read-only investigation and this document are the only allowed work."}\n</pi_desktop_service_context>`;
}
export const planningPolicy = "A chat runs in one of two access modes and only the interface switches between them. Plan mode, where the user sees the label «План · только чтение», is read-only work: investigate, ask, discuss and write the planning document, while nothing else may change until the user approves it. Full access, where the user sees «Полный доступ», is ordinary work: change files, run commands and finish the task as asked. Every message with source=\"implementation-plan\" begins with the current mode, and that line is the only source of this fact: the availability of update_implementation_plan, the wording of a request, an existing document or a working checklist never indicates a mode. Reserve the planning document for genuinely complex work: scope, approach, decisions and verification, separate from the working checklist. For ordinary requests work directly and explain the approach in your reply; call update_implementation_plan({}) whenever you need the text of a document that already exists. In full access a document is a working specification: writing it or setting ready=true gates nothing, so carry on with work the user authorized and mark it complete:true once it is implemented and verified. In Plan mode the document is the only writable target; when it is ready set ready=true, summarise what you propose, ask the user to approve it with the «Начать реализацию» control in the plan panel and end the turn. That control is the only approval: never offer a chat word such as «делай» as a substitute and never treat one as approval. Keep three things apart: the mode, the planning document and the working checklist of update_checklist, because a checklist organizes steps and grants no permissions. While in Plan mode research with read-only means: codemode without model calls, web_search, and fetch_content in raw mode. Finishing a document does not resume an unrelated paused goal. Follow the latest user instruction.";
