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
    const messages = project(event.messages, state, state ? planningContext(state) : normalPlanningContext(),
      // A closed or absent document must not read as revision 0: the guard against deferred
      // older snapshots would then drop the message that clears the previous mode.
      value => value ? String(value.revision) : "none",
      Boolean(state && !["inactive", "completed"].includes(state.phase)), state ? planningTick(state) : undefined,
      { changeContent: state && state.phase !== "implementation" ? planningTick(state) : undefined, announceEmpty: true });
    const access = readAccess();
    return { messages: access === undefined ? messages : accessProject(messages, access, accessContext(access), value => String(value.revision), false, undefined, { announceEmpty: true }) };
  });
  pi.on("tool_call", event => {
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
    description: "Propose changes in Agree first access mode. Explain the concrete work, affected files/objects and significant risks ONCE in your normal chat reply, then register that same scope here. The interface shows only compact approval controls, not a second copy of this text. Do not announce that a proposal/card was sent or repeat the interface instructions. This tool grants no permission. End the response and wait for interface approval and the user's next message. Clarifications only revise the proposal. In Plan mode use the planning document's review instead. Call {} to read the current access state.",
    parameters: Type.Object({ description: Type.Optional(Type.String({ maxLength: 3000 })), targets: Type.Optional(Type.Array(Type.String({ maxLength: 500 }), { maxItems: 20 })), risks: Type.Optional(Type.String({ maxLength: 2000 })) }),
    async execute(_id, params, signal) {
      const result = await request("request_changes", params, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
    },
  });
  pi.registerTool({
    name: "update_implementation_plan", label: "План реализации",
    description: "Read or revise the detailed task specification, separate from the working checklist. Call {} to read the full document; writes confirm revision and phase without repeating its text. Available in both normal and PLAN modes; create or revise a plan whenever useful. Choose one edit: content replaces the document, append adds text, old_text + new_text replaces one unique literal fragment (empty new_text deletes it). In Plan mode set ready=true when ready for user review, then wait for approval. In normal mode writing a plan or setting ready=true does not switch modes or require approval; continue work already authorized by the user. After implementing a working or approved plan and verifying the whole result, call {complete:true} to mark the document completed. Completion is separate from checklist marks; any existing checklist must be finished. Do not combine completion with edits. Read again after a revision conflict.",
    parameters: Type.Object({ content: Type.Optional(Type.String({ maxLength: planningLimit })), append: Type.Optional(Type.String({ maxLength: planningLimit })),
      old_text: Type.Optional(Type.String()), new_text: Type.Optional(Type.String()), ready: Type.Optional(Type.Boolean()), complete: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal) {
      const writing = Object.keys(params).length > 0;
      const result = await request("update_implementation_plan", { ...params, ...(writing ? { expectedRevision: observedRevision } : {}) }, signal) as { planning?: ConversationPlanning };
      observedRevision = result.planning?.revision ?? 0;
      const response = writing && result.planning ? { planning: { revision: result.planning.revision, phase: result.planning.phase, updatedAt: result.planning.updatedAt } } : result;
      return { content: [{ type: "text", text: JSON.stringify(response) }], details: undefined };
    },
  });
}
