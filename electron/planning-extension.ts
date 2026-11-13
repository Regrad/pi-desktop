import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ConversationPlanning } from "../shared/types.js";
import { isPlanning, planningContext, planningTick, planningLimit, planningPolicy, planningToolAllowed } from "../shared/planning.js";
import { requestGoal } from "./goal-extension.js";
import { stateContext } from "./state-context.js";

// JS resources live at the app root, not inside the compiler's dist-electron tree.
const appRoot = process.env.PI_DESKTOP_APP_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
export const { readDesktopPlanning } = createRequire(import.meta.url)(path.join(appRoot, "resources", "tool-routing", "desktop-planning-permissions.js")) as typeof import("../resources/tool-routing/desktop-planning-permissions.js");

/** Based on Pi's official examples/extensions/plan-mode: live tool_call permissions,
 * persisted mode, contextual reminder and user review. Unlike the example, keep
 * the tool loadout and system prompt identical across modes for local KV caching.
 */
export default function planningExtension(pi: ExtensionAPI, read = readDesktopPlanning, request = requestGoal) {
  let observedRevision = read()?.revision ?? 0;
  const project = stateContext(pi, "desktop_implementation_plan_state", ["update_implementation_plan"], "planning");
  const locked = () => isPlanning(read());
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
  pi.on("before_agent_start", event => ({ systemPrompt: `${event.systemPrompt}\n\n${planningPolicy}` }));
  pi.on("context", event => {
    const state = read();
    observedRevision = state?.revision ?? 0;
    return { messages: project(event.messages, state, state ? planningContext(state) : undefined, value => String(value?.revision ?? 0),
      Boolean(state && !["inactive", "completed"].includes(state.phase)), state ? planningTick(state) : undefined,
      { changeContent: state && state.phase !== "implementation" ? planningTick(state) : undefined }) };
  });
  pi.on("tool_call", event => {
    if (!locked()) return;
    if (event.toolName === "web_search") {
      (event.input as Record<string, unknown>).workflow = "none";
      (event.input as Record<string, unknown>).includeContent = false;
    }
    if (event.toolName === "fetch_content" && !(event.input as Record<string, unknown>).mode)
      (event.input as Record<string, unknown>).mode = "raw";
    if (!planningToolAllowed(event.toolName, event.input)) return {
      block: true,
      reason: "PLAN mode: action blocked. Read-only investigation and updates to the planning document are allowed; implementation requires user approval.",
    };
  });
  pi.on("user_bash", () => {
    if (locked()) return { result: { output: "Команды терминала недоступны в режиме «План».", exitCode: 1, cancelled: false, truncated: false } };
  });
  pi.registerTool({
    name: "update_implementation_plan", label: "План реализации",
    description: "Read or revise the detailed task specification, separate from the working checklist. Call {} to read the full document; writes confirm revision and phase without repeating its text. Available in both normal and PLAN modes; create or revise a plan whenever useful. Choose one edit: content replaces the document, append adds text, old_text + new_text replaces one unique literal fragment (empty new_text deletes it). In PLAN mode set ready=true when ready for user review, then wait for approval. In normal mode writing a plan or setting ready=true does not switch modes or require approval; continue work already authorized by the user. After implementing a working or approved plan and verifying the whole result, call {complete:true} to mark the document completed. Completion is separate from checklist marks; any existing checklist must be finished. Do not combine completion with edits. Read again after a revision conflict.",
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
