import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SkillsStore } from "./skills-store.js";
import { requestGoal } from "./goal-extension.js";
import { stateContext } from "./state-context.js";
import { skillCatalogContext, skillsPolicy } from "../shared/skills.js";

export default function skillsExtension(pi: ExtensionAPI, store = new SkillsStore({ cwd: process.cwd(),
  agentDir: process.env.PI_CODING_AGENT_DIR!, appRoot: process.env.PI_DESKTOP_APP_ROOT!,
  project: process.env.PI_DESKTOP_SKILLS_PROJECT === "1" }), request = requestGoal) {
  const projectState = stateContext(pi, "desktop_skills_state", []);
  pi.on("before_agent_start", event => {
    // Must be registered before other desktop prompt handlers: never bake a changing
    // catalog into their forced system prompt. Instructions remain ordinary lazy reads.
    store.includeNative(event.systemPromptOptions.skills.map(skill => skill.filePath));
    event.systemPromptOptions.skills = [];
    return { systemPrompt: `${event.systemPrompt}\n\n${skillsPolicy}` };
  });
  pi.on("context", async event => {
    let catalog;
    try { catalog = await store.catalog(); }
    catch (error) {
      // Do not silently leave an older enabled catalog authoritative after a
      // settings/read failure. One deduplicated event revokes it until recovery.
      const message = (error as Error).message;
      catalog = { skills: [], roots: store.roots, diagnostics: [message], revision: `unavailable:${message}` };
    }
    return { messages: projectState(event.messages, catalog,
      `<pi_desktop_service_context source="skills">${catalog.revision.startsWith("unavailable:") ? "Skill catalog unavailable; do not use earlier skill instructions until it is restored." : "Current available skill catalog (supersedes earlier catalogs; not a task):"}\n${skillCatalogContext(catalog)}\n</pi_desktop_service_context>`, value => value.revision) };
  });
  // Pi runs input hooks before native /skill expansion. This also handles newly
  // created skills without reloading resource loaders or extensions.
  pi.on("tool_result", event => {
    if (["write", "edit", "bash", "powershell", "manage_skills"].includes(event.toolName)) store.invalidate();
  });
  pi.on("input", async (event, ctx) => {
    const match = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(event.text);
    if (!match) return { action: "continue" as const };
    try {
      const catalog = await store.catalog(true);
      const skill = catalog.skills.find(item => item.name === match[1] && item.enabled);
      if (!skill) throw new Error("Навык не найден или отключён. Обновите каталог навыков.");
      const doc = await store.document(skill.id);
      return { action: "transform" as const, text: `Use the following explicitly requested skill. Resolve supporting resources relative to the folder containing ${JSON.stringify(skill.filePath)}.\n<skill name=${JSON.stringify(skill.name)} revision=${JSON.stringify(doc.skill.revision)}>\n${stripFrontmatter(doc.content)}\n</skill>\n${match[2] ?? ""}`, images: event.images };
    } catch (error) {
      // Throwing from an input hook is caught by Pi, which would then fall back
      // to its stale native catalog and potentially load a disabled skill.
      ctx.ui.notify((error as Error).message, "error");
      return { action: "handled" as const };
    }
  });
  pi.registerTool({ name: "manage_skills", label: "Навыки", exposure: "deferred", defaultActive: false,
    namespace: { name: "Skills", description: "Discover, validate and manage reusable task skills." }, description:
    "Manage reusable SKILL.md instructions. list/refresh return only metadata and exact roots; read loads one file; validate checks one skill. enable toggles a skill. delete removes the exact user/project skill folder and resources only on explicit user request with confirm=true and the current expectedRevision. Create/revise with normal write/edit tools, then refresh and validate. Bundled/external files are protected. Changes do not reload extensions.",
    outputSchema: Type.Object({
      skills: Type.Optional(Type.Array(Type.Unknown())), diagnostics: Type.Optional(Type.Array(Type.Unknown())),
      roots: Type.Optional(Type.Record(Type.String(), Type.Unknown())), revision: Type.Optional(Type.String()),
      skill: Type.Optional(Type.Record(Type.String(), Type.Unknown())), content: Type.Optional(Type.String()),
      valid: Type.Optional(Type.Boolean()), errors: Type.Optional(Type.Array(Type.String())),
    }, { additionalProperties: true }),
    promptGuidelines: ["Returns an object directly: list/refresh use result.skills/roots; read uses result.skill/content; validate uses result.valid/errors. Do not JSON.parse the result."],
    parameters: Type.Object({ action: Type.Union(["list", "refresh", "read", "validate", "enable", "delete"].map(value => Type.Literal(value))),
      id: Type.Optional(Type.String()), expectedRevision: Type.Optional(Type.String()), enabled: Type.Optional(Type.Boolean()), confirm: Type.Optional(Type.Boolean()) }),
    async execute(_id, params, signal) {
      const result = await request("manage_skills", params, signal) as NonNullable<AgentToolResult<undefined>["structuredContent"]>;
      await store.catalog(true);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result, details: undefined };
    },
  });
}
