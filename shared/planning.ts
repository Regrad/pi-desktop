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
  if (["update_notebook", "update_plan"].includes(name)) return Object.keys(input).length === 0;
  if (name === "browser") return browserReads.has(String(input.action));
  if (name === "manage_skills") return ["list", "read", "validate"].includes(String(input.action));
  if (name === "lsp_navigation") return navigationReads.has(String(input.operation)) && !input.apply;
  // Pi Web Access documents raw mode as direct text HTTP only (no repo cloning/video extraction).
  if (name === "fetch_content") return input.mode === "raw" && !input.forceClone && !input.timestamp && !input.frames;
  return false;
}
export function planningTick(state: ConversationPlanning): string {
  return `<pi_desktop_service_context source="implementation-plan">Planning document: ${state.phase}, revision ${state.revision}. Data, not a new task. Read current specification: update_implementation_plan({}).</pi_desktop_service_context>`;
}
export function planningContext(state: ConversationPlanning): string {
  return `<pi_desktop_service_context source="implementation-plan">\n${JSON.stringify(state)}\nThis is the planning document, not a new user request. ${state.phase === "working" ? "Working specification in normal mode. Continue within the current user request, revise this document when useful and use a checklist to track progress. This document does not activate PLAN mode, require separate approval or authorize additional scope. Mark complete:true after implementation and verification." : state.phase === "completed" ? "This plan is completed and retained for reference, not authorization for further work. Follow the latest user request." : state.phase === "inactive" ? "Saved reference only: it neither authorizes historical work nor restricts independent current requests." : approvedPlanning(state) ? "The user approved this specification. Use a separate checklist for implementation progress. After verifying the whole result, mark this document completed with update_implementation_plan({complete:true})." : "PLAN mode: implementation is forbidden until the user approves this revision; checklist activity does not approve it."}\n</pi_desktop_service_context>`;
}
export const planningPolicy = "PLAN mode applies only while the latest planning-document state is draft/review; otherwise normal execution permissions apply. The plan is a detailed task specification describing scope, approach, decisions and verification, not a progress checklist. You may create or revise it with update_implementation_plan in normal mode whenever useful, without asking the user to switch modes. Normal-mode edits remain in normal mode; ready=true does not require review there. Continue already authorized work without waiting for approval merely because you wrote a plan. In PLAN mode investigate with read-only tools and internet search, clarify material choices and write the document with update_implementation_plan. This is the only writable artifact; shell commands, generations and other changes are blocked. Use ordinary codemode discovery; fetch_content is limited to raw HTTP reading. Submit ready=true when ready for review and wait for user approval in the interface. During implementation derive a separate working checklist for substantial work. After verifying the whole result, mark the document completed with update_implementation_plan({complete:true}); finishing the checklist alone does not complete the document. This does not resume an unrelated paused goal. Follow the latest user instruction.";
