// Host-wide exposure policy; execution remains Pi's native ctx.executeTool pipeline.
const directTools = new Set([
  "read", "bash", "powershell", "edit", "write", "grep", "find", "ls",
  "get_goal", "create_goal", "update_goal", "desktop_goal_report", "update_plan", "update_notebook", "codemode",
]);
const retiredLoaders = new Set(["tool_search", "pi_lens_activate_tools", "mcpScript"]);
const routed = Symbol("pi-desktop/routed-tool");
const resultSchema = {
  type: "object", required: ["content"], properties: {
    content: { type: "array", items: { type: "object", additionalProperties: true } },
    details: {}, isError: { type: "boolean" },
  }, additionalProperties: true,
};
const resultGuideline = "Codemode returns {content, details, isError}. Show text blocks with text(block.text) and image blocks with image(block); never print base64. Check isError. Audio and 3D paths are in details; no audio is supplied for listening.";

export function routingEnabled() { return process.env.PI_DESKTOP_TOOL_ROUTING === "1"; }

function toolNamespace(tool, source) {
  if (tool.namespace) return tool.namespace;
  const value = `${source ?? ""} ${tool.name}`.toLowerCase();
  const groups = [
    ["skills", "Skills", "Discover, validate and manage reusable task skills."],
    ["browser", "Browser", "Browser tabs, navigation, screenshots and page interaction."],
    ["comfy", "ComfyUI", "Local image, music, voice and 3D generation and editing."],
    ["pi-lens", "CodeAnalysis", "LSP, diagnostics, code navigation, linting and refactoring."],
    ["pi-web-access", "Web", "Internet search and reading pages and documents."],
    ["mcp", "MCP", "MCP server discovery, configuration and tools, including computer control."],
    ["computer", "Computer", "Computer screenshots and interaction."],
  ];
  const group = groups.find(([key]) => value.includes(key));
  return group ? { name: group[1], description: group[2] }
    : { name: "Addons", description: "Additional installed tools; discover their descriptions before use." };
}

export function routeTool(tool, source) {
  if (!routingEnabled() || tool[routed] || directTools.has(tool.name)) return tool;
  if (retiredLoaders.has(tool.name)) return { ...tool, exposure: "hidden", defaultActive: false };
  // Explicit author restrictions remain authoritative. Do not make model-only or hidden tools callable.
  if (tool.exposure === "hidden" || tool.exposure === "model-only") return tool;
  const definition = { ...tool, exposure: "deferred", defaultActive: false, namespace: toolNamespace(tool, source) };
  if (!tool.outputSchema) {
    definition.outputSchema = resultSchema;
    definition.promptGuidelines = [...(tool.promptGuidelines ?? []), resultGuideline];
    definition.execute = async function (...args) {
      const result = await tool.execute.apply(tool, args);
      return { ...result, structuredContent: {
        content: result.content,
        ...(result.details === undefined ? {} : { details: result.details }),
        ...(result.isError === undefined ? {} : { isError: result.isError }),
      } };
    };
  }
  Object.defineProperty(definition, routed, { value: true });
  return definition;
}

export function declaredTools(names, inventory) {
  if (!routingEnabled()) return names;
  const exposures = new Map(inventory.map(tool => [tool.name, tool.exposure]));
  return names.filter(name => !retiredLoaders.has(name) && !["deferred", "codemode", "hidden"].includes(exposures.get(name)));
}

const policy = "Optional browser, web, ComfyUI, MCP, code-analysis and add-on tools are available through codemode, not missing. Find them with searchTools using English keywords, inspect describeTool/describeNamespace, then call tools.<name>(args). Discover only what this task needs. Core file, shell, goal, plan and notebook tools remain direct. Do not activate optional tool schemas: that can invalidate a local server's prompt cache. Nested calls retain validation, permission checks and cancellation. Media results use {content,details,isError}: show text with text(block.text), images with image(block), never print base64. Music and 3D output remains available in the desktop interface.";

export default function desktopToolRouting(pi) {
  const pendingMedia = new Map();
  const activate = () => {
    const selected = declaredTools(pi.getActiveTools(), pi.getAllTools());
    if (!selected.includes("codemode")) selected.push("codemode");
    pi.setActiveTools(selected);
  };
  pi.on("session_start", activate);
  pi.on("before_agent_start", event => {
    activate();
    return { systemPrompt: `${event.systemPrompt}\n\n${policy}` };
  });
  pi.on("tool_result", event => {
    if (event.parentToolCallId && (event.toolName.startsWith("comfyui_") || event.toolName === "desktop_show_image")) {
      const details = event.details;
      const images = event.content.filter(block => block.type === "image");
      if (!images.length && !details?.media?.length && !details?.audioSelection) return;
      const entries = pendingMedia.get(event.parentToolCallId) ?? [];
      entries.push({ id: event.toolCallId, name: event.toolName, args: event.input, result: {
        content: images, isError: event.isError, details: {
          ...(details?.files ? { files: details.files } : {}),
          ...(details?.media ? { media: details.media } : {}),
          ...(details?.audioSelection === undefined ? {} : { audioSelection: details.audioSelection }),
          ...(details?.displayInAnswer === undefined ? {} : { displayInAnswer: details.displayInAnswer }),
        },
      } });
      pendingMedia.set(event.parentToolCallId, entries);
      return;
    }
    const entries = pendingMedia.get(event.toolCallId);
    if (!entries) return;
    pendingMedia.delete(event.toolCallId);
    return { details: { ...event.details, desktopNestedMedia: entries } };
  });
  pi.on("agent_end", () => pendingMedia.clear());
  pi.on("session_shutdown", () => pendingMedia.clear());
}
