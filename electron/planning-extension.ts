import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ConversationPlanning } from "../shared/types.js";
import { isPlanning, normalPlanningContext, planningContext, planningTick, planningLimit, planningPolicy, planningToolAllowed } from "../shared/planning.js";
import { requestGoal } from "./goal-extension.js";
import { stateContext } from "./state-context.js";
import { accessContext, accessLocked, accessPolicy } from "../shared/access.js";

// JS resources live at the app root, not inside the compiler's dist-electron tree.
const appRoot = process.env.PI_DESKTOP_APP_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
export const { readDesktopPlanning, readDesktopAccess } = createRequire(import.meta.url)(path.join(appRoot, "resources", "tool-routing", "desktop-planning-permissions.js")) as typeof import("../resources/tool-routing/desktop-planning-permissions.js");

/** Based on Pi's official examples/extensions/plan-mode: live tool_call permissions,
 * persisted mode, contextual reminder and user review. Unlike the example, keep
 * the tool loadout and system prompt identical across modes for local KV caching.
 */
export default function planningExtension(pi: ExtensionAPI, read = readDesktopPlanning, request = requestGoal, readAccess = readDesktopAccess) {
  let observedRevision = read()?.revision ?? 0;
  const project = stateContext(pi, "desktop_implementation_plan_state", ["update_implementation_plan"], "planning");
  const locked = () => isPlanning(read());
  const accessProject = stateContext(pi, "desktop_access_state", ["request_changes"], "access");
  const accessRestricted = () => { const state = readAccess(); return state !== undefined && accessLocked(state); };
  pi.on("session_start", (_event, ctx) => {
    // Native read-only primitives are available in BOTH modes, not a second tool gateway.
    const inventory = new Set(pi.getAllTools().map(tool => tool.name));
    for (const create of [createGrepToolDefinition, createFindToolDefinition, createLsToolDefinition]) {
      const tool = create(ctx.cwd);
      if (!inventory.has(tool.name)) pi.registerTool(tool);
    }
    pi.setActiveTools([...new Set([...pi.getActiveTools(), "grep", "find", "ls"])]);
  });
  // The policy never depends on the current mode: only the tail state message changes.
  pi.on("before_agent_start", event => ({ systemPrompt: `${event.systemPrompt}\n\n${planningPolicy}\n${accessPolicy}` }));
  pi.on("context", event => {
    const state = read();
    observedRevision = state?.revision ?? 0;
    const active = isPlanning(state) ? state : undefined;
    const messages = project(event.messages, active, active ? planningContext(active) : normalPlanningContext(),
      // A closed or absent document must not read as revision 0: the guard against deferred
      // older snapshots would then drop the message that clears the previous mode.
      value => value ? String(value.revision) : "none",
      // A live document stays in view on every turn, like the checklist does; finished
      // and removed documents go quiet. Reading the full text stays the model's choice.
      Boolean(active), active ? planningTick(active) : undefined,
      { changeContent: active ? planningTick(active) : undefined, announceEmpty: true });
    const access = readAccess();
    return { messages: access === undefined ? messages : accessProject(messages, access, accessContext(access), value => String(value.revision), false, undefined, { announceEmpty: true }) };
  });
  pi.on("tool_call", event => {
    if (event.toolName === "update_implementation_plan" && !locked()) return {
      block: true, reason: "The detailed document is available only in Plan mode. Use the checklist and notebook for ordinary work.",
    };
    if (!locked() && !accessRestricted()) return;
    if (!locked() && event.toolName === "request_changes") return;
    if (!planningToolAllowed(event.toolName, event.input)) return {
      block: true,
      reason: "Read-only access: changes are blocked. In Plan mode submit the document for review; otherwise use request_changes and wait for the user's interface approval. A checklist or chat reply cannot grant permission.",
    };
  });
  pi.on("user_bash", () => {
    if (locked() || accessRestricted()) return { result: { output: "Команды терминала недоступны до согласования изменений.", exitCode: 1, cancelled: false, truncated: false } };
  });
  pi.registerTool({ name: "request_changes", label: "Согласование изменений",
    description: "Request approval for the proposal you just explained ONCE in visible chat text, including scope and significant risks. Call with {} as your final action. Pi Desktop captures that message and ends the turn automatically. Do not repeat the proposal in arguments, announce a card, or add a waiting reply. This grants no permission: wait for interface approval and the user's next message. In Plan mode use the planning document's review instead. Current access state is provided in context.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute(id, _params, signal) {
      const result = await request("request_changes", { toolCallId: id }, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
    },
  });
  pi.registerTool({
    name: "update_implementation_plan", label: "План реализации",
    description: "Use ONLY in Plan mode, where the detailed document is mandatory. Outside that mode this tool is blocked; use update_checklist and update_notebook for ordinary work. Investigate first, then record scope, approach, decisions and verification. Call {} to read the document. Choose one edit: content replaces it, append adds text, old_text + new_text replaces one unique literal fragment. Set ready=true when it is ready for review, briefly explain the proposal and wait for the user's approval in the plan panel. Writes acknowledge revision and phase without repeating the text.",
    parameters: Type.Object({ content: Type.Optional(Type.String({ maxLength: planningLimit })), append: Type.Optional(Type.String({ maxLength: planningLimit })),
      old_text: Type.Optional(Type.String()), new_text: Type.Optional(Type.String()), ready: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal) {
      if (!locked()) throw new Error("Подробный план доступен только в режиме «План».");
      const writing = Object.keys(params).length > 0;
      const result = await request("update_implementation_plan", { ...params, ...(writing ? { expectedRevision: observedRevision } : {}) }, signal) as { planning?: ConversationPlanning };
      observedRevision = result.planning?.revision ?? 0;
      const response = writing && result.planning ? { planning: { revision: result.planning.revision, phase: result.planning.phase, updatedAt: result.planning.updatedAt } } : result;
      return { content: [{ type: "text", text: JSON.stringify(response) }], details: undefined };
    },
  });
}
